// The assistant's memory: what it keeps across chats (MEM-1). The only thing
// outside its chats the assistant writes (MEM-4).

import { z } from "zod";
import { execute, nowIso, select } from "./db";
import { newId } from "./ids";

export const MEMORY_KINDS = ["preference", "focus", "note"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export const MEMORY_KIND_NAMES: Record<MemoryKind, string> = {
  preference: "How I want to be helped",
  focus: "What I'm working on",
  note: "Notes",
};

export function isMemoryKind(x: unknown): x is MemoryKind {
  return MEMORY_KINDS.some((k) => k === x);
}

const MemorySchema = z
  .object({ id: z.string(), kind: z.string(), text: z.string(), created_at: z.string(), updated_at: z.string() })
  .transform((r) => ({ id: r.id, kind: isMemoryKind(r.kind) ? r.kind : "note", text: r.text, createdAt: r.created_at, updatedAt: r.updated_at }));
export type MemoryEntry = z.output<typeof MemorySchema>;

export async function listMemory(): Promise<MemoryEntry[]> {
  return z.array(MemorySchema).parse(await select(`SELECT id, kind, text, created_at, updated_at FROM assistant_memory ORDER BY created_at`));
}

// Spec: MEM-4
export async function addMemory(kind: MemoryKind, text: string): Promise<string> {
  const id = newId("assistant_memory");
  const at = nowIso();
  await execute(`INSERT INTO assistant_memory (id, kind, text, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)`, [id, kind, text.trim(), at]);
  return id;
}

// Spec: MEM-3, MEM-4
export async function updateMemory(id: string, patch: { text?: string; kind?: MemoryKind }): Promise<boolean> {
  const cur = (await listMemory()).find((m) => m.id === id);
  if (!cur) return false;
  await execute(`UPDATE assistant_memory SET kind = $2, text = $3, updated_at = $4 WHERE id = $1`, [
    id,
    patch.kind ?? cur.kind,
    (patch.text ?? cur.text).trim(),
    nowIso(),
  ]);
  return true;
}

// Spec: MEM-3, MEM-4
export async function deleteMemory(id: string): Promise<boolean> {
  const exists = (await select(`SELECT 1 AS one FROM assistant_memory WHERE id = $1`, [id])).length > 0;
  await execute(`DELETE FROM assistant_memory WHERE id = $1`, [id]);
  return exists;
}

/** The memory as the assistant reads it with every turn (MEM-2). */
export function memoryNote(entries: readonly MemoryEntry[]): string {
  if (entries.length === 0) return "Your memory is empty so far.";
  return entries.map((e) => `- [${e.id}] (${e.kind}) ${e.text}`).join("\n");
}
