import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { linksToLibrary } from "../lib/book";
import { linkingPages, type ItemLink } from "../lib/bookModel";
import { useTablesVersion } from "../lib/live";
import { pagePath } from "../lib/navigation";

// Spec: LNK-6
/**
 * The pages that link to a library item, each opening at the (first) block
 * that holds the link. Nothing when none do.
 */
export function LinkedFrom(props: { itemId: string }) {
  const [links, setLinks] = useState<ItemLink[]>([]);
  const version = useTablesVersion(["blocks"]);
  useEffect(() => {
    let live = true;
    void linksToLibrary(props.itemId)
      .then((m) => {
        if (live) setLinks(m.get(props.itemId) ?? []);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [props.itemId, version]);
  const pages = linkingPages(links);
  if (pages.length === 0) return null;
  return (
    <p className="item-linked-from">
      <span className="muted">Linked from </span>
      {pages.map((p, i) => (
        <span key={p.pageId}>
          {i > 0 ? ", " : null}
          <Link to={pagePath(p.pageId, p.blockId)}>{p.pageTitle}</Link>
        </span>
      ))}
    </p>
  );
}
