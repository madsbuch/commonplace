// The editor makes its own block ids (UUIDv4); the database keys blocks by
// TypeID (ID-1). The two are the same 128 bits, spelled two ways, so the
// mapping needs no table: a block keeps one identity in both.

import { parseTypeId, typeIdOf } from "../lib/ids";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The editor's id for a stored block. */
export function editorId(dbId: string): string {
  return parseTypeId(dbId)?.uuid ?? dbId;
}

// Spec: ID-1
/** The stored id of an editor block. */
export function dbId(editorBlockId: string): string {
  return UUID.test(editorBlockId) ? typeIdOf("blk", editorBlockId) : editorBlockId;
}
