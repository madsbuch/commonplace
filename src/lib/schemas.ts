/**
 * The single home for parsing untrusted JSON: database columns, model
 * output, external APIs and settings blobs. Every boundary gets a zod schema
 * and a small parse helper, so call sites never touch raw `unknown` or cast
 * with `as`. ESLint bans `JSON.parse` outside this file (see eslint.config.js
 * and CLAUDE.md).
 */
import { z } from "zod";

/**
 * The one sanctioned `JSON.parse`: always feed the result to a schema.
 * (eslint.config.js exempts this file from the ban.)
 */
export function parseJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  return value;
}

// ---------------------------------------------------------------------------
// What commands and the SQL plugin hand back
// ---------------------------------------------------------------------------


const LooseRecordSchema = z.record(z.string(), z.unknown());

/** Rows from tauri-plugin-sql's `select`: objects keyed by column, values still unchecked. */
export function parseSqlRows(raw: unknown): Record<string, unknown>[] {
  return z.array(LooseRecordSchema).parse(raw);
}

/** A command that answers with a string. */
export function parseCommandString(raw: unknown): string {
  return z.string().parse(raw);
}

/** A command that answers with a count. */
export function parseCommandCount(raw: unknown): number {
  return z.number().int().nonnegative().parse(raw);
}

/** A command that answers yes or no. */
export function parseCommandFlag(raw: unknown): boolean {
  return z.boolean().parse(raw);
}

// ---------------------------------------------------------------------------
// OpenRouter (AI): /chat/completions responses, streamed chunks, /models
//
// Schemas for model/API output are forgiving: every field `.catch`es, so one
// malformed part of a response never invalidates the rest of it, and missing
// accounting never fails an answer that otherwise arrived fine.
// ---------------------------------------------------------------------------

export const ChatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});
/** One message of a conversation with a model (text only: the assistant has no tools). */
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

const OpenRouterErrorSchema = z.object({
  message: z.string().optional().catch(undefined),
  code: z.union([z.number(), z.string()]).optional().catch(undefined),
});

/**
 * What a request cost. With usage accounting on, OpenRouter reports it on
 * every response (on the last chunk of a stream); `cost` is what was charged,
 * in USD.
 */
const ChatUsageSchema = z.object({
  prompt_tokens: z.number().optional().catch(undefined),
  completion_tokens: z.number().optional().catch(undefined),
  cost: z.number().optional().catch(undefined),
});

const ChatChoiceSchema = z.object({
  message: z.object({ content: z.unknown().optional() }).optional().catch(undefined),
  delta: z.object({ content: z.unknown().optional() }).optional().catch(undefined),
  finish_reason: z.string().nullable().optional().catch(undefined),
  error: OpenRouterErrorSchema.optional().catch(undefined),
});

const ChatResponseSchema = z.object({
  model: z.string().optional().catch(undefined),
  choices: z.array(ChatChoiceSchema).optional().catch(undefined),
  error: OpenRouterErrorSchema.optional().catch(undefined),
  usage: ChatUsageSchema.optional().catch(undefined),
});
/** A /chat/completions response, or one chunk of a streamed one. */
export type ChatResponse = z.infer<typeof ChatResponseSchema>;

/** Never throws: an unrecognisable body parses as `{}` (treated as an error upstream). */
export function parseChatResponse(raw: unknown): ChatResponse {
  const r = ChatResponseSchema.safeParse(raw);
  return r.success ? r.data : {};
}

/** One `data:` payload of a streamed response; null when it isn't JSON at all. */
export function parseChatChunk(data: string): ChatResponse | null {
  let raw: unknown;
  try {
    raw = parseJson(data);
  } catch {
    return null;
  }
  return parseChatResponse(raw);
}

export const ORModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional().catch(undefined),
  context_length: z.number().optional().catch(undefined),
  created: z.number().optional().catch(undefined),
  pricing: z
    .object({
      prompt: z.string().optional().catch(undefined),
      completion: z.string().optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
  architecture: z
    .object({
      input_modalities: z.array(z.string()).optional().catch(undefined),
      output_modalities: z.array(z.string()).optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
});
/** A model as OpenRouter lists it. */
export type ORModel = z.infer<typeof ORModelSchema>;

/** A model array (the device's cache): keeps valid entries, drops the rest; null = not an array. */
export function parseModelList(raw: unknown): ORModel[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.flatMap((m) => {
    const r = ORModelSchema.safeParse(m);
    return r.success ? [r.data] : [];
  });
}

/** The live /models response envelope; null on an unexpected shape. */
export function parseModelsResponse(raw: unknown): ORModel[] | null {
  const r = z.object({ data: z.unknown() }).safeParse(raw);
  return r.success ? parseModelList(r.data.data) : null;
}

const UsageRowSchema = z.object({
  day: z.string(),
  feature: z.string(),
  model: z.string(),
  requests: z.coerce.number(),
  promptTokens: z.coerce.number(),
  completionTokens: z.coerce.number(),
  costUsd: z.coerce.number(),
});

/** The ledger rolled up per day, feature and model (lib/aiUsage.ts); strict, it's our own data. */
export function parseUsageRows(raw: unknown): z.infer<typeof UsageRowSchema>[] {
  return z.array(UsageRowSchema).parse(raw);
}
