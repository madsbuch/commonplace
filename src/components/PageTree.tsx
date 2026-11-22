import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { createPage, movePage } from "../lib/book";
import { isWithin, type PageNode } from "../lib/bookModel";
import { draggedBlock, dropDraggedBlockOn, flushOpenEditor } from "../lib/editorBridge";
import { pagePath } from "../lib/navigation";
import { usePageIndex, usePageIndexLoaded } from "../lib/pageIndex";

const OPEN_KEY = "page-tree-open";

function loadOpen(): Set<string> {
  try {
    const raw = localStorage.getItem(OPEN_KEY);
    return new Set(raw ? raw.split(",").filter(Boolean) : []);
  } catch {
    return new Set();
  }
}

function saveOpen(open: Set<string>): void {
  try {
    localStorage.setItem(OPEN_KEY, [...open].join(","));
  } catch {
    // A convenience only.
  }
}

type Where = "before" | "inside" | "after";
interface Drop {
  targetId: string;
  where: Where;
}

/** Where a pointer at `y` over a row means to drop: above it, into it, or below it. */
function whereIn(row: Element, y: number): Where {
  const r = row.getBoundingClientRect();
  const f = (y - r.top) / r.height;
  return f < 0.28 ? "before" : f > 0.72 ? "after" : "inside";
}

/** Drags start after the pointer moves this far (mouse), or after holding this long (touch). */
const DRAG_DISTANCE_PX = 6;
const TOUCH_HOLD_MS = 350;

// Spec: PAGE-1, PAGE-2, PAGE-4
/**
 * The book's pages as a tree in the sidebar. A page is dragged (mouse, or a
 * long press on touch) above or below another to sit beside it, or onto it to
 * go inside it. A block dragged by its handle in the editor can be dropped on
 * a page to move it there.
 */
export function PageTree() {
  const { tree } = usePageIndex();
  const loaded = usePageIndexLoaded();
  const navigate = useNavigate();
  const [open, setOpen] = useState<Set<string>>(loadOpen);
  const [drag, setDrag] = useState<{ id: string; drop: Drop | null } | null>(null);
  const [blockOver, setBlockOver] = useState<string | null>(null);
  const pending = useRef<{ id: string; x: number; y: number; timer: ReturnType<typeof setTimeout> | null; touch: boolean } | null>(null);
  const suppressClick = useRef(false);

  const toggle = (id: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveOpen(next);
      return next;
    });
  };

  const newPage = async (parentId: string | null) => {
    await flushOpenEditor();
    const id = await createPage(parentId);
    if (parentId) {
      setOpen((prev) => {
        const next = new Set(prev).add(parentId);
        saveOpen(next);
        return next;
      });
    }
    navigate(pagePath(id));
  };

  // Pointer dragging of pages.
  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const row = el?.closest("[data-page-row]");
      const targetId = row?.getAttribute("data-page-row") ?? null;
      if (!row || !targetId || isWithin(tree, drag.id, targetId)) {
        setDrag({ id: drag.id, drop: null });
        return;
      }
      setDrag({ id: drag.id, drop: { targetId, where: whereIn(row, e.clientY) } });
    };
    const onUp = () => {
      const d = drag;
      setDrag(null);
      suppressClick.current = true;
      setTimeout(() => (suppressClick.current = false), 0);
      if (!d.drop) return;
      void dropPage(tree, d.id, d.drop);
      if (d.drop.where === "inside") {
        setOpen((prev) => {
          const next = new Set(prev).add(d.drop?.targetId ?? "");
          saveOpen(next);
          return next;
        });
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    window.addEventListener("pointercancel", onUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [drag, tree]);

  const onPointerDown = (id: string, e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const touch = e.pointerType === "touch";
    const timer = touch ? setTimeout(() => setDrag({ id, drop: null }), TOUCH_HOLD_MS) : null;
    pending.current = { id, x: e.clientX, y: e.clientY, timer, touch };
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const p = pending.current;
    if (!p) return;
    const far = Math.hypot(e.clientX - p.x, e.clientY - p.y) > DRAG_DISTANCE_PX;
    if (!far) return;
    if (p.timer) clearTimeout(p.timer);
    pending.current = null;
    // On touch, moving before the hold is a scroll, not a drag.
    if (!p.touch) setDrag({ id: p.id, drop: null });
  };
  const onPointerUp = () => {
    const p = pending.current;
    if (p?.timer) clearTimeout(p.timer);
    pending.current = null;
  };

  const renderNode = (node: PageNode, depth: number) => {
    const isOpen = open.has(node.id);
    const drop = drag?.drop?.targetId === node.id ? drag.drop.where : null;
    const cls = [
      "tree-row",
      drag?.id === node.id ? "dragging" : "",
      drop ? `drop-${drop}` : "",
      blockOver === node.id ? "drop-inside" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <li key={node.id}>
        <div
          className={cls}
          data-page-row={node.id}
          style={{ paddingLeft: 6 + depth * 14 }}
          onPointerDown={(e) => onPointerDown(node.id, e)}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onDragOver={(e) => {
            if (draggedBlock()) {
              e.preventDefault();
              setBlockOver(node.id);
            }
          }}
          onDragLeave={() => setBlockOver((cur) => (cur === node.id ? null : cur))}
          onDrop={(e) => {
            setBlockOver(null);
            if (!draggedBlock()) return;
            e.preventDefault();
            void dropDraggedBlockOn(node.id);
          }}
        >
          <button
            type="button"
            className={node.children.length > 0 ? "tree-toggle" : "tree-toggle empty"}
            aria-label={isOpen ? "Collapse" : "Expand"}
            onClick={() => toggle(node.id)}
          >
            {node.children.length > 0 ? (isOpen ? "▾" : "▸") : "•"}
          </button>
          <NavLink
            to={pagePath(node.id)}
            className="tree-link"
            draggable={false}
            onClick={(e) => {
              if (suppressClick.current) e.preventDefault();
            }}
          >
            {node.title}
          </NavLink>
          <button type="button" className="tree-add" aria-label="New page inside" title="New page inside" onClick={() => void newPage(node.id)}>
            +
          </button>
        </div>
        {isOpen && node.children.length > 0 ? <ul>{node.children.map((c) => renderNode(c, depth + 1))}</ul> : null}
      </li>
    );
  };

  return (
    <div className={drag ? "page-tree is-dragging" : "page-tree"}>
      <div className="tree-header">
        <NavLink to="/" className="tree-title">
          My Book
        </NavLink>
        <button type="button" className="tree-new" onClick={() => void newPage(null)}>
          + New page
        </button>
      </div>
      {loaded && tree.length === 0 ? <p className="muted tree-empty">No pages yet.</p> : null}
      <ul className="tree-root">{tree.map((n) => renderNode(n, 0))}</ul>
    </div>
  );
}

/** Carries out a drop of page `id` relative to another. */
async function dropPage(tree: readonly PageNode[], id: string, drop: Drop): Promise<void> {
  if (drop.targetId === id) return;
  if (drop.where === "inside") {
    await movePage(id, drop.targetId, null);
    return;
  }
  // Beside the target: under the target's parent, before it or before the one after it.
  const find = (list: readonly PageNode[], parent: PageNode | null): { parent: PageNode | null; list: readonly PageNode[] } | null => {
    for (const n of list) {
      if (n.id === drop.targetId) return { parent, list };
      const f = find(n.children, n);
      if (f) return f;
    }
    return null;
  };
  const found = find(tree, null);
  if (!found) return;
  const parentId = found.parent?.id ?? null;
  if (drop.where === "before") {
    await movePage(id, parentId, drop.targetId);
  } else {
    const siblings = found.list.filter((n) => n.id !== id);
    const i = siblings.findIndex((n) => n.id === drop.targetId);
    await movePage(id, parentId, siblings[i + 1]?.id ?? null);
  }
}
