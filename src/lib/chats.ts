// Chats with the assistant (CHAT-1): one row each, the transcript as JSON,
// rewritten after every round. They sync; a chat continued on two devices at
// once is split by sync, so no turn is lost (SYN-20).

import { z } from "zod";
import { execute, getSetting, nowIso, select, setSetting } from "./db";
import { SETTING_KEYS } from "./settings";
import { newId } from "./ids";
import { parseTranscript, type TranscriptMessage } from "./schemas";

export interface ChatSummary {
  id: string;
  title: string;
  updatedAt: string;
}

const SummarySchema = z
  .object({ id: z.string(), title: z.string(), updated_at: z.string() })
  .transform((r): ChatSummary => ({ id: r.id, title: r.title, updatedAt: r.updated_at }));

export const CHAT_TABLES = ["chats"] as const;
export const NEW_CHAT_TITLE = "New chat";

export async function listChats(): Promise<ChatSummary[]> {
  return z.array(SummarySchema).parse(await select(`SELECT id, title, updated_at FROM chats ORDER BY updated_at DESC`));
}

export async function getChat(id: string): Promise<{ summary: ChatSummary; messages: TranscriptMessage[] } | null> {
  const rows = z
    .array(z.object({ id: z.string(), title: z.string(), updated_at: z.string(), messages: z.string() }))
    .parse(await select(`SELECT id, title, updated_at, messages FROM chats WHERE id = $1`, [id]));
  const r = rows[0];
  if (!r) return null;
  return { summary: { id: r.id, title: r.title, updatedAt: r.updated_at }, messages: parseTranscript(r.messages) ?? [] };
}

export async function createChat(): Promise<string> {
  const id = newId("chats");
  const at = nowIso();
  await execute(`INSERT INTO chats (id, title, messages, created_at, updated_at) VALUES ($1, $2, '[]', $3, $3)`, [id, NEW_CHAT_TITLE, at]);
  return id;
}

/** A chat's title from its first question: its first line, shortened. */
export function titleFrom(messages: readonly TranscriptMessage[], actionLabel: (key: string) => string | null): string {
  const first = messages.find((m) => m.role === "user");
  if (!first || first.role !== "user") return NEW_CHAT_TITLE;
  const label = first.action ? actionLabel(first.action) : null;
  const line = (label ?? first.content).split("\n")[0]?.trim() ?? "";
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line || NEW_CHAT_TITLE;
}

export async function saveChat(id: string, title: string, messages: readonly TranscriptMessage[]): Promise<void> {
  await execute(`UPDATE chats SET title = $2, messages = $3, updated_at = $4 WHERE id = $1`, [id, title, JSON.stringify(messages), nowIso()]);
}

export async function deleteChat(id: string): Promise<void> {
  await execute(`DELETE FROM chats WHERE id = $1`, [id]);
}

// Spec: CHAT-5
/** Who last wrote a chat, and when (from sync's bookkeeping); null before sync has set up. */
export async function chatVersion(id: string): Promise<{ hlc: string; byThisDevice: boolean } | null> {
  try {
    const rows = z
      .array(z.object({ hlc: z.string(), mine: z.number() }))
      .parse(
        await select(
          `SELECT r.hlc AS hlc, (r.origin = s.device_id) AS mine FROM sync_rows r, sync_state s WHERE s.id = 1 AND r.tbl = 'chats' AND r.pk = $1`,
          [id],
        ),
      );
    const r = rows[0];
    return r ? { hlc: r.hlc, byThisDevice: r.mine === 1 } : null;
  } catch {
    return null;
  }
}

/** The chat last open on this device (CHAT-3). */
export async function lastChatId(): Promise<string | null> {
  return getSetting(SETTING_KEYS.lastChat);
}

export async function rememberLastChat(id: string): Promise<void> {
  await setSetting(SETTING_KEYS.lastChat, id);
}
