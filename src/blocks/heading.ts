import type { BlockType } from "./types";

// Spec: HEAD-1
/** `heading.levels` in the spec. */
export const HEADING_LEVELS = [1, 2, 3] as const;

function level(raw: unknown): number {
  const n = typeof raw === "number" ? Math.round(raw) : 1;
  return Math.min(Math.max(n, 1), HEADING_LEVELS.length);
}

/** A section title, level 1 to 3 (`#`, `##`, `###`). */
export const heading: BlockType = {
  stored: "heading",
  editorTypes: ["heading"],
  toEditor: (b) => ({ type: "heading", props: { ...b.props, level: level(b.props["level"]) }, content: b.content }),
  fromEditor: (b) => ({ type: "heading", props: { ...b.props, level: level(b.props["level"]) }, content: b.content }),
};
