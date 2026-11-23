import { createReactBlockSpec } from "@blocknote/react";
import { LeanBlock } from "../components/LeanBlock";
import type { BlockType } from "./types";

// Spec: LEAN-1, LEAN-2
/**
 * Lean 4 that the author's computers verify. Its name is in the props (the
 * module, under `Book.`); its source is the block's content, a string. The
 * editor holds both as props: the block has no inline content of its own.
 */
export const leanBlockSpec = createReactBlockSpec(
  {
    type: "lean",
    propSchema: { name: { default: "" }, source: { default: "" } },
    content: "none",
  },
  {
    render: ({ block, editor }) => (
      <LeanBlock
        editorId={block.id}
        name={block.props.name}
        source={block.props.source}
        editable={editor.isEditable}
        onChange={(changed) => editor.updateBlock(block.id, { props: changed })}
      />
    ),
  },
);

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export const lean: BlockType = {
  stored: "lean",
  editorTypes: ["lean"],
  toEditor: (b) => ({ type: "lean", props: { name: str(b.props["name"]), source: str(b.content) }, content: undefined }),
  fromEditor: (b) => ({ type: "lean", props: { name: str(b.props["name"]) }, content: str(b.props["source"]) }),
};
