// ---------------------------------------------------------------------------
// Row ids are TypeIDs (https://github.com/jetify-com/typeid): a prefix naming
// what the row is, then a UUID spelled in 26 characters of Crockford base32:
// `blk_01jd4x8m2kf7r9q3vz5w6t0hyc`. The UUID underneath is v7, which leads
// with the millisecond timestamp, so within a table ids sort by creation time
// as text. The same encoding is used by Tally (github.com/madsbuch/tally).
// tests/ids.test.ts pins it to the TypeID specification's examples.
// ---------------------------------------------------------------------------

// Spec: ID-1, ID-3
/**
 * Every table keyed by a row id, and the prefix its ids carry. A prefix never
 * changes once rows exist: it's part of every id and every link.
 */
export const ID_PREFIXES = {
  blocks: "blk",
  revisions: "rev",
  ai_usage: "ai_usage",
  library_items: "lib",
  people: "person",
  institutions: "institution",
  authorships: "authorship",
  affiliations: "affiliation",
  chats: "chat",
  assistant_memory: "memory",
} as const;

export type IdTable = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[IdTable];

const PREFIX_LIST: readonly IdPrefix[] = Object.values(ID_PREFIXES);

export function isIdPrefix(x: unknown): x is IdPrefix {
  return PREFIX_LIST.some((p) => p === x);
}

/** Crockford's base32, lower case, as TypeID spells it. */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SUFFIX = /^[0-7][0-9a-hjkmnp-tv-z]{25}$/;

/** 16 bytes as TypeID's 26-character suffix (two zero bits, then all 128). */
function encodeSuffix(b: Uint8Array): string {
  let n = 0n;
  for (const byte of b) n = (n << 8n) | BigInt(byte);
  let s = "";
  for (let i = 0; i < 26; i++) {
    s = (ALPHABET[Number(n & 31n)] ?? "0") + s;
    n >>= 5n;
  }
  return s;
}

function decodeSuffix(s: string): string {
  let n = 0n;
  for (const c of s) n = (n << 5n) | BigInt(ALPHABET.indexOf(c));
  const h = n.toString(16).padStart(32, "0");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function uuidBytes(uuid: string): Uint8Array {
  const h = uuid.replace(/-/g, "");
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return b;
}

/** The TypeID of `uuid` under `prefix` — the same 128 bits, re-spelled. */
export function typeIdOf(prefix: IdPrefix, uuid: string): string {
  return `${prefix}_${encodeSuffix(uuidBytes(uuid.toLowerCase()))}`;
}

/** A TypeID taken apart, or null when `raw` isn't one of ours. */
export function parseTypeId(raw: string): { prefix: IdPrefix; uuid: string } | null {
  const cut = raw.lastIndexOf("_");
  if (cut <= 0) return null;
  const prefix = raw.slice(0, cut);
  const suffix = raw.slice(cut + 1);
  if (!isIdPrefix(prefix) || !SUFFIX.test(suffix)) return null;
  return { prefix, uuid: decodeSuffix(suffix) };
}

/** The prefix of an id of ours, or null. */
export function prefixOf(raw: string): IdPrefix | null {
  return parseTypeId(raw)?.prefix ?? null;
}

let lastMs = -1;
let lastSeq = 0;

/** A fresh id for a row of `table`: UUIDv7 inside, monotonic within this process. */
export function newId(table: IdTable, now: number = Date.now()): string {
  let ms = Math.max(now, lastMs);
  let seq: number;
  if (ms === lastMs) {
    seq = lastSeq + 1;
    if (seq > 0xfff) {
      ms += 1;
      seq = 0;
    }
  } else {
    // Start low in the counter's range, leaving room to count up.
    seq = Math.floor(Math.random() * 0x800);
  }
  lastMs = ms;
  lastSeq = seq;

  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let t = ms;
  for (let i = 5; i >= 0; i--) {
    b[i] = t % 256;
    t = Math.floor(t / 256);
  }
  b[6] = 0x70 | (seq >> 8);
  b[7] = seq & 0xff;
  b[8] = 0x80 | ((b[8] ?? 0) & 0x3f);
  return `${ID_PREFIXES[table]}_${encodeSuffix(b)}`;
}

/**
 * An id derived from a stable external key — a an imported record's own id — so two devices importing the same record arrive at
 * the same row instead of two copies of it. A UUIDv8 (custom) from the SHA-256
 * of the table and the key.
 */
export async function derivedId(table: IdTable, key: string): Promise<string> {
  const data = new TextEncoder().encode(`${table}:${key}`);
  const b = new Uint8Array(await crypto.subtle.digest("SHA-256", data)).slice(0, 16);
  b[6] = 0x80 | ((b[6] ?? 0) & 0x0f);
  b[8] = 0x80 | ((b[8] ?? 0) & 0x3f);
  return `${ID_PREFIXES[table]}_${encodeSuffix(b)}`;
}

/**
 * A `prefix` id taken from a URL segment, or null if it isn't one.
 */
export function parseRowId(raw: string | undefined | null, prefix: IdPrefix): string | null {
  if (!raw) return null;
  if (UUID.test(raw)) return typeIdOf(prefix, raw);
  return parseTypeId(raw)?.prefix === prefix ? raw : null;
}
