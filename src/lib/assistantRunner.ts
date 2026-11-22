/**
 * The open chat, driven outside React (CHAT-4): one module-level state
 * machine that owns the transcript, keeps going while no screen shows it,
 * saves after every round, and can retry a turn that failed. Screens only
 * subscribe and render. As in Tally.
 *
 * It holds whichever chat was last opened or started: the one the assistant
 * beside every screen shows (CHAT-3), remembered per device.
 */
import { useSyncExternalStore } from "react";
import {
  ANSWERING_ELSEWHERE_MS,
  answeringElsewhereUntil,
  awaitsAnswer,
  compactTranscript,
  systemMessages,
  actionLabel,
} from "./assistant";
import { getApiKey, getAssistantModel } from "./aiSettings";
import { TOOLS, runTool, toolLabel } from "./assistantTools";
import { chatVersion, createChat, deleteChat, getChat, lastChatId, rememberLastChat, saveChat, titleFrom } from "./chats";
import { onTablesChanged } from "./live";
import { listMemory, memoryNote } from "./memory";
import { chatRound, errorMessage } from "./openrouter";
import { parseToolArgs, type TranscriptMessage } from "./schemas";

/** Rounds of tool use one turn may take before it must answer. */
const MAX_ROUNDS = 16;

export type RunStatus = "idle" | "running" | "error" | "elsewhere" | "no-key";

export interface AssistantState {
  chatId: string | null;
  title: string;
  messages: TranscriptMessage[];
  status: RunStatus;
  /** The answer so far, while it streams. */
  streaming: string;
  /** The tools used so far in the running turn. */
  activeTools: string[];
  error: string | null;
}

let state: AssistantState = { chatId: null, title: "", messages: [], status: "idle", streaming: "", activeTools: [], error: null };
const listeners = new Set<() => void>();
let controller: AbortController | null = null;
let elsewhereTimer: ReturnType<typeof setTimeout> | null = null;

function set(patch: Partial<AssistantState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function subscribeAssistant(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getAssistantState(): AssistantState {
  return state;
}

export function useAssistant(): AssistantState {
  return useSyncExternalStore(subscribeAssistant, getAssistantState);
}

// Spec: CHAT-5
/** Whether another device saved this chat's open question recently enough to be answering it now. */
async function answeredElsewhere(chatId: string, messages: readonly TranscriptMessage[]): Promise<number> {
  if (!awaitsAnswer(messages)) return 0;
  const v = await chatVersion(chatId);
  if (!v || v.byThisDevice) return 0;
  const until = answeringElsewhereUntil(v.hlc);
  return until > Date.now() ? until : 0;
}

/** Shows `chatId`'s transcript as stored, and whether its last question waits for an answer. */
async function load(chatId: string): Promise<void> {
  const chat = await getChat(chatId);
  if (!chat) {
    if (state.chatId === chatId) set({ chatId: null, title: "", messages: [], status: "idle", error: null });
    return;
  }
  if (state.chatId !== chatId) return;
  if (state.status === "running") return;
  const until = await answeredElsewhere(chatId, chat.messages);
  if (elsewhereTimer) clearTimeout(elsewhereTimer);
  elsewhereTimer = null;
  if (until > 0) {
    // Re-check when the other device's time is up.
    elsewhereTimer = setTimeout(() => void load(chatId), Math.min(until - Date.now() + 500, ANSWERING_ELSEWHERE_MS));
  }
  const unanswered = until === 0 && awaitsAnswer(chat.messages);
  set({
    title: chat.summary.title,
    messages: chat.messages,
    status: until > 0 ? "elsewhere" : unanswered ? "error" : "idle",
    // A turn that failed here keeps its own reason; one found unanswered says so.
    error: unanswered ? (state.status === "error" && state.error ? state.error : "This question wasn't answered.") : null,
    streaming: "",
    activeTools: [],
  });
}

// Spec: CHAT-1, CHAT-3
/** Makes `chatId` the open chat (the one the assistant beside every screen shows). */
export async function openChat(chatId: string): Promise<void> {
  if (state.chatId === chatId) return;
  if (state.status === "running") controller?.abort();
  set({ chatId, title: "", messages: [], status: "idle", streaming: "", activeTools: [], error: null });
  void rememberLastChat(chatId);
  await load(chatId);
}

/** Opens the chat last open on this device, if there is one. */
export async function openLastChat(): Promise<void> {
  if (state.chatId) return;
  const last = await lastChatId();
  if (last && (await getChat(last))) await openChat(last);
}

/** Starts a new chat and opens it; returns its id. */
export async function newChat(): Promise<string> {
  const id = await createChat();
  await openChat(id);
  return id;
}

export async function removeChat(chatId: string): Promise<void> {
  if (state.chatId === chatId) {
    controller?.abort();
    set({ chatId: null, title: "", messages: [], status: "idle", streaming: "", activeTools: [], error: null });
  }
  await deleteChat(chatId);
}

async function persist(chatId: string, messages: TranscriptMessage[]): Promise<void> {
  const title = titleFrom(messages, actionLabel);
  await saveChat(chatId, title, messages);
  if (state.chatId === chatId) set({ title });
}

// Spec: CHAT-4, ATL-5, MEM-2
/** Runs the open chat's turn until the assistant answers, saving after every round. */
async function runTurn(): Promise<void> {
  const chatId = state.chatId;
  if (!chatId) return;
  const key = await getApiKey();
  if (!key) {
    set({ status: "no-key", error: null });
    return;
  }
  const model = await getAssistantModel();
  controller = new AbortController();
  const signal = controller.signal;
  let messages = [...state.messages];
  set({ status: "running", streaming: "", activeTools: [], error: null });
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const memory = memoryNote(await listMemory());
      const result = await chatRound(key, model, [...systemMessages(memory), ...compactTranscript(messages)], round === MAX_ROUNDS - 1 ? [] : TOOLS, {
        feature: "assistant",
        signal,
        onText: (text) => {
          if (state.chatId === chatId) set({ streaming: text });
        },
      });
      if (result.toolCalls.length === 0) {
        messages = [...messages, { role: "assistant", content: result.text }];
        await persist(chatId, messages);
        if (state.chatId === chatId) set({ messages, status: "idle", streaming: "", activeTools: [] });
        return;
      }
      messages = [...messages, { role: "assistant", content: result.text.trim() || null, tool_calls: result.toolCalls }];
      for (const call of result.toolCalls) {
        if (state.chatId === chatId) set({ activeTools: [...new Set([...state.activeTools, toolLabel(call.function.name)])], streaming: "" });
        const content = await runTool(call.function.name, parseToolArgs(call.function.arguments));
        messages = [...messages, { role: "tool", tool_call_id: call.id, content }];
      }
      await persist(chatId, messages);
      if (state.chatId === chatId) set({ messages });
      if (signal.aborted) throw new Error("Stopped");
    }
  } catch (e) {
    await persist(chatId, messages).catch(() => undefined);
    if (state.chatId === chatId) {
      set({ messages, status: "error", streaming: "", activeTools: [], error: signal.aborted ? "Stopped." : errorMessage(e) });
    }
  } finally {
    controller = null;
  }
}

/** Sends the author's message (or an action) in the open chat, starting one if none is open. */
export async function send(text: string, action?: string): Promise<void> {
  if (state.status === "running" || state.status === "elsewhere") return;
  const chatId = state.chatId ?? (await newChat());
  const message: TranscriptMessage = action ? { role: "user", content: text, action } : { role: "user", content: text };
  const messages = [...state.messages, message];
  set({ messages });
  await persist(chatId, messages);
  await runTurn();
}

// Spec: CHAT-4
/** Runs the unanswered question again. */
export async function retry(): Promise<void> {
  if (state.status === "running" || !awaitsAnswer(state.messages)) return;
  await runTurn();
}

export function stop(): void {
  controller?.abort();
}

// Another device's rounds arrive through sync: show them when not running here.
onTablesChanged(["chats"], () => {
  if (state.chatId && state.status !== "running") void load(state.chatId);
});
