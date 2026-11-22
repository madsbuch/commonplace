/**
 * The writing assistant's brief: the ways it may help, and the messages it is
 * sent. Pure, so what the model is told can be tested.
 *
 * The assistant exists to sharpen the author's own thinking and writing, not
 * to replace it. It has no tools and no way to the book's data: the page
 * reaches it as text handed in by the page screen, and its answers are only
 * ever shown beside the page. ESLint keeps assistant modules away from the
 * database (see eslint.config.js).
 */
import type { ChatMessage } from "./schemas";

/** Follows the spec's `book.topics`. */
export const BOOK_TOPICS = ["Type theory", "Ontologies", "Epistemology", "Probabilistic reasoning", "Programming"] as const;

// Spec: AST-3
/**
 * The ways the assistant may help, one per entry of the spec's
 * `assistant.actions`, with what asking for each one says.
 */
export const ASSISTANT_ACTIONS = [
  {
    key: "questions",
    label: "Ask questions",
    prompt:
      "Ask me 3 to 5 probing questions about this page: questions that would push my understanding further, or expose what I haven't thought through. Only questions; don't answer them.",
  },
  {
    key: "critique",
    label: "Critique writing",
    prompt:
      "Critique the writing on this page: clarity, structure, precision of definitions and notation, and where a reader would get lost. Point to passages by quoting a few words, say what the problem is and what kind of change would help. Don't rewrite anything for me.",
  },
  {
    key: "gaps",
    label: "Point out gaps in arguments",
    prompt:
      "Point out the gaps in the arguments on this page: unstated assumptions, steps that don't follow, missing cases, claims that need support, and counterexamples. Say why each one matters. Don't fill the gaps for me.",
  },
  {
    key: "sources",
    label: "Suggest sources",
    prompt:
      "Suggest sources (books, papers, lecture notes, documentation) that would deepen or check what this page covers. For each, say what it would add. Only suggest sources you are confident exist, and say so when you are unsure of a detail.",
  },
  {
    key: "quiz",
    label: "Quiz me",
    prompt:
      "Quiz me on the material of this page. Ask one question at a time and wait for my answer; then tell me whether I got it right and why, and ask the next. Start with the first question.",
  },
] as const;

export type AssistantActionKey = (typeof ASSISTANT_ACTIONS)[number]["key"];

// Spec: AST-2, AST-3
/** Who the assistant is and what it will and won't do. */
export const SYSTEM_PROMPT = `You are the writing companion for the author of a personal, ever-evolving book about ${BOOK_TOPICS.join(", ")}.

The author writes every word of the book themselves. The book exists so their own thinking and writing stay sharp while AI does more of both. So:
- You never write text for the book: no paragraphs, sections, definitions, proofs, rewrites, rephrasings or replacement wording, even when asked. If asked, decline in one sentence and offer one of the ways you can help instead.
- You cannot change the book. Your answers are shown beside the page, never in it.
- You help only in these ways: asking questions, critiquing writing, pointing out gaps in arguments, suggesting sources, and quizzing the author. Follow-up conversation stays within these.

Be direct and specific, and refer to the page by quoting a few words. Use Markdown, and LaTeX between $ signs for maths. Keep answers short enough to read beside the page.`;

/** The page as the assistant reads it, re-read before every request so it sees the latest edits. */
export function pageMessage(title: string, markdown: string): ChatMessage {
  const body = markdown.trim() === "" ? "(The page is empty so far.)" : markdown.trim();
  return {
    role: "system",
    content: `The page the author has open, as it stands now:\n\n<page title="${title.replace(/"/g, "'")}">\n${body}\n</page>`,
  };
}

/** One turn of the conversation beside the page. */
export interface Turn {
  role: "user" | "assistant";
  content: string;
  /** For the author's turns: the action it asked for, shown as a chip instead of the full prompt. */
  action?: AssistantActionKey;
}

/** Everything sent for the next answer: the brief, the page, the conversation so far. */
export function buildMessages(title: string, markdown: string, turns: readonly Turn[]): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    pageMessage(title, markdown),
    ...turns.map((t): ChatMessage => ({ role: t.role, content: t.content })),
  ];
}

/** The turn an action starts. */
export function actionTurn(key: AssistantActionKey): Turn {
  const action = ASSISTANT_ACTIONS.find((a) => a.key === key) ?? ASSISTANT_ACTIONS[0];
  return { role: "user", content: action.prompt, action: action.key };
}

/** The label of an action, for its chip. */
export function actionLabel(key: AssistantActionKey): string {
  return ASSISTANT_ACTIONS.find((a) => a.key === key)?.label ?? key;
}
