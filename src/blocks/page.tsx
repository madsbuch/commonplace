import { createReactBlockSpec } from "@blocknote/react";
import { usePageTitle } from "../lib/pageIndex";
import { go, pagePath } from "../lib/navigation";
import { dbId } from "./ids";
import type { BlockType } from "./types";

function PageBlockView(props: { id: string }) {
  const id = dbId(props.id);
  const title = usePageTitle(id);
  return (
    <button type="button" className="page-block" contentEditable={false} onClick={() => go(pagePath(id))}>
      <span className="page-block-icon" aria-hidden>
        ▤
      </span>
      <span className="page-block-title">{title}</span>
    </button>
  );
}

// Spec: PAGE-3
/**
 * A subpage, shown in its parent's content as a link to it. Its title is
 * read live from the page itself; its content belongs to it, not to the parent.
 */
export const pageBlockSpec = createReactBlockSpec(
  {
    type: "page",
    propSchema: { title: { default: "" } },
    content: "none",
  },
  {
    render: ({ block }) => <PageBlockView id={block.id} />,
  },
);

export const page: BlockType = {
  stored: "page",
  editorTypes: ["page"],
  toEditor: (b) => ({ type: "page", props: { title: typeof b.props["title"] === "string" ? b.props["title"] : "" }, content: undefined }),
  fromEditor: (b) => ({ type: "page", props: b.props, content: [] }),
};
