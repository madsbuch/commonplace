import { without, type BlockType } from "./types";

// Spec: LIST-1
/** One list item, bulleted (`- `) or numbered (`1. `): one stored type, two editor types. */
export const list: BlockType = {
  stored: "list",
  editorTypes: ["bulletListItem", "numberedListItem"],
  toEditor: (b) => ({
    type: b.props["style"] === "numbered" ? "numberedListItem" : "bulletListItem",
    props: without(b.props, "style"),
    content: b.content,
  }),
  fromEditor: (b) => ({
    type: "list",
    props: { ...b.props, style: b.type === "numberedListItem" ? "numbered" : "bulleted" },
    content: b.content,
  }),
};
