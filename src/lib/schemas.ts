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

// ---------------------------------------------------------------------------
// Chat transcripts (persisted in `chats.messages`; OpenAI-style messages)
// ---------------------------------------------------------------------------

export const ToolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({ name: z.string(), arguments: z.string() }),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

/** One message of a chat transcript: the author's, the assistant's (maybe calling tools), or a tool's result. */
export const TranscriptMessageSchema = z.discriminatedUnion("role", [
  z.object({
    role: z.literal("user"),
    content: z.string(),
    action: z.string().optional(),
    // Spec: ATL-7
    /** A picture of the screen handed over for a tool, not written by the author. Its image is never stored. */
    attachment: z.literal("screenshot").optional(),
    image: z.string().optional(),
  }),
  z.object({ role: z.literal("assistant"), content: z.string().nullable(), tool_calls: z.array(ToolCallSchema).optional() }),
  z.object({ role: z.literal("tool"), tool_call_id: z.string(), content: z.string() }),
]);
export type TranscriptMessage = z.infer<typeof TranscriptMessageSchema>;

// Spec: CHAT-1
/** A stored transcript; strict, so a corrupt one shows up as null rather than as a wrong chat. */
export function parseTranscript(raw: string): TranscriptMessage[] | null {
  try {
    const r = z.array(TranscriptMessageSchema).safeParse(parseJson(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** A tool call's arguments: an object, or `{}` when the model sent something else. */
export function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const r = z.record(z.string(), z.unknown()).safeParse(parseJson(raw));
    return r.success ? r.data : {};
  } catch {
    return {};
  }
}

const ToolCallDeltaSchema = z.object({
  index: z.number().catch(0),
  id: z.string().optional().catch(undefined),
  function: z.object({ name: z.string().optional().catch(undefined), arguments: z.string().optional().catch(undefined) }).optional().catch(undefined),
});

/** The tool-call pieces in one streamed chunk (forgiving: a malformed piece is dropped). */
export function parseToolCallDeltas(chunk: unknown): z.infer<typeof ToolCallDeltaSchema>[] {
  const r = z
    .object({ choices: z.array(z.object({ delta: z.object({ tool_calls: z.array(ToolCallDeltaSchema).optional() }).optional() })).optional() })
    .safeParse(chunk);
  return r.success ? (r.data.choices?.[0]?.delta?.tool_calls ?? []) : [];
}

// ---------------------------------------------------------------------------
// A library item's table of contents (`library_items.toc`)
// ---------------------------------------------------------------------------

/** One entry: its title, the (1-based) page it starts on if known, and what's under it. */
export interface TocEntry {
  title: string;
  page: number | null;
  /** In an HTML version: the id of the section it heads (LIB-25). */
  anchor?: string;
  children: TocEntry[];
}

const TocEntrySchema: z.ZodType<TocEntry> = z.lazy(() =>
  z.object({ title: z.string(), page: z.number().int().positive().nullable(), anchor: z.string().optional(), children: z.array(TocEntrySchema) }),
);

// Spec: LIB-14
/** A stored table of contents; null when there's none yet, or it can't be read. */
export function parseToc(raw: string | null): TocEntry[] | null {
  if (raw === null) return null;
  try {
    const r = z.array(TocEntrySchema).safeParse(parseJson(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Lean (src-tauri/src/lean/): verdicts as stored (strict) and as the
// computer's Lean service hands them back.
// ---------------------------------------------------------------------------

// Spec: LEAN-3
export const LeanMessageSchema = z.object({
  severity: z.enum(["error", "warning", "information", "hint"]),
  line: z.number().int().nonnegative(),
  column: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
  endColumn: z.number().int().nonnegative(),
  text: z.string(),
});
export type LeanMessage = z.infer<typeof LeanMessageSchema>;

export const LeanDepSchema = z.object({ name: z.string(), hash: z.string() });

export const LeanStatusValueSchema = z.enum(["verified", "sorry", "errors"]);

// Spec: LEAN-5
export const LeanVerdictSchema = z.object({
  status: LeanStatusValueSchema,
  messages: z.array(LeanMessageSchema),
  sourceHash: z.string(),
  deps: z.array(LeanDepSchema),
  leanVersion: z.string(),
  device: z.string(),
  checkedAt: z.string(),
});
export type LeanVerdict = z.infer<typeof LeanVerdictSchema>;

/** A `lean_checks` row as a verdict; null when it can't be read. */
export function parseLeanCheckRow(row: Record<string, unknown>): LeanVerdict | null {
  const r = z
    .object({
      status: z.string(),
      messages: z.string(),
      source_hash: z.string(),
      deps: z.string(),
      lean_version: z.string(),
      device: z.string(),
      checked_at: z.string(),
    })
    .safeParse(row);
  if (!r.success) return null;
  try {
    const v = LeanVerdictSchema.safeParse({
      status: r.data.status,
      messages: parseJson(r.data.messages),
      sourceHash: r.data.source_hash,
      deps: parseJson(r.data.deps),
      leanVersion: r.data.lean_version,
      device: r.data.device,
      checkedAt: r.data.checked_at,
    });
    return v.success ? v.data : null;
  } catch {
    return null;
  }
}

export const LeanServiceStatusSchema = z.object({
  lake: z.string().nullable(),
  ready: z.boolean(),
  toolchain: z.string().nullable(),
  settingUp: z.boolean(),
  workspace: z.string(),
});
export type LeanServiceStatus = z.infer<typeof LeanServiceStatusSchema>;

// Spec: LEAN-4
export const LeanGoalsSchema = z.object({ goals: z.array(z.string()), term: z.string().nullable() }).nullable();
export type LeanGoals = z.infer<typeof LeanGoalsSchema>;

export const LeanSetupEventSchema = z.object({
  line: z.string().optional(),
  done: z.boolean().optional(),
  error: z.string().nullable().optional(),
});

// ---------------------------------------------------------------------------
// The audio library (src/lib/audio.ts): recordings as stored (strict).
// ---------------------------------------------------------------------------

// Spec: AUD-2, AUD-4
export const ScriptSchema = z.object({
  chapters: z.array(z.object({ title: z.string(), paragraphs: z.array(z.string()) })),
});
export type Script = z.infer<typeof ScriptSchema>;

export const RecordingChapterSchema = z.object({ title: z.string(), start: z.number().nonnegative() });
export type RecordingChapter = z.infer<typeof RecordingChapterSchema>;

const RecordingRowSchema = z.object({
  id: z.string(),
  kind: z.enum(["verbatim", "summary"]),
  title: z.string(),
  items: z.string(),
  section: z.string().nullable(),
  minutes: z.number().nullable(),
  voice: z.string(),
  speech_model: z.string(),
  status: z.enum(["writing", "speaking", "ready", "failed"]),
  progress: z.number(),
  error: z.string().nullable(),
  script: z.string().nullable(),
  chapters: z.string().nullable(),
  duration_seconds: z.number().nullable(),
  device: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

/** A `recordings` row, its JSON columns read. */
export function parseRecording(row: unknown) {
  const r = RecordingRowSchema.parse(row);
  const json = <T>(text: string | null, schema: z.ZodType<T>): T | null => {
    if (text === null) return null;
    const p = schema.safeParse(parseJson(text));
    return p.success ? p.data : null;
  };
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    items: json(r.items, z.array(z.string())) ?? [],
    section: r.section,
    minutes: r.minutes,
    voice: r.voice,
    speechModel: r.speech_model,
    status: r.status,
    progress: r.progress,
    error: r.error,
    script: json(r.script, ScriptSchema),
    chapters: json(r.chapters, z.array(RecordingChapterSchema)) ?? [],
    durationSeconds: r.duration_seconds,
    device: r.device,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
export type Recording = ReturnType<typeof parseRecording>;

export const AudioEventSchema = z.object({ id: z.string(), progress: z.number().optional() });
