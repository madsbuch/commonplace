import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { flattenTree } from "../lib/bookModel";
import { pagePath } from "../lib/navigation";
import { usePageIndex } from "../lib/pageIndex";
import { SearchIcon } from "./Icons";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
export const QUICK_OPEN_KEYS = isMac ? "⌘K" : "Ctrl+K";

// Spec: APP-7
/** A search over every page, from any screen: `Ctrl+K` (`⌘K`), arrows, Enter. */
export function QuickOpen(props: { open: boolean; onClose: () => void }) {
  const { tree } = usePageIndex();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const pages = useMemo(() => {
    const flat = flattenTree(tree);
    const titles = new Map(flat.map(({ node }) => [node.id, node.title]));
    const q = query.trim().toLowerCase();
    return flat
      .filter(({ node }) => q === "" || node.title.toLowerCase().includes(q))
      .slice(0, 50)
      .map(({ node }) => ({ id: node.id, title: node.title, under: node.parentPageId ? (titles.get(node.parentPageId) ?? null) : null }));
  }, [tree, query]);

  useEffect(() => {
    if (props.open) {
      setQuery("");
      setActive(0);
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [props.open]);

  if (!props.open) return null;
  const go = (id: string) => {
    props.onClose();
    void navigate(pagePath(id));
  };
  return (
    <div className="dialog-backdrop quick-open-backdrop" onClick={props.onClose}>
      <div className="dialog quick-open" role="dialog" aria-label="Go to a page" onClick={(e) => e.stopPropagation()}>
        <div className="quick-open-field">
          <SearchIcon />
          <input
            ref={input}
            placeholder="Go to a page…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") props.onClose();
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, pages.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === "Enter") {
                const p = pages[active];
                if (p) go(p.id);
              }
            }}
          />
          <kbd>esc</kbd>
        </div>
        <ul className="picker-list">
          {pages.map((p, i) => (
            <li key={p.id}>
              <button type="button" className={i === active ? "active" : undefined} onMouseEnter={() => setActive(i)} onClick={() => go(p.id)}>
                <span>{p.title}</span>
                {p.under ? <span className="muted quick-under">in {p.under}</span> : null}
              </button>
            </li>
          ))}
          {pages.length === 0 ? <li className="muted picker-empty">No pages match.</li> : null}
        </ul>
      </div>
    </div>
  );
}
