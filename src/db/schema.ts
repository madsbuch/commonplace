import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
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
