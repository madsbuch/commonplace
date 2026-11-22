import { useMemo, useState } from "react";
import { flattenTree } from "../lib/bookModel";
import { usePageIndex } from "../lib/pageIndex";

/** Choose a page from the book (searchable). */
export function PagePicker(props: {
  title: string;
  /** A page that can't be chosen (with what's under it, when `excludeSubtree`). */
  exclude?: string;
  excludeSubtree?: boolean;
  allowTop?: boolean;
  onPick: (pageId: string) => void;
  onPickTop?: () => void;
  onClose: () => void;
}) {
  const { tree } = usePageIndex();
  const [query, setQuery] = useState("");
  const rows = useMemo(() => {
    const flat = flattenTree(tree);
    let skipBelow: number | null = null;
    return flat.filter(({ node, depth }) => {
      if (skipBelow !== null) {
        if (depth > skipBelow) return false;
        skipBelow = null;
      }
      if (node.id === props.exclude) {
        if (props.excludeSubtree) skipBelow = depth;
        return false;
      }
      return query === "" || node.title.toLowerCase().includes(query.toLowerCase());
    });
  }, [tree, query, props.exclude, props.excludeSubtree]);

  return (
    <div className="dialog-backdrop" onClick={props.onClose}>
      <div className="dialog" role="dialog" aria-label={props.title} onClick={(e) => e.stopPropagation()}>
        <h2>{props.title}</h2>
        <input
          className="dialog-search"
          autoFocus
          placeholder="Search pages"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") props.onClose();
          }}
        />
        <ul className="picker-list">
          {props.allowTop && query === "" ? (
            <li>
              <button type="button" onClick={() => props.onPickTop?.()}>
                <em>Top level</em>
              </button>
            </li>
          ) : null}
          {rows.map(({ node, depth }) => (
            <li key={node.id}>
              <button type="button" style={{ paddingLeft: 12 + (query ? 0 : depth * 16) }} onClick={() => props.onPick(node.id)}>
                {node.title}
              </button>
            </li>
          ))}
          {rows.length === 0 ? <li className="muted picker-empty">No pages</li> : null}
        </ul>
        <div className="dialog-actions">
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
