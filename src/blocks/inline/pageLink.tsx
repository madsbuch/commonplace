import { useEffect, useState } from "react";
import { createReactInlineContentSpec } from "@blocknote/react";
import { usePageTitle } from "../../lib/pageIndex";
import { go, pagePath } from "../../lib/navigation";
import { loadBlock, plainText } from "../../lib/book";
import { parseContent } from "../../lib/bookModel";
import { useTablesVersion } from "../../lib/live";

function BlockSnippet(props: { blockId: string }) {
  const [text, setText] = useState<string | null>(null);
  const version = useTablesVersion(["blocks"]);
  useEffect(() => {
    let live = true;
    void loadBlock(props.blockId).then((row) => {
      if (!live) return;
      setText(row && row.deletedAt === null ? plainText(parseContent(row.content)).slice(0, 48) : null);
    });
    return () => {
      live = false;
    };
  }, [props.blockId, version]);
  return text ? <span className="page-link-block"> › {text}</span> : null;
}

function PageLinkView(props: { pageId: string; blockId: string }) {
  const title = usePageTitle(props.pageId);
  return (
    <span
      className="page-link"
      role="link"
      tabIndex={0}
      onClick={() => go(pagePath(props.pageId, props.blockId || null))}
    >
      {title}
      {props.blockId ? <BlockSnippet blockId={props.blockId} /> : null}
    </span>
  );
}

// Spec: LNK-1, LNK-2, LNK-3
/**
 * A link to a page, or to one block on it, by id: it follows its target
 * wherever it moves, and shows the target's current title and text.
 */
export const pageLinkInlineSpec = createReactInlineContentSpec(
  {
    type: "pageLink",
    propSchema: { pageId: { default: "" }, blockId: { default: "" } },
    content: "none",
  },
  {
    render: ({ inlineContent }) => <PageLinkView pageId={inlineContent.props.pageId} blockId={inlineContent.props.blockId} />,
  },
);
