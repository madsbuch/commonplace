/**
 * The assistant's brief: who it is, the ways it may help, what it is sent
 * each round, and how a transcript reads on screen. Pure, so what the model
 * is told can be tested; the turns themselves run in lib/assistantRunner.ts.
 *
 * The assistant exists to sharpen the author's own thinking and writing, not
 * to replace it. It reads the book and the library through read-only tools
 * (lib/assistantTools.ts), writes nothing but its memory and its chats, and
 * ESLint keeps assistant modules away from the book's data layer.
 */
import type { TranscriptMessage } from "./schemas";

/** Follows the spec's `book.topics`. */
export const BOOK_TOPICS = ["Type theory", "Ontologies", "Epistemology", "Probabilistic reasoning", "Programming"] as const;

// Spec: AST-3
/**
 * The ways the assistant may help, one per entry of the spec's
 * `assistant.actions` (its wording in `spec`, a button's in `label`). Those
 * with a prompt are offered as buttons; answering
 * questions is what a chat does anyway.
 */
export const ASSISTANT_ACTIONS = [
  {
    key: "questions",
    spec: "Ask questions",
    label: "Ask questions",
    prompt:
      "Ask me 3 to 5 probing questions about what I have open: questions that would push my understanding further, or expose what I haven't thought through. Only questions; don't answer them.",
  },
  {
    key: "critique",
    spec: "Critique writing",
    label: "Critique writing",
    prompt:
      "Critique the writing of the page I have open: clarity, structure, precision of definitions and notation, and where a reader would get lost. Point to passages by quoting a few words, say what the problem is and what kind of change would help. Don't rewrite anything for me.",
  },
  {
    key: "gaps",
    spec: "Point out gaps in arguments",
    label: "Point out gaps in arguments",
    prompt:
      "Point out the gaps in the arguments of what I have open: unstated assumptions, steps that don't follow, missing cases, claims that need support, and counterexamples. Say why each one matters. Don't fill the gaps for me.",
  },
  {
    key: "sources",
    spec: "Suggest sources",
    label: "Suggest sources",
    prompt:
      "Suggest sources (books, papers, lecture notes, documentation) that would deepen or check what I have open. Say first which ones are already in my library. For others, say what each would add, and only suggest ones you are confident exist.",
  },
  {
    key: "quiz",
    spec: "Quiz the author",
    label: "Quiz me",
    prompt:
      "Quiz me on what I have open. Ask one question at a time and wait for my answer; then tell me whether I got it right and why, and ask the next. Start with the first question.",
  },
  {
    key: "answer",
    spec: "Answer questions about the book and the library",
    label: "Answer questions about the book and the library",
    prompt: null,
  },
] as const;

export type AssistantActionKey = (typeof ASSISTANT_ACTIONS)[number]["key"];

/** The actions offered as buttons. */
export const ACTION_BUTTONS = ASSISTANT_ACTIONS.flatMap((a) => (a.prompt === null ? [] : [{ key: a.key, label: a.label, prompt: a.prompt }]));

export function actionLabel(key: string): string | null {
  return ASSISTANT_ACTIONS.find((a) => a.key === key)?.label ?? null;
}

// Spec: AST-2, AST-3, ATL-1, ATL-5, MEM-1, CHAT-7
/** Who the assistant is and what it will and won't do. */
export const SYSTEM_PROMPT = `You are the writing companion for the author of a personal, ever-evolving book about ${BOOK_TOPICS.join(", ")}. They also keep a library of the papers and books they read.

The author writes every word of the book themselves. The book exists so their own thinking and writing stay sharp while AI does more of both. So:
- You never write text for the book: no paragraphs, sections, definitions, proofs, rewrites, rephrasings or replacement wording, even when asked. If asked, decline in one sentence and offer one of the ways you can help instead.
- You cannot change the book or the library: your tools only read them. You can only keep your own memory.
- You help in these ways: asking questions, critiquing writing, pointing out gaps in arguments, suggesting sources, quizzing the author, and answering their questions about what is in the book and the library (a paper's argument, what a page says, who wrote what).

Tools:
- look_at_screen shows what the author is looking at. Use it whenever they say "this", "here", "this page" or "this paper", and before any of the actions above unless they named what they mean.
- Read pages and PDFs rather than guess what they say. When a PDF is long, read the pages that matter (the abstract and introduction first) rather than all of it.
- Keep in your memory, with remember, what the author asks you to remember or tells you about how they want to be helped. Don't store anything else there.

When you mention a page, a block, a library item, a person or an institution, write its id (blk_…, lib_…, person_…, institution_…) on its own: the app shows it as a link with its title, so don't repeat the title next to it.

Be direct and specific; quote a few words to point at a passage. Use Markdown, and LaTeX between $ signs for maths. Keep answers short enough to read beside what the author is working on.`;

/** The system messages for a round: the brief, then the memory as it stands. */
export function systemMessages(memory: string): { role: "system"; content: string }[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "system", content: `Your memory (ids in brackets; change or remove entries with update_memory and forget):\n${memory}` },
  ];
}

/** Tool results this short are kept as they are in older turns. */
export const KEEP_RESULT_CHARS = 600;

/**
 * Shortens what earlier turns already used: long tool results from before
 * the question being answered are cut to a note, since the model can fetch
 * them again. Keeps a long chat cheap. (As in Tally.)
 */
export function compactTranscript(messages: readonly TranscriptMessage[]): TranscriptMessage[] {
  const end = lastUserIndex(messages);
  return messages.map((m, i) => {
    if (m.role === "user" && m.attachment !== undefined && m.image === undefined) return { ...m, content: PICTURE_GONE };
    if (i >= end || m.role !== "tool" || m.content.length <= KEEP_RESULT_CHARS) return m;
    return { ...m, content: `${m.content.slice(0, 200)}…\n(Earlier result, shortened. Call the tool again for all of it.)` };
  });
}

/** A message the author wrote (not a picture of the screen handed over for a tool). */
function authored(m: TranscriptMessage | undefined): boolean {
  return m?.role === "user" && m.attachment === undefined;
}

export function lastUserIndex(messages: readonly TranscriptMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (authored(messages[i])) return i;
  return -1;
}

// Spec: ATL-7
/** The transcript as it's kept: pictures of the screen are dropped, only their place stays. */
export function forStorage(messages: readonly TranscriptMessage[]): TranscriptMessage[] {
  return messages.map((m) => (m.role === "user" && m.image !== undefined ? { role: "user", content: m.content, attachment: "screenshot" } : m));
}

/** What stands in for a picture of the screen that's no longer there. */
export const PICTURE_GONE = "(A picture of the screen was here; pictures aren't kept. Call look_at_screen for a fresh one.)";

/** Whether the last question has no answer yet. */
export function awaitsAnswer(messages: readonly TranscriptMessage[]): boolean {
  const asked = lastUserIndex(messages);
  if (asked < 0) return false;
  return !messages.slice(asked + 1).some((m) => m.role === "assistant" && !m.tool_calls?.length && (m.content ?? "").trim() !== "");
}

// Spec: CHAT-5
/** `chat.answering-elsewhere` in the spec. */
export const ANSWERING_ELSEWHERE_MS = 10 * 60_000;

/** Until when a question another device saved at `hlc` counts as being answered there (0: no longer). */
export function answeringElsewhereUntil(hlc: string): number {
  const ms = /^(\d{13})\.\d{6}$/.exec(hlc)?.[1];
  return ms ? Number(ms) + ANSWERING_ELSEWHERE_MS : 0;
}

/** What the screen shows of a transcript. */
export type UiItem =
  | { kind: "user"; text: string; action: string | null }
  | { kind: "message"; text: string }
  | { kind: "activity"; tools: string[]; notes: string[] };

// Spec: CHAT-6
/**
 * A transcript as the screen shows it: the author's messages, the answers,
 * and between them the tools the assistant used (with what it said while
 * using them), folded into one activity row per stretch.
 */
export function transcriptToUi(messages: readonly TranscriptMessage[], label: (tool: string) => string): UiItem[] {
  const out: UiItem[] = [];
  let activity: { kind: "activity"; tools: string[]; notes: string[] } | null = null;
  const flush = () => {
    if (activity) out.push(activity);
    activity = null;
  };
  for (const m of messages) {
    if (m.role === "user" && m.attachment !== undefined) continue;
    if (m.role === "user") {
      flush();
      out.push({ kind: "user", text: m.content, action: m.action ? actionLabel(m.action) : null });
    } else if (m.role === "assistant") {
      const calls = m.tool_calls ?? [];
      if (calls.length > 0) {
        activity ??= { kind: "activity", tools: [], notes: [] };
        for (const c of calls) {
          const l = label(c.function.name);
          if (!activity.tools.includes(l)) activity.tools.push(l);
        }
        if (m.content && m.content.trim()) activity.notes.push(m.content.trim());
      } else if (m.content && m.content.trim()) {
        flush();
        out.push({ kind: "message", text: m.content });
      }
    }
  }
  flush();
  return out;
}
