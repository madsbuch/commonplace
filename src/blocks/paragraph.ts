import type { BlockType } from "./types";

// Spec: PAR-1, PAR-2
/** Running text. Typed text that starts with no Markdown shortcut is a paragraph. */
export const paragraph: BlockType = {
  stored: "paragraph",
  editorTypes: ["paragraph"],
  toEditor: (b) => ({ type: "paragraph", props: b.props, content: b.content }),
  fromEditor: (b) => ({ type: "paragraph", props: b.props, content: b.content }),
};
