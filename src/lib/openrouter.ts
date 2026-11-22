/**
 * The app's only way to a model: OpenRouter's chat completions, with the
 * author's own key, through the HTTP plugin (the request leaves from the Rust
 * side, so the WebView's CSP needn't allow it). Book content leaves the
 * device only through here.
 *
 * Every response that reports its cost is logged in the usage ledger under
 * the feature that asked (lib/aiUsage.ts). Adapted from Tally.
 */
import { fetch } from "@tauri-apps/plugin-http";
import { recordAiUsage } from "./aiUsage";
import type { AiFeature } from "./aiCost";
import { fieldsOf } from "./guards";
import { parseChatChunk, parseChatResponse, parseJson, parseModelsResponse } from "./schemas";
import type { ChatMessage, ChatResponse, ORModel } from "./schemas";

export type { ChatMessage, ORModel } from "./schemas";

const BASE = "https://openrouter.ai/api/v1";

/** Headers OpenRouter uses for app attribution. */
const APP_HEADERS = {
  "HTTP-Referer": "https://github.com/madsbuch/my-book",
  "X-Title": "My Book",
};

export class OpenRouterError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "OpenRouterError";
    this.status = status;
  }
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
  /** What the request is for, as the Costs screen groups it. */
  feature: AiFeature;
  /** Called with the whole answer so far, as it streams in. */
  onText?: (text: string) => void;
  signal?: AbortSignal;
}

// HTTP statuses worth retrying: timeout, too-early, rate limit, server/gateway.
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const body: Record<string, unknown> = { model, messages, stream: true, usage: { include: true } };
  // Claude models cache only when asked; the page and the conversation so far
  // are then re-read from the cache on every follow-up.
  if (model.startsWith("anthropic/")) body["cache_control"] = { type: "ephemeral" };

  let lastError: Error = new OpenRouterError("OpenRouter request failed", 0);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    if (opts.signal?.aborted) throw new OpenRouterError("Stopped", 0);
    let res: Response;
    try {
      res = await post(apiKey, body, opts.signal);
    } catch (e) {
      if (opts.signal?.aborted) throw new OpenRouterError("Stopped", 0);
      lastError = e instanceof Error ? e : new Error(String(e));
      continue;
    }
    if (!res.ok) {
      const json = parseChatResponse(await res.json().catch(() => ({})));
      logUsage(opts.feature, model, usageOf(json));
      const err = new OpenRouterError(json.error?.message ?? `HTTP ${res.status}`, res.status);
      if (!RETRYABLE_STATUS.has(res.status)) throw err;
      lastError = err;
      continue;
    }
    const state = await readStream(res, opts.onText);
    // Logged under the model asked for, so the Costs screen groups by the
    // author's choices rather than by provider variants.
    logUsage(opts.feature, model, state.usage);
    if (state.error) throw new OpenRouterError(state.error, res.status);
    if (state.text.trim() === "") {
      lastError = new OpenRouterError("The model returned an empty answer", res.status);
      continue;
    }
    return state.text;
  }
  throw lastError;
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
  opts: { feature: AiFeature; signal?: AbortSignal },
): Promise<unknown> {
  const body: Record<string, unknown> = {
    model,
    messages,
    usage: { include: true },
    response_format: { type: "json_schema", json_schema: { name: format.name, strict: true, schema: format.schema } },
  };
  let lastError: Error = new OpenRouterError("OpenRouter request failed", 0);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    if (opts.signal?.aborted) throw new OpenRouterError("Stopped", 0);
    let res: Response;
    try {
      res = await post(apiKey, body, opts.signal);
    } catch (e) {
      if (opts.signal?.aborted) throw new OpenRouterError("Stopped", 0);
      lastError = e instanceof Error ? e : new Error(String(e));
      continue;
    }
    const json = parseChatResponse(await res.json().catch(() => ({})));
    logUsage(opts.feature, model, usageOf(json));
    if (!res.ok || json.error) {
      const err = new OpenRouterError(json.error?.message ?? `HTTP ${res.status}`, res.status);
      if (res.ok || !RETRYABLE_STATUS.has(res.status)) throw err;
      lastError = err;
      continue;
    }
    // Some models wrap the JSON in a code fence despite the format.
    const text = contentToText(json.choices?.[0]?.message?.content).trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    try {
      return parseJson(text);
    } catch {
      lastError = new OpenRouterError("The model's answer wasn't JSON", res.status);
    }
  }
  throw lastError;
}

/** A human-readable message for any error. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
