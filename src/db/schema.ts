import { blob, index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { newId } from "../lib/ids";
import type { IdTable } from "../lib/ids";

// Spec: ID-1, ID-2
/**
 * Every entity row's key: a TypeID made on the device that wrote it, the
 * table's prefix and a UUIDv7 (`blk_01jd4x…`), so rows from different devices
 * never collide. A new table needs its prefix in `ID_PREFIXES` (lib/ids.ts);
 * tables without one use a natural key. No table uses an auto-increment key.
 *
 * No table has foreign keys: sync applies rows one at a time, in any order,
 * so a block can arrive before the page it belongs to.
 */
const rowId = (table: IdTable) => text("id").primaryKey().$defaultFn(() => newId(table));

/** Preferences that belong to the author and sync to every device of the book. */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/** State that belongs to this device and never leaves it (caches, sync bookmarks). */
export const deviceSettings = sqliteTable("device_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// Spec: BOOK-10, BOOK-11, BLK-1, BLK-2, PAGE-1, PAGE-3
/**
 * The book: one row per block. A page is a block of type `page`; its content
 * is the blocks whose `parent_id` is the page (and, nested, theirs). A page
 * with no parent is a top-level page. Siblings are ordered by `position`, a
 * fractional index, so inserting or moving a block writes only that block's
 * row, and two devices' edits to different blocks never conflict in sync.
 *
 * `type` names the block type (lib/blocks.ts); `props` and `content` are its
 * JSON. Every block type shares these columns, so a new type needs no change
 * here or in sync. A deleted block keeps its row with `deleted_at` set, so
 * its revisions can still say what a page used to hold.
 */
export const blocks = sqliteTable(
  "blocks",
  {
    id: rowId("blocks"),
    type: text("type").notNull(),
    parentId: text("parent_id"),
    position: text("position").notNull(),
    props: text("props").notNull().default("{}"),
    content: text("content").notNull().default("[]"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (t) => [index("blocks_parent").on(t.parentId, t.position)],
);

// Spec: BOOK-5, BOOK-6, SYN-14
/**
 * Every saved change to a block, as the block was after it: a revision per
 * save, written by the device that saved it. Edits to the same block made on
 * two devices before they sync are two revisions, and both are kept.
 * `page_id` is the page the block belonged to then, so a page can be read as
 * it was at any moment.
 */
export const revisions = sqliteTable(
  "revisions",
  {
    id: rowId("revisions"),
    blockId: text("block_id").notNull(),
    pageId: text("page_id"),
    type: text("type").notNull(),
    parentId: text("parent_id"),
    position: text("position").notNull(),
    props: text("props").notNull(),
    content: text("content").notNull(),
    deleted: integer("deleted").notNull().default(0),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("revisions_block").on(t.blockId, t.createdAt), index("revisions_page").on(t.pageId, t.createdAt)],
);

// Spec: AI-3
/** One model response's reported cost, under the feature that asked for it. */
export const aiUsage = sqliteTable(
  "ai_usage",
  {
    id: rowId("ai_usage"),
    feature: text("feature").notNull(),
    model: text("model").notNull(),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    cost: real("cost").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("ai_usage_created").on(t.createdAt)],
);

// ---------------------------------------------------------------------------
// Sync (see src-tauri/src/sync/). These are kept up to date by triggers on
// every synced table, generated into the migration that created them, so
// every writer is covered, Rust included. The app never writes them itself.
// ---------------------------------------------------------------------------

/**
 * This device's own sync state (one row, `id` = 1): who it is, its clock,
 * and how far its change counter has got. Never synced.
 */
export const syncState = sqliteTable("sync_state", {
  id: integer("id").primaryKey(),
  /** This device's id; a new one on joining a book. */
  deviceId: text("device_id").notNull(),
  /** Hybrid logical clock: last physical ms used, and a counter within it. */
  hlcMs: integer("hlc_ms").notNull().default(0),
  hlcCounter: integer("hlc_counter").notNull().default(0),
  /** Bumped by every recorded change; peers pull "everything since N". */
  seq: integer("seq").notNull().default(0),
  /** 1 while the sync engine applies a peer's changes: triggers stand down. */
  applying: integer("applying").notNull().default(0),
  /** The book this device belongs to; null until it creates or joins one. */
  bookId: text("book_id"),
  /** Noise static key pair (X25519), made on first use. */
  secretKey: blob("secret_key", { mode: "buffer" }),
  publicKey: blob("public_key", { mode: "buffer" }),
  /**
   * Which copy of the database this is. Mirrored in a file beside it, so a
   * database that turns up somewhere it wasn't written — restored from a
   * backup, a snapshot put back, a file copied — notices, and takes a new
   * device id before writing anything (src-tauri/src/sync/instance.rs).
   */
  instance: text("instance"),
});

/**
 * The current version of every row of every synced table, deleted ones
 * included (tombstones). Never synced: it *is* what's exchanged.
 */
export const syncRows = sqliteTable(
  "sync_rows",
  {
    tbl: text("tbl").notNull(),
    pk: text("pk").notNull(),
    /** "<13-digit ms>.<6-digit counter>" — sorts as text. */
    hlc: text("hlc").notNull(),
    /** Device that wrote this version. */
    origin: text("origin").notNull(),
    deleted: integer("deleted").notNull().default(0),
    /** This device's change counter when the version was recorded here. */
    seq: integer("seq").notNull(),
    /** The peer this exact version came from, so it isn't sent back to it. */
    fromPeer: text("from_peer"),
  },
  (t) => [
    primaryKey({ columns: [t.tbl, t.pk] }),
    index("idx_sync_rows_seq").on(t.seq),
  ],
);

/**
 * Version vectors: each device's latest change to each row. Two versions
 * where neither has seen all of the other's changes were made concurrently,
 * and the later clock wins. Never synced.
 */
export const syncVv = sqliteTable(
  "sync_vv",
  {
    tbl: text("tbl").notNull(),
    pk: text("pk").notNull(),
    device: text("device").notNull(),
    counter: integer("counter").notNull(),
  },
  (t) => [primaryKey({ columns: [t.tbl, t.pk, t.device] })],
);

/** What this device knows about each peer it syncs with. Never synced. */
export const syncPeers = sqliteTable("sync_peers", {
  deviceId: text("device_id").primaryKey(),
  /** Their change counter up to which everything has been pulled. */
  lastPulledSeq: integer("last_pulled_seq").notNull().default(0),
  /** "ip:port" they were last reached at. */
  lastAddr: text("last_addr"),
  lastSyncAt: text("last_sync_at"),
  /** Last time both sides were found to hold exactly the same data. */
  lastCompleteAt: text("last_complete_at"),
  /** 1 when the last finished sync ended with both sides identical. */
  complete: integer("complete").notNull().default(0),
  /** The epoch it introduced itself with at its last finished sync (see `syncEpochs`). */
  lastEpoch: text("last_epoch"),
});

/**
 * This device's epochs: a new one whenever it has written anything since it
 * last introduced itself to a peer. Peers remember the last epoch they saw
 * from it; a copy of this database restored from any earlier point lacks
 * the later ones, so the first peer it meets can tell it's a stale copy
 * (src-tauri/src/sync/session.rs). Never synced; never pruned (one row per
 * sync that carried local changes).
 */
export const syncEpochs = sqliteTable("sync_epochs", {
  epoch: text("epoch").primaryKey(),
  /** This device's change counter when the epoch began. */
  seq: integer("seq").notNull(),
  createdAt: text("created_at").notNull(),
});

/**
 * Keys taken out of the book. Only ever added to, never edited or removed —
 * so no later edit on some device can undo a removal, the way it could undo
 * deleting a `book_devices` row. A device presenting a key listed here is
 * refused, whatever else says about it.
 */
export const bookRevocations = sqliteTable("book_revocations", {
  /** X25519 public key, hex. */
  publicKey: text("public_key").primaryKey(),
  /** The device it belonged to, for the record. */
  deviceId: text("device_id").notNull(),
  revokedAt: text("revoked_at").notNull(),
});

/**
 * The devices in the book, and the keys they're recognised by. Synced like
 * any other table, so adding or removing a device reaches every member.
 */
export const bookDevices = sqliteTable("book_devices", {
  /** The device's id (`sync_state.device_id` over there). */
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** X25519 public key, hex. */
  publicKey: text("public_key").notNull(),
  /** "android" | "desktop". */
  platform: text("platform").notNull(),
  addedAt: text("added_at").notNull(),
});

// ---------------------------------------------------------------------------
// The library (src/lib/library.ts)
// ---------------------------------------------------------------------------

// Spec: LIB-1, LIB-3
/** A paper or book in the library: its details. Its PDF is in `library_files`. */
export const libraryItems = sqliteTable(
  "library_items",
  {
    id: rowId("library_items"),
    /** "paper" | "book" (`library.kinds`). */
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    /** As written ("Ada Lovelace, Charles Babbage"). */
    authors: text("authors").notNull().default(""),
    year: integer("year"),
    filename: text("filename").notNull(),
    fileSize: integer("file_size").notNull(),
    pages: integer("pages"),
    // Spec: LIB-14
    /** The PDF's outline as JSON (`TocEntry[]`, lib/library.ts); null until taken. */
    toc: text("toc"),
    // Spec: LIB-23
    /** Its arXiv identifier (`1706.03762`), when it came from arXiv. */
    arxivId: text("arxiv_id"),
    addedAt: text("added_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("library_items_added").on(t.addedAt)],
);

// Spec: LIB-7
/**
 * A library item's PDF, byte for byte. Kept apart from `library_items` so
 * listing the library never reads megabytes. Synced like everything else.
 */
// Spec: LIB-24, LIB-27
/**
 * An item's HTML version (from arXiv, or an HTML file the author added):
 * one per item, its figures inlined, so it reads the same offline. Kept
 * apart from the item, like its PDF, so listing never reads it.
 */
export const libraryHtml = sqliteTable("library_html", {
  itemId: text("item_id").primaryKey(),
  html: text("html").notNull(),
  /** Where it came from (an arXiv address), or null for a file. */
  sourceUrl: text("source_url"),
  fetchedAt: text("fetched_at").notNull(),
});

export const libraryFiles = sqliteTable("library_files", {
  /** The item's id: one file per item. */
  itemId: text("item_id").primaryKey(),
  mediaType: text("media_type").notNull(),
  data: blob("data", { mode: "buffer" }).notNull(),
});

// Spec: PPL-1, PPL-5
/**
 * An author, linked from every item they wrote (`authorships`). Two people
 * found to be the same are merged by pointing one at the other
 * (`merged_into`) rather than rewriting the links: a link added on another
 * device to the merged one, before it heard of the merge, still arrives at
 * the right person. Chains and cycles are resolved on reading
 * (src/lib/people.ts).
 */
export const people = sqliteTable("people", {
  id: rowId("people"),
  name: text("name").notNull(),
  mergedInto: text("merged_into"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** An institution authors are listed with. Merged the way people are. */
export const institutions = sqliteTable("institutions", {
  id: rowId("institutions"),
  name: text("name").notNull(),
  mergedInto: text("merged_into"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** A person as an author of an item, in the item's author order. */
export const authorships = sqliteTable(
  "authorships",
  {
    id: rowId("authorships"),
    itemId: text("item_id").notNull(),
    personId: text("person_id").notNull(),
    position: integer("position").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("authorships_item").on(t.itemId), index("authorships_person").on(t.personId)],
);

/** An institution an author is listed with on one item. */
export const affiliations = sqliteTable(
  "affiliations",
  {
    id: rowId("affiliations"),
    authorshipId: text("authorship_id").notNull(),
    institutionId: text("institution_id").notNull(),
  },
  (t) => [index("affiliations_authorship").on(t.authorshipId), index("affiliations_institution").on(t.institutionId)],
);

// ---------------------------------------------------------------------------
// The assistant's chats and memory (src/lib/chats.ts, src/lib/memory.ts)
// ---------------------------------------------------------------------------

// Spec: CHAT-1, SYN-20
/**
 * A conversation with the assistant: its whole transcript as one JSON array
 * of OpenAI-style messages (tool calls and results included), rewritten
 * after every round. One row per chat, so two devices continuing it at once
 * conflict; sync then keeps the losing side as a chat of its own (the
 * engine's `chats` rule), so no turn is lost.
 */
export const chats = sqliteTable(
  "chats",
  {
    id: rowId("chats"),
    title: text("title").notNull(),
    messages: text("messages").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("chats_updated").on(t.updatedAt)],
);

// Spec: MEM-1
/** One thing the assistant remembers across chats. */
export const assistantMemory = sqliteTable("assistant_memory", {
  id: rowId("assistant_memory"),
  /** "preference" | "focus" | "note" (src/lib/memory.ts). */
  kind: text("kind").notNull(),
  text: text("text").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// Spec: LEAN-5, ID-2
/**
 * What a computer found when it verified a Lean block: one row per block,
 * keyed by the block's id, so two computers verifying the same block write
 * the same row. It holds for the source it was reached for (`source_hash`,
 * and `deps`, the hashes of every block it imports): a block changed since
 * shows as not verified. Written by Rust (src-tauri/src/lean/).
 */
export const leanChecks = sqliteTable("lean_checks", {
  blockId: text("block_id").primaryKey(),
  /** SHA-256 (hex) of the block's name, a newline, and its source. */
  sourceHash: text("source_hash").notNull(),
  /** JSON: `{ name, hash }` for each block it imports, directly or not. */
  deps: text("deps").notNull(),
  /** "verified" | "sorry" | "errors". */
  status: text("status").notNull(),
  /** JSON: Lean's messages, `{ severity, line, column, endLine, endColumn, text }`. */
  messages: text("messages").notNull(),
  leanVersion: text("lean_version").notNull(),
  /** The name of the computer that verified it. */
  device: text("device").notNull(),
  checkedAt: text("checked_at").notNull(),
});

// ---------------------------------------------------------------------------
// The audio library (src/lib/audio.ts, src-tauri/src/audio/)
// ---------------------------------------------------------------------------

// Spec: AUD-1, AUD-2, AUD-4, AUD-6
/**
 * A recording of library items: verbatim (an item, or one of its sections)
 * or a summary of several. Made on one device (`device`), which alone carries
 * on with it: "writing" its script, then "speaking" it, then "ready".
 */
export const recordings = sqliteTable(
  "recordings",
  {
    id: rowId("recordings"),
    /** "verbatim" | "summary". */
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    /** JSON: the ids of the items it's of, in order. */
    items: text("items").notNull(),
    /** For a verbatim recording of a section: the section's anchor (HTML) or `page:<n>` (PDF contents). */
    section: text("section"),
    /** For a summary: its length in minutes (`audio.summary-lengths`). */
    minutes: integer("minutes"),
    voice: text("voice").notNull(),
    speechModel: text("speech_model").notNull(),
    /** "writing" | "speaking" | "ready" | "failed". */
    status: text("status").notNull(),
    /** How far the stage is, 0 to 1. */
    progress: real("progress").notNull().default(0),
    error: text("error"),
    /** JSON: what's read, `{ chapters: [{ title, paragraphs }] }`, filled as it's written. */
    script: text("script"),
    /** JSON: `[{ title, start }]`, seconds, once spoken. */
    chapters: text("chapters"),
    durationSeconds: real("duration_seconds"),
    /** The device making it (its sync device id). */
    device: text("device").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("recordings_created").on(t.createdAt)],
);

// Spec: AUD-7
/** A recording's audio: Opus in WebM. Kept apart from it, as PDFs are from items. */
export const recordingFiles = sqliteTable("recording_files", {
  recordingId: text("recording_id").primaryKey(),
  mediaType: text("media_type").notNull(),
  data: blob("data", { mode: "buffer" }).notNull(),
});

// Spec: AUD-9
/** Where the author stopped listening to a recording, on whichever device. */
export const listening = sqliteTable("listening", {
  recordingId: text("recording_id").primaryKey(),
  /** Seconds. */
  position: real("position").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// Spec: AUD-6
/**
 * Passages already spoken, on this device only, until their recording is
 * done: a recording that stops carries on without paying for them again.
 * Keyed by SHA-256 of the model, voice and text.
 */
export const speechClips = sqliteTable("speech_clips", {
  key: text("key").primaryKey(),
  sampleRate: integer("sample_rate").notNull(),
  /** 16-bit little-endian mono PCM. */
  pcm: blob("pcm", { mode: "buffer" }).notNull(),
  createdAt: text("created_at").notNull(),
});

// Spec: DIAG-1, DIAG-2
/**
 * What happened in the app on this device (never synced): failures, the
 * work it did by itself, the screens it went through. Written by the
 * frontend (src/lib/diagnostics.ts) and by Rust (src-tauri/src/diagnostics.rs).
 */
export const diagnostics = sqliteTable(
  "diagnostics",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Milliseconds since the epoch. */
    at: integer("at").notNull(),
    /** "error", "warning" or "info". */
    level: text("level").notNull(),
    /** What it came from: "app", "assistant", "audio", "sync", … */
    source: text("source").notNull(),
    message: text("message").notNull(),
    /** A stack, a response, whatever more there is. */
    details: text("details"),
    /** The address on screen when it happened. */
    screen: text("screen"),
  },
  (t) => [index("diagnostics_at").on(t.at)],
);
