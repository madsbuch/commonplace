/**
 * The app's only way to a model: OpenRouter's chat completions, with the
 * author's own key, through the HTTP plugin (the request leaves from the Rust
 * side, so the WebView's CSP needn't allow it). Book content leaves the
 * device only through here.
 *
 * Every response that reports its cost is logged in the usage ledger under
 * the feature that asked (lib/aiUsage.ts). Adapted from Tally.
 */
import { messageOf, note } from "./diagnostics";
import { fetch } from "@tauri-apps/plugin-http";
import { recordAiUsage } from "./aiUsage";
import type { AiFeature } from "./aiCost";
import { fieldsOf } from "./guards";
import { parseChatChunk, parseChatResponse, parseJson, parseModelsResponse, parseToolCallDeltas } from "./schemas";
import type { ToolCall, TranscriptMessage } from "./schemas";
import type { ChatMessage, ChatResponse, ORModel } from "./schemas";

export type { ChatMessage, ORModel } from "./schemas";

const BASE = "https://openrouter.ai/api/v1";

/** Headers OpenRouter uses for app attribution. */
const APP_HEADERS = {
  "HTTP-Referer": "https://github.com/madsbuch/commonplace",
  "X-Title": "Commonplace",
};

export class OpenRouterError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "OpenRouterError";
    this.status = status;
  }
}

/** What a chat request can be for: every feature but speech, which isn't one. */
export type ChatFeature = Exclude<AiFeature, "speech">;

// Spec: AI-7
/**
 * `ai.most-answer.*` in the spec: the most each feature's answer may run to,
 * in tokens (a reasoning model's thinking counts). Without it OpenRouter
 * holds back enough credit for the model's whole output limit while it
 * answers, and a few requests at once can ask for more than the account
 * holds (402).
 */
export const MOST_ANSWER: Record<ChatFeature, number> = {
  assistant: 16_000,
  library_details: 4_000,
  audio_script: 16_000,
  connection_test: 2_000,
};

/** The error for an answer cut off at its most. */
function cutOff(feature: ChatFeature, status: number): OpenRouterError {
  return new OpenRouterError(`The answer reached the most it may run to (${MOST_ANSWER[feature].toLocaleString("en")} tokens) before it was done.`, status);
}

// Spec: AI-2
/** The live model list (no key needed). */
export async function fetchModels(): Promise<ORModel[]> {
  const res = await fetch(`${BASE}/models`, { method: "GET", headers: { ...APP_HEADERS } });
  if (!res.ok) throw new OpenRouterError(`Model list request failed (HTTP ${res.status})`, res.status);
  const models = parseModelsResponse(await res.json());
  if (models === null) throw new OpenRouterError("Unexpected model list from OpenRouter", res.status);
  return models;
}

/** Models that answer in text, which is all the assistant needs. */
export function isTextModel(m: ORModel): boolean {
  return m.architecture?.output_modalities?.includes("text") ?? true;
}

/** $ per million prompt tokens; null when unknown (OpenRouter's "-1" means variable). */
export function promptPricePerMillion(m: ORModel): number | null {
  const p = m.pricing?.prompt;
  if (p == null) return null;
  const perToken = parseFloat(p);
  if (!isFinite(perToken) || perToken < 0) return null;
  return perToken * 1_000_000;
}

/** What one response cost, as OpenRouter reported it. */
export interface Usage {
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

/** The usage a response (or a stream's last chunk) reports; null when it reports none. */
export function usageOf(json: ChatResponse): Usage | null {
  const u = json.usage;
  if (!u || u.cost == null) return null;
  return { promptTokens: u.prompt_tokens ?? 0, completionTokens: u.completion_tokens ?? 0, costUsd: u.cost };
}

/** Some providers send content as an array of parts; flatten it to text. */
export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p: unknown) => {
        const text = fieldsOf(p)?.["text"];
        return typeof text === "string" ? text : "";
      })
      .join("");
  }
  return "";
}

// ---------------------------------------------------------------------------
// Streaming: server-sent events, folded into one answer
// ---------------------------------------------------------------------------

/**
 * Cuts the `data:` payloads of complete events out of `buffer`; `rest` is the
 * start of an event still arriving. Comment lines (": OPENROUTER PROCESSING")
 * are dropped, and so is the closing `[DONE]`.
 */
export function splitSse(buffer: string): { data: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n?/g, "\n");
  const parts = normalized.split("\n\n");
  const rest = parts.pop() ?? "";
  const data: string[] = [];
  for (const event of parts) {
    const lines = event
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""));
    if (lines.length === 0) continue;
    const payload = lines.join("\n");
    if (payload.trim() === "[DONE]") continue;
    data.push(payload);
  }
  return { data, rest };
}

/** A streamed answer so far. */
export interface StreamState {
  text: string;
  model: string | null;
  usage: Usage | null;
  error: string | null;
  finishReason: string | null;
}

export function emptyStreamState(): StreamState {
  return { text: "", model: null, usage: null, error: null, finishReason: null };
}

/** One chunk folded into the answer so far. */
export function foldChunk(state: StreamState, chunk: ChatResponse): StreamState {
  const choice = chunk.choices?.[0];
  const delta = contentToText(choice?.delta?.content ?? choice?.message?.content);
  const error = chunk.error?.message ?? choice?.error?.message ?? (choice?.finish_reason === "error" ? "The model returned an error" : null);
  return {
    text: state.text + delta,
    model: chunk.model ?? state.model,
    usage: usageOf(chunk) ?? state.usage,
    error: error ?? state.error,
    finishReason: choice?.finish_reason ?? state.finishReason,
  };
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface ChatOptions {
  /** What the request is for, as the Costs screen groups it; it sets the most the answer may run to. */
  feature: ChatFeature;
  /** Called with the whole answer so far, as it streams in. */
  onText?: (text: string) => void;
  signal?: AbortSignal;
}

// HTTP statuses worth retrying: timeout, too-early, rate limit, server/gateway.
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
// Spec: WORK-4
/**
 * Waits before each try again when the network or the service fails (no
 * connection, a dropped one, a retryable status): three minutes in all,
 * `work.network-patience`. An answer that came back unusable (empty, not
 * JSON) is tried twice more.
 */
const NETWORK_WAITS_MS = [2_000, 5_000, 10_000, 20_000, 30_000, 45_000, 68_000];
const UNUSABLE_WAITS_MS = [1_000, 2_000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Counts a request's failures; says whether to try again, having waited. */
function retrier(feature: AiFeature, model: string, signal: AbortSignal | undefined) {
  const tries = { network: 0, unusable: 0 };
  return async (kind: "network" | "unusable", error: Error): Promise<boolean> => {
    const wait = (kind === "network" ? NETWORK_WAITS_MS : UNUSABLE_WAITS_MS)[tries[kind]++];
    if (wait === undefined || signal?.aborted) return false;
    // Spec: DIAG-1
    note("warning", "ai", `A ${feature} request to ${model} failed; trying again in ${wait / 1000} s: ${error.message}`);
    await sleep(wait);
    return !signal?.aborted;
  };
}

/** A request that never reached OpenRouter, or whose answer never arrived. */
function unreachable(e: unknown): OpenRouterError {
  return new OpenRouterError(`Couldn't reach OpenRouter: ${messageOf(e)}`, 0);
}

// Spec: AI-3
/** Logs what a response cost. Never fails the request. */
function logUsage(feature: AiFeature, model: string, usage: Usage | null): void {
  if (!usage) return;
  void recordAiUsage({ feature, model, ...usage }).catch((e: unknown) => console.warn("Could not log AI spend", e));
}

async function post(apiKey: string, body: Record<string, unknown>, signal: AbortSignal | undefined) {
  return fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...APP_HEADERS },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

/** Reads a streamed response to the end, telling `onText` as it grows. */
async function readStream(res: Response, onText: ((text: string) => void) | undefined): Promise<StreamState> {
  let state = emptyStreamState();
  const take = (data: string[]) => {
    for (const d of data) {
      const chunk = parseChatChunk(d);
      if (chunk) state = foldChunk(state, chunk);
    }
    onText?.(state.text);
  };
  if (!res.body) {
    const { data } = splitSse(`${await res.text()}\n\n`);
    take(data);
    return state;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { data, rest } = splitSse(buffer);
    buffer = rest;
    if (data.length > 0) take(data);
  }
  take(splitSse(`${buffer}${decoder.decode()}\n\n`).data);
  return state;
}

// Spec: AI-1, AI-6
/**
 * One chat completion, streamed: returns the whole answer, and tells
 * `onText` as it arrives. Retries network failures and retryable statuses
 * before anything has streamed; an abort is never retried.
 */
export async function chat(apiKey: string, model: string, messages: ChatMessage[], opts: ChatOptions): Promise<string> {
  // Spec: AI-7
  const body: Record<string, unknown> = { model, messages, stream: true, usage: { include: true }, max_tokens: MOST_ANSWER[opts.feature] };
  // Claude models cache only when asked; the page and the conversation so far
  // are then re-read from the cache on every follow-up.
  if (model.startsWith("anthropic/")) body["cache_control"] = { type: "ephemeral" };

  const again = retrier(opts.feature, model, opts.signal);
  for (;;) {
    if (opts.signal?.aborted) throw new OpenRouterError("Stopped", 0);
    let res: Response;
    try {
      res = await post(apiKey, body, opts.signal);
    } catch (e) {
      if (opts.signal?.aborted) throw new OpenRouterError("Stopped", 0);
      const err = unreachable(e);
      if (await again("network", err)) continue;
      throw err;
    }
    if (!res.ok) {
      const json = parseChatResponse(await res.json().catch(() => ({})));
      logUsage(opts.feature, model, usageOf(json));
      const err = new OpenRouterError(json.error?.message ?? `HTTP ${res.status}`, res.status);
      if (!RETRYABLE_STATUS.has(res.status)) throw err;
      if (await again("network", err)) continue;
      throw err;
    }
    const state = await readStream(res, opts.onText);
    // Logged under the model asked for, so the Costs screen groups by the
    // author's choices rather than by provider variants.
    logUsage(opts.feature, model, state.usage);
    if (state.error) throw new OpenRouterError(state.error, res.status);
    // Spec: AI-7
    if (state.finishReason === "length") throw cutOff(opts.feature, res.status);
    if (state.text.trim() === "") {
      const err = new OpenRouterError("The model returned an empty answer", res.status);
      if (await again("unusable", err)) continue;
      throw err;
    }
    return state.text;
  }
}

// ---------------------------------------------------------------------------
// Rounds with tools (chats): streamed text, and tool calls assembled from
// their streamed pieces.
// ---------------------------------------------------------------------------

/** A tool the model may call: its name, what it's for, and its arguments' JSON Schema. */
export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** What one round produced: text, and the tools the model wants called (none: it has answered). */
export interface Round {
  text: string;
  toolCalls: ToolCall[];
}

/** Folds the tool-call pieces of a streamed chunk into the calls so far. */
export function foldToolCalls(calls: ToolCall[], raw: unknown): ToolCall[] {
  const out = [...calls];
  for (const d of parseToolCallDeltas(raw)) {
    const cur = out[d.index] ?? { id: "", type: "function" as const, function: { name: "", arguments: "" } };
    out[d.index] = {
      id: d.id ?? cur.id,
      type: "function",
      function: {
        name: cur.function.name + (d.function?.name ?? ""),
        arguments: cur.function.arguments + (d.function?.arguments ?? ""),
      },
    };
  }
  return out;
}

// Spec: AI-1, AI-3, AI-6
/**
 * One round of a chat with tools, streamed: `onText` hears the answer as it
 * grows. Retries like `chat` before anything has streamed.
 */
export async function chatRound(
  apiKey: string,
  model: string,
  messages: readonly (TranscriptMessage | { role: "system"; content: string })[],
  tools: readonly ToolDef[],
  opts: ChatOptions,
): Promise<Round> {
  const body: Record<string, unknown> = {
    model,
    // The author's action names are for the screen, not the model.
    messages: messages.map((m) => {
      if (m.role !== "user") return m;
      // Spec: ATL-7
      if (m.image) return { role: "user", content: [{ type: "text", text: m.content }, { type: "image_url", image_url: { url: m.image } }] };
      return { role: "user", content: m.content };
    }),
    stream: true,
    usage: { include: true },
    // Spec: AI-7
    max_tokens: MOST_ANSWER[opts.feature],
    ...(tools.length > 0
      ? { tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })) }
      : {}),
  };
  if (model.startsWith("anthropic/")) body["cache_control"] = { type: "ephemeral" };

  const again = retrier(opts.feature, model, opts.signal);
  for (;;) {
    if (opts.signal?.aborted) throw new OpenRouterError("Stopped", 0);
    let res: Response;
    try {
      res = await post(apiKey, body, opts.signal);
    } catch (e) {
      if (opts.signal?.aborted) throw new OpenRouterError("Stopped", 0);
      const err = unreachable(e);
      if (await again("network", err)) continue;
      throw err;
    }
    if (!res.ok) {
      const json = parseChatResponse(await res.json().catch(() => ({})));
      logUsage(opts.feature, model, usageOf(json));
      const err = new OpenRouterError(json.error?.message ?? `HTTP ${res.status}`, res.status);
      if (!RETRYABLE_STATUS.has(res.status)) throw err;
      if (await again("network", err)) continue;
      throw err;
    }
    let state = emptyStreamState();
    let calls: ToolCall[] = [];
    const take = (data: string[]) => {
      for (const d of data) {
        let raw: unknown;
        try {
          raw = parseJson(d);
        } catch {
          continue;
        }
        calls = foldToolCalls(calls, raw);
        const chunk = parseChatChunk(d);
        if (chunk) state = foldChunk(state, chunk);
      }
      opts.onText?.(state.text);
    };
    if (res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { data, rest } = splitSse(buffer);
        buffer = rest;
        if (data.length > 0) take(data);
      }
      take(splitSse(`${buffer}${decoder.decode()}\n\n`).data);
    } else {
      take(splitSse(`${await res.text()}\n\n`).data);
    }
    logUsage(opts.feature, model, state.usage);
    if (state.error) throw new OpenRouterError(state.error, res.status);
    const toolCalls = calls.filter((c) => c.function.name !== "").map((c, i) => ({ ...c, id: c.id || `call_${i}` }));
    // Spec: AI-7
    // Cut off: a tool call's arguments may be cut too, so that fails; text says where it stops.
    if (state.finishReason === "length") {
      if (toolCalls.length > 0 || state.text.trim() === "") throw cutOff(opts.feature, res.status);
      note("warning", "ai", `A ${opts.feature} answer from ${model} reached the most it may run to and was cut off.`);
      return { text: `${state.text}\n\n*(Cut off: the answer reached the most it may run to, ${MOST_ANSWER[opts.feature].toLocaleString("en")} tokens.)*`, toolCalls: [] };
    }
    if (state.text.trim() === "" && toolCalls.length === 0) {
      const err = new OpenRouterError("The model returned an empty answer", res.status);
      if (await again("unusable", err)) continue;
      throw err;
    }
    return { text: state.text, toolCalls };
  }
}

/** Part of a message to a model: text, or an image (a data URL). */
export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

/** A message whose content may mix text and images. */
export interface RichMessage {
  role: "system" | "user";
  content: string | ContentPart[];
}

export interface JsonSchemaFormat {
  /** A name for the schema, as OpenRouter's structured outputs want one. */
  name: string;
  /** A JSON Schema the answer must follow (strict: every property required, no others). */
  schema: Record<string, unknown>;
}

// Spec: AI-1, AI-3
/**
 * One completion whose answer is JSON following `format` (structured
 * outputs), not streamed. Returns the parsed JSON, still unchecked: parse it
 * with a schema. Retries like `chat`.
 */
export async function chatJson(
  apiKey: string,
  model: string,
  messages: RichMessage[],
  format: JsonSchemaFormat,
  opts: { feature: ChatFeature; signal?: AbortSignal },
): Promise<unknown> {
  const body: Record<string, unknown> = {
    model,
    messages,
    usage: { include: true },
    // Spec: AI-7
    max_tokens: MOST_ANSWER[opts.feature],
    response_format: { type: "json_schema", json_schema: { name: format.name, strict: true, schema: format.schema } },
  };
  const again = retrier(opts.feature, model, opts.signal);
  for (;;) {
    if (opts.signal?.aborted) throw new OpenRouterError("Stopped", 0);
    let res: Response;
    try {
      res = await post(apiKey, body, opts.signal);
    } catch (e) {
      if (opts.signal?.aborted) throw new OpenRouterError("Stopped", 0);
      const err = unreachable(e);
      if (await again("network", err)) continue;
      throw err;
    }
    const json = parseChatResponse(await res.json().catch(() => ({})));
    logUsage(opts.feature, model, usageOf(json));
    if (!res.ok || json.error) {
      const err = new OpenRouterError(json.error?.message ?? `HTTP ${res.status}`, res.status);
      if (res.ok || !RETRYABLE_STATUS.has(res.status)) throw err;
      if (await again("network", err)) continue;
      throw err;
    }
    // Spec: AI-7
    if (json.choices?.[0]?.finish_reason === "length") throw cutOff(opts.feature, res.status);
    // Some models wrap the JSON in a code fence despite the format.
    const text = contentToText(json.choices?.[0]?.message?.content).trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    try {
      return parseJson(text);
    } catch {
      const err = new OpenRouterError("The model's answer wasn't JSON", res.status);
      if (await again("unusable", err)) continue;
      throw err;
    }
  }
}

/** A human-readable message for any error. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
