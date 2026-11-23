// ---------------------------------------------------------------------------
// Dragging a block by its handle with a finger (BLK-5). The editor's own
// drag is HTML drag and drop, which a finger can't start in the phone's
// WebView; this follows the finger instead, marks where the block would land
// with a line, scrolls near the edges, and moves the block on release.
// A tap without moving still opens the handle's menu.
// ---------------------------------------------------------------------------

export type Placement = "before" | "after";

/** How far a finger moves before a touch on the handle becomes a drag. */
const SLOP = 8;
/** Within this many pixels of the scroller's top or bottom, it scrolls. */
const EDGE = 64;
/** The most it scrolls per frame there. */
const SPEED = 14;

const HANDLE = '.bn-side-menu [draggable="true"]';

function blockElement(editorId: string): HTMLElement | null {
  const el = document.querySelector(`.bn-editor .bn-block-outer[data-id="${editorId}"]`);
  return el instanceof HTMLElement ? el : null;
}

// Spec: BLK-5
export function installBlockTouchDrag(opts: {
  /** The block the handle is beside (the editor's id). */
  blockOfHandle: () => string | null;
  move: (editorId: string, targetId: string, placement: Placement) => void;
}): () => void {
  let start: { x: number; y: number; id: string } | null = null;
  let dragging = false;
  let lastY = 0;
  let target: { id: string; placement: Placement } | null = null;
  let line: HTMLDivElement | null = null;
  let frame = 0;

  const scroller = () => document.querySelector(".main");

  const findTarget = (y: number) => {
    const editor = document.querySelector(".bn-editor");
    const dragged = start ? blockElement(start.id) : null;
    if (!editor || !dragged || !line) return;
    const r = editor.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(editor).paddingLeft) || 0;
    // Probe inside the text column, whatever the finger's x.
    const hit = document.elementFromPoint(r.left + pad + Math.min(40, (r.width - pad) / 2), y)?.closest(".bn-block-outer[data-id]");
    if (!(hit instanceof HTMLElement) || dragged.contains(hit) || !hit.dataset["id"]) {
      target = null;
      line.style.display = "none";
      return;
    }
    // Halves of the block's own content, not of what's nested in it.
    const own = hit.querySelector(":scope > .bn-block > .bn-block-content") ?? hit;
    const c = own.getBoundingClientRect();
    const placement: Placement = y < c.top + c.height / 2 ? "before" : "after";
    const outer = hit.getBoundingClientRect();
    target = { id: hit.dataset["id"], placement };
    line.style.display = "block";
    line.style.top = `${(placement === "before" ? outer.top : outer.bottom) - 1}px`;
    line.style.left = `${r.left + pad}px`;
    line.style.width = `${r.width - pad}px`;
  };

  // Scrolls while the finger rests near an edge, and keeps the target current.
  const tick = () => {
    frame = 0;
    if (!dragging) return;
    const s = scroller();
    if (s) {
      const r = s.getBoundingClientRect();
      const up = r.top + EDGE - lastY;
      const down = lastY - (r.bottom - EDGE);
      if (up > 0) s.scrollTop -= Math.min(SPEED, up / 3 + 2);
      else if (down > 0) s.scrollTop += Math.min(SPEED, down / 3 + 2);
    }
    findTarget(lastY);
    frame = requestAnimationFrame(tick);
  };

  const finish = () => {
    if (start) blockElement(start.id)?.classList.remove("block-touch-dragged");
    document.documentElement.classList.remove("block-touch-dragging");
    line?.remove();
    line = null;
    cancelAnimationFrame(frame);
    frame = 0;
    start = null;
    dragging = false;
    target = null;
  };

  const onStart = (e: TouchEvent) => {
    const t = e.touches.item(0);
    if (e.touches.length !== 1 || !t || !(e.target instanceof Element) || !e.target.closest(HANDLE)) return;
    const id = opts.blockOfHandle();
    start = id ? { x: t.clientX, y: t.clientY, id } : null;
  };

  const onMove = (e: TouchEvent) => {
    const t = e.touches.item(0);
    if (!start || !t) return;
    if (!dragging) {
      if (Math.hypot(t.clientX - start.x, t.clientY - start.y) < SLOP) return;
      dragging = true;
      document.documentElement.classList.add("block-touch-dragging");
      blockElement(start.id)?.classList.add("block-touch-dragged");
      line = document.createElement("div");
      line.className = "block-drop-line";
      document.body.appendChild(line);
      frame = requestAnimationFrame(tick);
    }
    if (e.cancelable) e.preventDefault();
    lastY = t.clientY;
  };

  const onEnd = (e: TouchEvent) => {
    if (!start) return;
    if (dragging) {
      // No click after a drag: it would open the handle's menu.
      if (e.cancelable) e.preventDefault();
      const s = start;
      const to = target;
      finish();
      if (e.type === "touchend" && to && to.id !== s.id) opts.move(s.id, to.id, to.placement);
      return;
    }
    start = null;
  };

  document.addEventListener("touchstart", onStart, { capture: true, passive: true });
  document.addEventListener("touchmove", onMove, { capture: true, passive: false });
  document.addEventListener("touchend", onEnd, { capture: true, passive: false });
  document.addEventListener("touchcancel", onEnd, { capture: true, passive: false });
  return () => {
    finish();
    document.removeEventListener("touchstart", onStart, { capture: true });
    document.removeEventListener("touchmove", onMove, { capture: true });
    document.removeEventListener("touchend", onEnd, { capture: true });
    document.removeEventListener("touchcancel", onEnd, { capture: true });
  };
}
