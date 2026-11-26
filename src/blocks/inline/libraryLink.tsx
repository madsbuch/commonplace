import { useEffect, useState } from "react";
import { createReactInlineContentSpec } from "@blocknote/react";
import { go } from "../../lib/navigation";
import { getItem } from "../../lib/library";
import { LIBRARY_LINK } from "../../lib/bookModel";
import { useTablesVersion } from "../../lib/live";

/** The address of a library item. */
export function itemPath(itemId: string): string {
  return `/library/${itemId}`;
}

function LibraryLinkView(props: { itemId: string }) {
  // undefined: loading; null: not in the library (any more, or not yet synced here).
  const [title, setTitle] = useState<string | null | undefined>(undefined);
  const version = useTablesVersion(["library_items"]);
  useEffect(() => {
    let live = true;
    void getItem(props.itemId)
      .then((item) => {
        if (live) setTitle(item ? item.title || "Untitled" : null);
      })
      .catch(() => {
        if (live) setTitle(null);
      });
    return () => {
      live = false;
    };
  }, [props.itemId, version]);
  return (
    <span
      className={title === null ? "page-link library-link missing" : "page-link library-link"}
      role="link"
      tabIndex={0}
      title={title === null ? "Not in the library on this device" : undefined}
      onClick={() => go(itemPath(props.itemId))}
    >
      {title ?? (title === null ? "Not in the library" : "…")}
    </span>
  );
}

// Spec: LNK-4
/**
 * A link to a library item, by id: it shows the item's current title and
 * opens the item.
 */
export const libraryLinkInlineSpec = createReactInlineContentSpec(
  {
    type: LIBRARY_LINK,
    propSchema: { itemId: { default: "" } },
    content: "none",
  },
  {
    render: ({ inlineContent }) => <LibraryLinkView itemId={inlineContent.props.itemId} />,
  },
);
