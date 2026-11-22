// ---------------------------------------------------------------------------
// The book in the database: reading pages and the page tree, saving a page's
// blocks with a revision for every change, creating, renaming and moving
// pages and blocks, and reading a page as it was. The decisions live in
// lib/bookModel.ts; this file does the queries.
//
// Every write to a block also writes its revision (BOOK-5). The database has
// no transactions across calls here (tauri-plugin-sql hands statements to a
// pool), so a revision is written right after its block.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { execute, nowIso, select } from "./db";
import { newId } from "./ids";
import {
  bySiblingOrder,
  canonical,
  keyBetween,
  contentTree,
  inlineMarkdown,
  PAGE_TYPE,
  pageTree,
  parseContent,
  parseProps,
  snapshotOf,
  titleOf,
  toMarkdown,
  type BlockRow,
  type DocBlock,
  type PageNode,
  type RevisionRow,
  type RowWrite,
  type Snapshot,
} from "./bookModel";

const BlockRowSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    parent_id: z.string().nullable(),
    position: z.string(),
    props: z.string(),
    content: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    deleted_at: z.string().nullable(),
  })
  .transform(
    (r): BlockRow => ({
      id: r.id,
      type: r.type,
      parentId: r.parent_id,
      position: r.position,
      props: r.props,
      content: r.content,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      deletedAt: r.deleted_at,
    }),
  );

const RevisionRowSchema = z
  .object({
    id: z.string(),
    block_id: z.string(),
    page_id: z.string().nullable(),
    type: z.string(),
    parent_id: z.string().nullable(),
    position: z.string(),
    props: z.string(),
    content: z.string(),
    deleted: z.number(),
    created_at: z.string(),
  })
  .transform(
    (r): RevisionRow => ({
      id: r.id,
      blockId: r.block_id,
      pageId: r.page_id,
      type: r.type,
      parentId: r.parent_id,
      position: r.position,
      props: r.props,
      content: r.content,
      deleted: r.deleted,
      createdAt: r.created_at,
    }),
  );

const SkeletonSchema = z.object({
  id: z.string(),
  type: z.string(),
  parent_id: z.string().nullable(),
  position: z.string(),
  title: z.string().nullable(),
});

const BLOCK_COLUMNS = "id, type, parent_id, position, props, content, created_at, updated_at, deleted_at";

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** The book's pages as a tree. */
export async function loadPageTree(): Promise<PageNode[]> {
  const rows = await select(
    `SELECT id, type, parent_id, position,
       CASE WHEN type = '${PAGE_TYPE}' THEN json_extract(props, '$.title') END AS title
     FROM blocks WHERE deleted_at IS NULL`,
  );
  return pageTree(
    z
      .array(SkeletonSchema)
      .parse(rows)
      .map((r) => ({ id: r.id, type: r.type, parentId: r.parent_id, position: r.position, title: r.title })),
  );
}

/** One block's row, deleted or not. */
export async function loadBlock(id: string): Promise<BlockRow | null> {
  const rows = await select(`SELECT ${BLOCK_COLUMNS} FROM blocks WHERE id = $1`, [id]);
  return z.array(BlockRowSchema).parse(rows)[0] ?? null;
}

/** A page's row and every live block of its content (not its subpages' content). */
export async function loadPageRows(pageId: string): Promise<{ page: BlockRow | null; rows: BlockRow[] }> {
  const rows = z.array(BlockRowSchema).parse(
    await select(
      `WITH RECURSIVE t(id, type) AS (
         SELECT id, type FROM blocks WHERE parent_id = $1 AND deleted_at IS NULL
         UNION ALL
         SELECT b.id, b.type FROM blocks b JOIN t ON b.parent_id = t.id
         WHERE t.type != '${PAGE_TYPE}' AND b.deleted_at IS NULL
       )
       SELECT ${BLOCK_COLUMNS} FROM blocks WHERE id IN (SELECT id FROM t) OR id = $1`,
      [pageId],
    ),
  );
  const page = rows.find((r) => r.id === pageId) ?? null;
  return { page, rows: rows.filter((r) => r.id !== pageId) };
}

/** A loaded page: its title, its content tree and what a save compares against. */
export interface LoadedPage {
  page: BlockRow;
  title: string;
  blocks: DocBlock[];
  snapshot: Map<string, Snapshot>;
}

export async function loadPage(pageId: string): Promise<LoadedPage | null> {
  const { page, rows } = await loadPageRows(pageId);
  if (!page || page.type !== PAGE_TYPE) return null;
  return {
    page,
    title: titleOf(parseProps(page.props)),
    blocks: contentTree(pageId, rows),
    snapshot: snapshotOf(pageId, rows),
  };
}

/** Every page's title, for writing a page out. */
async function allTitles(): Promise<Map<string, string>> {
  const rows = z
    .array(z.object({ id: z.string(), props: z.string() }))
    .parse(await select(`SELECT id, props FROM blocks WHERE type = '${PAGE_TYPE}'`));
  return new Map(rows.map((r) => [r.id, titleOf(parseProps(r.props))]));
}

/** A page as Markdown, title first. */
export async function pageMarkdown(pageId: string): Promise<string> {
  const loaded = await loadPage(pageId);
  if (!loaded) return "";
  const titles = await allTitles();
  const body = toMarkdown(loaded.blocks, (id) => titles.get(id) ?? "Untitled");
  return `# ${loaded.title}\n\n${body}`.trim();
}

/** The page a block is on: the nearest page above it. */
export async function pageOfBlock(blockId: string): Promise<string | null> {
  const rows = await select(
    `WITH RECURSIVE up(id, parent_id, type) AS (
       SELECT id, parent_id, type FROM blocks WHERE id = $1
       UNION ALL
       SELECT b.id, b.parent_id, b.type FROM blocks b JOIN up ON b.id = up.parent_id
       WHERE up.id = $1 OR up.type != '${PAGE_TYPE}'
     )
     SELECT id FROM up WHERE type = '${PAGE_TYPE}' AND id != $1 LIMIT 1`,
    [blockId],
  );
  const id = rows[0]?.["id"];
  return typeof id === "string" ? id : null;
}

/** A block's text, for showing a link to it. */
export function plainText(content: unknown): string {
  return inlineMarkdown(content, () => "").replace(/[*_~`]/g, "");
}

export interface LinkTarget {
  pageId: string;
  blockId: string | null;
  title: string;
  /** The block's text, for a link to a block. */
  snippet: string | null;
}

// Spec: LNK-1, LNK-2
/** Pages whose title, and blocks whose text, contain `query`: what a link can point at. */
export async function searchLinkTargets(query: string): Promise<LinkTarget[]> {
  const like = `%${query.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const pages = z
    .array(z.object({ id: z.string(), props: z.string() }))
    .parse(
      await select(
        `SELECT id, props FROM blocks
         WHERE type = '${PAGE_TYPE}' AND deleted_at IS NULL
           AND coalesce(json_extract(props, '$.title'), '') LIKE $1 ESCAPE '\\'
         ORDER BY updated_at DESC LIMIT 8`,
        [like],
      ),
    );
  const out: LinkTarget[] = pages.map((p) => ({ pageId: p.id, blockId: null, title: titleOf(parseProps(p.props)), snippet: null }));
  if (query.trim().length < 2) return out;

  const blocks = z
    .array(z.object({ id: z.string(), content: z.string() }))
    .parse(
      await select(
        `SELECT id, content FROM blocks
         WHERE type != '${PAGE_TYPE}' AND deleted_at IS NULL AND content LIKE $1 ESCAPE '\\'
         ORDER BY updated_at DESC LIMIT 8`,
        [like],
      ),
    );
  const titles = await allTitles();
  for (const b of blocks) {
    const text = plainText(parseContent(b.content));
    if (!text.toLowerCase().includes(query.toLowerCase())) continue;
    const pageId = await pageOfBlock(b.id);
    if (!pageId) continue;
    out.push({ pageId, blockId: b.id, title: titles.get(pageId) ?? "Untitled", snippet: text.slice(0, 80) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

// Spec: BOOK-5, SYN-14
/** Records a block as it now is: one revision per saved change. */
async function writeRevision(blockId: string, pageId: string | null, s: Snapshot, deleted: boolean, at: string): Promise<void> {
  await execute(
    `INSERT INTO revisions (id, block_id, page_id, type, parent_id, position, props, content, deleted, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [newId("revisions"), blockId, pageId, s.type, s.parentId, s.position, s.props, s.content, deleted ? 1 : 0, at],
  );
}

async function upsertBlock(w: RowWrite, at: string): Promise<void> {
  await execute(
    `INSERT INTO blocks (id, type, parent_id, position, props, content, created_at, updated_at, deleted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7, NULL)
     ON CONFLICT (id) DO UPDATE SET
       type = excluded.type, parent_id = excluded.parent_id, position = excluded.position,
       props = excluded.props, content = excluded.content, updated_at = excluded.updated_at, deleted_at = NULL`,
    [w.id, w.type, w.parentId, w.position, w.props, w.content, at],
  );
}

// Spec: BOOK-11, BLK-4
/**
 * Writes a save planned by `planSave`: changed blocks and their revisions,
 * and removed blocks marked deleted (with a revision saying so). Returns the
 * snapshot to compare the next save against.
 */
export async function applySave(
  pageId: string,
  before: ReadonlyMap<string, Snapshot>,
  plan: { writes: readonly RowWrite[]; removed: readonly string[] },
): Promise<Map<string, Snapshot>> {
  const at = nowIso();
  const next = new Map(before);
  for (const w of plan.writes) {
    await upsertBlock(w, at);
    const s: Snapshot = { type: w.type, parentId: w.parentId, position: w.position, props: w.props, content: w.content };
    await writeRevision(w.id, pageId, s, false, at);
    next.set(w.id, s);
  }
  for (const id of plan.removed) {
    const s = before.get(id);
    await execute(`UPDATE blocks SET deleted_at = $2, updated_at = $2 WHERE id = $1 AND deleted_at IS NULL`, [id, at]);
    if (s) await writeRevision(id, pageId, s, true, at);
    next.delete(id);
  }
  return next;
}

/** The position after the last live child of `parentId`. */
async function endPosition(parentId: string | null): Promise<string> {
  const rows = z
    .array(z.object({ id: z.string(), position: z.string() }))
    .parse(
      await select(
        parentId === null
          ? `SELECT id, position FROM blocks WHERE parent_id IS NULL AND deleted_at IS NULL`
          : `SELECT id, position FROM blocks WHERE parent_id = $1 AND deleted_at IS NULL`,
        parentId === null ? [] : [parentId],
      ),
    );
  const sorted = rows.sort(bySiblingOrder);
  const last = sorted[sorted.length - 1];
  return keyBetween(last?.position ?? null, null);
}

function snapshotOfRow(r: BlockRow): Snapshot {
  return { type: r.type, parentId: r.parentId, position: r.position, props: r.props, content: r.content };
}

// Spec: PAGE-1
/** A new page at the end of `parentPageId` (or of the top level). Returns its id. */
export async function createPage(parentPageId: string | null, title = ""): Promise<string> {
  const id = newId("blocks");
  const at = nowIso();
  const w: RowWrite = {
    id,
    isNew: true,
    type: PAGE_TYPE,
    parentId: parentPageId,
    position: await endPosition(parentPageId),
    props: canonical({ title }),
    content: "[]",
  };
  await upsertBlock(w, at);
  await writeRevision(id, parentPageId, w, false, at);
  return id;
}

/** Gives a page a new title. */
export async function renamePage(pageId: string, title: string): Promise<void> {
  const row = await loadBlock(pageId);
  if (!row || row.type !== PAGE_TYPE) return;
  const props = canonical({ ...parseProps(row.props), title });
  if (props === canonical(parseProps(row.props))) return;
  const at = nowIso();
  await execute(`UPDATE blocks SET props = $2, updated_at = $3 WHERE id = $1`, [pageId, props, at]);
  await writeRevision(pageId, await pageOfBlock(pageId), { ...snapshotOfRow(row), props }, false, at);
}

/** The positions of `parentId`'s live children, in order. */
async function siblings(parentId: string | null): Promise<{ id: string; position: string }[]> {
  const rows = z
    .array(z.object({ id: z.string(), position: z.string() }))
    .parse(
      await select(
        parentId === null
          ? `SELECT id, position FROM blocks WHERE parent_id IS NULL AND deleted_at IS NULL`
          : `SELECT id, position FROM blocks WHERE parent_id = $1 AND deleted_at IS NULL`,
        parentId === null ? [] : [parentId],
      ),
    );
  return rows.sort(bySiblingOrder);
}

// Spec: PAGE-4, PAGE-5
/**
 * Moves a page under `newParentPageId` (null: the top level), just before
 * `beforeId` or at the end. Only the page's own row changes: its content,
 * revisions and the links to it stay as they are.
 */
export async function movePage(pageId: string, newParentPageId: string | null, beforeId: string | null): Promise<void> {
  const row = await loadBlock(pageId);
  if (!row || row.type !== PAGE_TYPE || pageId === newParentPageId) return;
  const list = (await siblings(newParentPageId)).filter((s) => s.id !== pageId);
  const at = list.findIndex((s) => s.id === beforeId);
  const lower = at === -1 ? (list[list.length - 1]?.position ?? null) : (list[at - 1]?.position ?? null);
  const upper = at === -1 ? null : (list[at]?.position ?? null);
  const position = keyBetween(lower, upper);
  const now = nowIso();
  await execute(`UPDATE blocks SET parent_id = $2, position = $3, updated_at = $4 WHERE id = $1`, [pageId, newParentPageId, position, now]);
  await writeRevision(pageId, newParentPageId, { ...snapshotOfRow(row), parentId: newParentPageId, position }, false, now);
}

// Spec: BLK-4
/**
 * Moves a block (with what is nested in it) to the end of another page. Its
 * nested blocks' rows don't change, but each gets a revision on the new page,
 * so the old page reads as it was without them.
 */
export async function moveBlockToPage(blockId: string, targetPageId: string): Promise<void> {
  const row = await loadBlock(blockId);
  if (!row || row.deletedAt !== null || blockId === targetPageId) return;
  const position = await endPosition(targetPageId);
  const now = nowIso();
  await execute(`UPDATE blocks SET parent_id = $2, position = $3, updated_at = $4 WHERE id = $1`, [blockId, targetPageId, position, now]);
  await writeRevision(blockId, targetPageId, { ...snapshotOfRow(row), parentId: targetPageId, position }, false, now);
  if (row.type === PAGE_TYPE) return;
  const nested = z.array(BlockRowSchema).parse(
    await select(
      `WITH RECURSIVE t(id, type) AS (
         SELECT id, type FROM blocks WHERE parent_id = $1 AND deleted_at IS NULL
         UNION ALL
         SELECT b.id, b.type FROM blocks b JOIN t ON b.parent_id = t.id
         WHERE t.type != '${PAGE_TYPE}' AND b.deleted_at IS NULL
       )
       SELECT ${BLOCK_COLUMNS} FROM blocks WHERE id IN (SELECT id FROM t)`,
      [blockId],
    ),
  );
  for (const n of nested) await writeRevision(n.id, targetPageId, snapshotOfRow(n), false, now);
}

/** Deletes a page: it leaves the book, its revisions stay. */
export async function deletePage(pageId: string): Promise<void> {
  const row = await loadBlock(pageId);
  if (!row || row.deletedAt !== null) return;
  const now = nowIso();
  const parentPage = await pageOfBlock(pageId);
  await execute(`UPDATE blocks SET deleted_at = $2, updated_at = $2 WHERE id = $1`, [pageId, now]);
  await writeRevision(pageId, parentPage, snapshotOfRow(row), true, now);
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

// Spec: BOOK-6
/** Every revision of every block that was ever on the page, and of the page itself. */
export async function pageRevisions(pageId: string): Promise<RevisionRow[]> {
  return z.array(RevisionRowSchema).parse(
    await select(
      `SELECT id, block_id, page_id, type, parent_id, position, props, content, deleted, created_at
       FROM revisions
       WHERE block_id = $1 OR block_id IN (SELECT DISTINCT block_id FROM revisions WHERE page_id = $1)
       ORDER BY created_at, id`,
      [pageId],
    ),
  );
}
