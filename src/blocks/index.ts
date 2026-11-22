// The block types the book knows, and the editor schema made from them. A new
// block type is a new module here, added to `BLOCK_TYPES` (and, for a custom
// one, its spec to `blockSpecs`): storage and sync don't change (BLK-2).

import {
  BlockNoteSchema,
  createHeadingBlockSpec,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
  defaultStyleSpecs,
  type PartialBlock,
} from "@blocknote/core";
import type { DocBlock } from "../lib/bookModel";
import { fieldsOf } from "../lib/guards";
import { code, codeBlockSpec } from "./code";
import { heading, HEADING_LEVELS } from "./heading";
import { list } from "./list";
import { page, pageBlockSpec } from "./page";
import { paragraph } from "./paragraph";
import { fromUnknown, toUnknown, unknownBlockSpec } from "./unknown";
import { mathInlineSpec } from "./inline/math";
import { pageLinkInlineSpec } from "./inline/pageLink";
import { dbId, editorId } from "./ids";
import type { BlockType } from "./types";

export const BLOCK_TYPES: readonly BlockType[] = [paragraph, heading, list, code, page];

export const schema = BlockNoteSchema.create({
  blockSpecs: {
    paragraph: defaultBlockSpecs.paragraph,
    heading: createHeadingBlockSpec({ levels: HEADING_LEVELS, allowToggleHeadings: false }),
    bulletListItem: defaultBlockSpecs.bulletListItem,
    numberedListItem: defaultBlockSpecs.numberedListItem,
    codeBlock: codeBlockSpec,
    page: pageBlockSpec(),
    unknown: unknownBlockSpec(),
  },
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    math: mathInlineSpec,
    pageLink: pageLinkInlineSpec,
  },
  styleSpecs: defaultStyleSpecs,
});

export type BookSchema = typeof schema;
export type EditorPartialBlock = PartialBlock<BookSchema["blockSchema"], BookSchema["inlineContentSchema"], BookSchema["styleSchema"]>;

const byStored = new Map(BLOCK_TYPES.map((t) => [t.stored, t]));
const byEditor = new Map(BLOCK_TYPES.flatMap((t) => t.editorTypes.map((e) => [e, t] as const)));
const editorTypes = new Set(Object.keys(schema.blockSpecs));

/** The shape of an editor block this module reads (the editor's `Block`, loosely). */
export interface EditorBlockLike {
  id: string;
  type: string;
  props: object;
  content?: unknown;
  children: readonly EditorBlockLike[];
}

function isEditorPartial(x: unknown): x is EditorPartialBlock {
  const f = fieldsOf(x);
  if (!f) return false;
  const children = f["children"];
  return (
    typeof f["id"] === "string" &&
    typeof f["type"] === "string" &&
    editorTypes.has(f["type"]) &&
    fieldsOf(f["props"]) !== null &&
    Array.isArray(children) &&
    children.every(isEditorPartial)
  );
}

/** Stored blocks as the editor's blocks. Types this app doesn't know become placeholders. */
export function toEditorBlocks(blocks: readonly DocBlock[]): EditorPartialBlock[] {
  return blocks.flatMap((b) => {
    const t = byStored.get(b.type);
    const shown = t ? t.toEditor(b) : toUnknown(b);
    const out = {
      id: editorId(b.id),
      type: shown.type,
      props: shown.props,
      ...(shown.content === undefined ? {} : { content: shown.content }),
      children: toEditorBlocks(b.children),
    };
    if (isEditorPartial(out)) return [out];
    console.warn(`Block ${b.id} (${b.type}) can't be shown`);
    return [];
  });
}

/** The editor's blocks in the stored form. */
export function fromEditorBlocks(blocks: readonly EditorBlockLike[]): DocBlock[] {
  return blocks.map((b) => {
    const props = fieldsOf(b.props) ?? {};
    const stored =
      b.type === "unknown" ? fromUnknown(props) : (byEditor.get(b.type)?.fromEditor({ type: b.type, props, content: b.content ?? [] }) ?? null);
    return {
      id: dbId(b.id),
      type: stored?.type ?? b.type,
      props: stored?.props ?? props,
      content: stored?.content ?? b.content ?? [],
      children: fromEditorBlocks(b.children),
    };
  });
}
