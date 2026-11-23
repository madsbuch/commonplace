import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { openPdf, renderTextLayer, type OpenPdf, type PdfDocument } from "../lib/pdf";
import { replaceFragment } from "../lib/address";
import { setPdfInView } from "../lib/currentView";

/** How far outside the view a page starts rendering, so scrolling finds it drawn. */
const RENDER_MARGIN = "1200px 0px";
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 5;
// Spec: LIB-18
/** `pdf.double-tap-zoom` in the spec. */
export const DOUBLE_TAP_ZOOM = 2;
/** The most pixels one page's canvas gets: zoomed far in, it draws at a lower density instead of running a phone out of memory. */
const MAX_CANVAS_PIXELS = 12_000_000;
const DOUBLE_TAP_MS = 300;
const PHONE = "(max-width: 760px)";

interface PageSize {
  width: number;
  height: number;
}

const isPhone = () => typeof window.matchMedia === "function" && window.matchMedia(PHONE).matches;

// Spec: LIB-20
const PAGE_KEY = (itemId: string) => `pdf-page:${itemId}`;
function lastPage(itemId: string | undefined): number | null {
  if (!itemId) return null;
  try {
    const n = Number(localStorage.getItem(PAGE_KEY(itemId)));
    return Number.isInteger(n) && n > 1 ? n : null;
  } catch {
    return null;
  }
}
function rememberPage(itemId: string | undefined, page: number): void {
  if (!itemId) return;
  try {
    localStorage.setItem(PAGE_KEY(itemId), String(page));
  } catch {
    // A convenience only.
  }
}

/** One page: a placeholder of the right size, drawn when it comes near the view. */
function PdfPage(props: { doc: PdfDocument; number: number; scale: number; size: PageSize; onSize: (n: number, s: PageSize) => void }) {
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const { doc, number, scale, onSize } = props;

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => setNear(entries.some((e) => e.isIntersecting)), { rootMargin: RENDER_MARGIN });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    let cancel: (() => void) | null = null;
    void (async () => {
      const page = await doc.getPage(number);
      // Spec: LIB-17
      // Its real size, now that it's read (the placeholder assumed page 1's).
      const base = page.getViewport({ scale: 1 });
      onSize(number, { width: base.width, height: base.height });
      const c = canvas.current;
      if (cancelled || !c) return;
      const cssPixels = base.width * base.height * scale * scale;
      const ratio = Math.min(window.devicePixelRatio || 1, Math.sqrt(MAX_CANVAS_PIXELS / Math.max(cssPixels, 1)));
      const viewport = page.getViewport({ scale: scale * ratio });
      c.width = Math.floor(viewport.width);
      c.height = Math.floor(viewport.height);
      const task = page.render({ canvas: c, viewport });
      cancel = () => task.cancel();
      await task.promise.catch(() => undefined);
      // Spec: LIB-13, ATL-6
      // The page's text over the picture, so it can be selected and copied.
      const layer = text.current;
      if (cancelled || !layer) return;
      const stop = await renderTextLayer(page, page.getViewport({ scale }), layer);
      cancel = () => {
        task.cancel();
        stop();
      };
    })();
    return () => {
      cancelled = true;
      cancel?.();
    };
  }, [near, doc, number, scale, onSize]);

  return (
    <div ref={holder} className="pdf-page" data-page={number} style={{ width: props.size.width * scale, height: props.size.height * scale }}>
      {near ? <canvas ref={canvas} style={{ width: "100%", height: "100%" }} /> : null}
      {near ? <div ref={text} className="textLayer" /> : null}
    </div>
  );
}

/** Where to keep still while zooming: a point on screen (in the scroller) and the content under it. */
interface Anchor {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  k: number;
}

// Spec: LIB-6, LIB-17, LIB-18, LIB-19, LIB-20, LIB-21
/**
 * A PDF, page under page, drawn with pdf.js as pages come near the view.
 * Zoom is relative to the width of the view (1 fits a page to it): pinch,
 * double-tap, Ctrl/⌘ + wheel, or the buttons. On a phone, scrolling down
 * hides the controls around it (`pdf-reading` on <html>), and scrolling up or
 * a tap brings them back.
 */
export function PdfViewer(props: {
  load: () => Promise<Uint8Array>;
  itemId?: string;
  /** Told the open document once it's open (for its outline). */
  onOpen?: (doc: PdfDocument) => void;
  /** Told the page in view as it changes. */
  onPage?: (page: number) => void;
  /** A page to go to; `seq` makes going to the same page twice a new request. */
  jump?: { page: number; seq: number } | null;
  /** The page to open at (the address's); without one, the page last read here. */
  initialPage?: number | null;
  /** Shown at the start of the toolbar (the contents button). */
  toolbarStart?: ReactNode;
}) {
  const [pdf, setPdf] = useState<OpenPdf | null>(null);
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(0);
  const [current, setCurrent] = useState(1);
  const [reading, setReading] = useState(false);
  const [goTo, setGoTo] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stack = useRef<HTMLDivElement>(null);
  const anchor = useRef<Anchor | null>(null);
  const restore = useRef<number | null>(null);
  const { load, itemId, onOpen, onPage, jump, initialPage } = props;

  // Spec: ATL-1
  // Tell the assistant which page of which PDF is in view.
  useEffect(() => {
    if (!pdf || !itemId) return;
    setPdfInView({ itemId, page: current, doc: pdf.doc });
  }, [pdf, itemId, current]);
  useEffect(() => () => setPdfInView(null), []);

  useEffect(() => {
    if (pdf) onOpen?.(pdf.doc);
  }, [pdf, onOpen]);
  useEffect(() => {
    onPage?.(current);
  }, [current, onPage]);

  // Open the PDF; every page starts out the size of page 1 until it's read.
  useEffect(() => {
    let live = true;
    let opened: OpenPdf | null = null;
    setPdf(null);
    setError(null);
    void (async () => {
      try {
        opened = await openPdf(await load());
        if (!live) {
          opened.close();
          return;
        }
        const first = (await opened.doc.getPage(1)).getViewport({ scale: 1 });
        if (!live) return;
        // Spec: LIB-20, LIB-22
        restore.current = initialPage ?? lastPage(itemId);
        setSizes(Array.from({ length: opened.doc.numPages }, () => ({ width: first.width, height: first.height })));
        setPdf(opened);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
      opened?.close();
    };
    // The page to open at counts once, when the PDF opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, itemId]);

  const onSize = useCallback((n: number, s: PageSize) => {
    setSizes((prev) => {
      const old = prev[n - 1];
      if (!old || (Math.abs(old.width - s.width) < 0.5 && Math.abs(old.height - s.height) < 0.5)) return prev;
      const next = [...prev];
      next[n - 1] = s;
      return next;
    });
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [pdf]);

  const scrollToPage = useCallback((n: number) => {
    const el = scroller.current?.querySelector(`[data-page="${n}"]`);
    if (el instanceof HTMLElement) el.scrollIntoView({ block: "start" });
  }, []);

  // Spec: LIB-20
  // Back to the page last read, once the pages are laid out.
  useLayoutEffect(() => {
    const n = restore.current;
    if (!pdf || width === 0 || n === null) return;
    restore.current = null;
    scrollToPage(Math.min(n, pdf.doc.numPages));
  }, [pdf, width, scrollToPage]);

  // Spec: LIB-15
  useEffect(() => {
    if (jump && pdf) scrollToPage(jump.page);
  }, [jump, pdf, scrollToPage]);

  const lastTop = useRef(0);
  const ignoreScroll = useRef(0);
  const frame = useRef(0);

  // Keep the point under the fingers (or pointer) still across a zoom; the
  // scroll that takes isn't reading down, so it leaves the controls be.
  useLayoutEffect(() => {
    const a = anchor.current;
    const s = scroller.current;
    if (!a || !s) return;
    anchor.current = null;
    s.scrollLeft = a.cx * a.k - a.fx;
    s.scrollTop = a.cy * a.k - a.fy;
    lastTop.current = s.scrollTop;
    ignoreScroll.current = Date.now();
  }, [zoom]);

  const zoomTo = useCallback(
    (next: number, fx?: number, fy?: number) => {
      const s = scroller.current;
      const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
      if (s && z !== zoom) {
        const x = fx ?? s.clientWidth / 2;
        const y = fy ?? s.clientHeight / 2;
        anchor.current = { fx: x, fy: y, cx: s.scrollLeft + x, cy: s.scrollTop + y, k: z / zoom };
      }
      setZoom(z);
    },
    [zoom],
  );

  // Spec: LIB-19
  /** Hides or shows what's around the PDF, keeping the page where it is on screen. */
  const showChrome = useCallback((show: boolean) => {
    const s = scroller.current;
    const root = document.documentElement;
    if (!s || root.classList.contains("pdf-reading") === !show) return;
    const before = s.getBoundingClientRect().top;
    root.classList.toggle("pdf-reading", !show);
    const after = s.getBoundingClientRect().top;
    s.scrollTop += after - before;
    lastTop.current = s.scrollTop;
    ignoreScroll.current = Date.now();
    setReading(!show);
  }, []);
  useEffect(() => () => document.documentElement.classList.remove("pdf-reading"), []);

  // The page in view (the one at the middle of the scroller), and hiding the controls while reading down.
  const onScroll = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const s = scroller.current;
      if (!s) return;
      const r = s.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const n = Number(hit?.closest(".pdf-page")?.getAttribute("data-page") ?? NaN);
      if (Number.isInteger(n)) {
        setCurrent(n);
        // Spec: LIB-20, LIB-22
        // Only what scrolling showed is remembered, so opening never overwrites it with page 1.
        rememberPage(itemId, n);
        if (itemId) replaceFragment(n > 1 ? `page=${n}` : "");
      }
      const dy = s.scrollTop - lastTop.current;
      lastTop.current = s.scrollTop;
      if (!isPhone() || Date.now() - ignoreScroll.current < 150) return;
      if (dy > 12 && s.scrollTop > 60) showChrome(false);
      else if (dy < -12) showChrome(true);
    });
  };

  // Spec: LIB-18
  // Ctrl/⌘ + wheel (and a trackpad's pinch, which arrives as one) zooms at the pointer.
  useEffect(() => {
    const s = scroller.current;
    if (!s) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = s.getBoundingClientRect();
      zoomTo(zoom * Math.exp(-e.deltaY / 300), e.clientX - r.left, e.clientY - r.top);
    };
    s.addEventListener("wheel", onWheel, { passive: false });
    return () => s.removeEventListener("wheel", onWheel);
  }, [zoom, zoomTo, pdf]);

  // Spec: LIB-18, LIB-19
  // Pinch (two fingers), double tap and single tap, from touch events that
  // can be cancelled (as pdf.js does): two fingers never become the WebView's
  // own pan, while one finger scrolls natively.
  const pinch = useRef<{ dist: number; fx: number; fy: number; cx: number; cy: number; g: number } | null>(null);
  const tap = useRef<{ x: number; y: number; at: number; moved: boolean } | null>(null);
  const lastTap = useRef<{ x: number; y: number; at: number } | null>(null);
  const singleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (singleTimer.current) clearTimeout(singleTimer.current);
  }, []);

  useEffect(() => {
    const s = scroller.current;
    if (!s) return;
    const local = (x: number, y: number) => {
      const r = s.getBoundingClientRect();
      return { x: x - r.left, y: y - r.top };
    };
    const two = (e: TouchEvent) => {
      const a = e.touches.item(0);
      const b = e.touches.item(1);
      return a && b ? { a, b, dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) } : null;
    };
    const onStart = (e: TouchEvent) => {
      const pair = two(e);
      if (pair) {
        e.preventDefault();
        const mid = local((pair.a.clientX + pair.b.clientX) / 2, (pair.a.clientY + pair.b.clientY) / 2);
        pinch.current = { dist: pair.dist || 1, fx: mid.x, fy: mid.y, cx: s.scrollLeft + mid.x, cy: s.scrollTop + mid.y, g: 1 };
        tap.current = null;
        return;
      }
      const one = e.touches.item(0);
      tap.current = e.touches.length === 1 && one ? { x: one.clientX, y: one.clientY, at: Date.now(), moved: false } : null;
    };
    const onMove = (e: TouchEvent) => {
      const t = tap.current;
      const one = e.touches.item(0);
      if (t && one && Math.hypot(one.clientX - t.x, one.clientY - t.y) > 10) t.moved = true;
      const p = pinch.current;
      const pair = two(e);
      const st = stack.current;
      if (!p || !pair || !st) return;
      e.preventDefault();
      const g = Math.min(MAX_ZOOM / zoom, Math.max(MIN_ZOOM / zoom, pair.dist / p.dist));
      p.g = g;
      // While the fingers move, scale what's drawn; the pages re-draw sharp when they let go.
      st.style.transformOrigin = `${p.cx}px ${p.cy}px`;
      st.style.transform = `scale(${g})`;
    };
    const onEnd = (e: TouchEvent) => {
      const p = pinch.current;
      if (p) {
        if (e.touches.length < 2) {
          pinch.current = null;
          const st = stack.current;
          if (st) st.style.transform = "";
          const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * p.g));
          if (z !== zoom) {
            anchor.current = { fx: p.fx, fy: p.fy, cx: p.cx, cy: p.cy, k: z / zoom };
            setZoom(z);
          }
        }
        return;
      }
      const t = tap.current;
      tap.current = null;
      // A scroll the browser took over ends in touchcancel: not a tap.
      if (!t || t.moved || e.type === "touchcancel" || e.touches.length > 0 || Date.now() - t.at > 400) return;
      const prev = lastTap.current;
      const now = Date.now();
      if (prev && now - prev.at < DOUBLE_TAP_MS && Math.hypot(prev.x - t.x, prev.y - t.y) < 40) {
        lastTap.current = null;
        if (singleTimer.current) clearTimeout(singleTimer.current);
        if (e.cancelable) e.preventDefault();
        const at = local(t.x, t.y);
        zoomTo(zoom > 1.05 ? 1 : DOUBLE_TAP_ZOOM, at.x, at.y);
        return;
      }
      lastTap.current = { x: t.x, y: t.y, at: now };
      if (singleTimer.current) clearTimeout(singleTimer.current);
      singleTimer.current = setTimeout(() => {
        // A single tap on a phone brings the controls back, or puts them away.
        if (isPhone() && !window.getSelection()?.toString()) showChrome(document.documentElement.classList.contains("pdf-reading"));
      }, DOUBLE_TAP_MS);
    };
    s.addEventListener("touchstart", onStart, { passive: false });
    s.addEventListener("touchmove", onMove, { passive: false });
    s.addEventListener("touchend", onEnd);
    s.addEventListener("touchcancel", onEnd);
    return () => {
      s.removeEventListener("touchstart", onStart);
      s.removeEventListener("touchmove", onMove);
      s.removeEventListener("touchend", onEnd);
      s.removeEventListener("touchcancel", onEnd);
    };
  }, [zoom, zoomTo, showChrome, pdf]);

  if (error) return <p className="pdf-error">This PDF couldn't be opened: {error}</p>;

  const widest = sizes.reduce((m, s) => Math.max(m, s.width), 0) || 612;
  const fit = width > 0 ? Math.max((width - (isPhone() ? 16 : 32)) / widest, 0.1) : 1;
  const scale = fit * zoom;
  const step = (f: number) => zoomTo(Math.round(zoom * f * 100) / 100);
  const total = pdf?.doc.numPages ?? 0;

  return (
    <div className="pdf-viewer">
      <div className="pdf-toolbar">
        {props.toolbarStart ? <div className="pdf-toolbar-start">{props.toolbarStart}</div> : null}
        {/* Spec: LIB-21 */}
        {goTo !== null ? (
          <form
            className="pdf-goto"
            onSubmit={(e) => {
              e.preventDefault();
              const n = Number(goTo);
              setGoTo(null);
              if (Number.isInteger(n) && n >= 1 && n <= total) scrollToPage(n);
            }}
          >
            <input
              autoFocus
              inputMode="numeric"
              aria-label="Go to page"
              value={goTo}
              onChange={(e) => setGoTo(e.target.value.replace(/[^0-9]/g, ""))}
              onBlur={() => setGoTo(null)}
            />
            <span className="muted">/ {total}</span>
          </form>
        ) : (
          <button type="button" className="pdf-page-count" title="Go to a page" disabled={!pdf} onClick={() => setGoTo(String(current))}>
            {pdf ? `${current} / ${total}` : "Opening…"}
          </button>
        )}
        <div className="pdf-zoom">
          <button type="button" className="pdf-zoom-step" aria-label="Zoom out" onClick={() => step(1 / 1.2)}>
            −
          </button>
          <button type="button" className={zoom === 1 ? "pdf-zoom-fit at-fit" : "pdf-zoom-fit"} title="Fit the width" onClick={() => zoomTo(1)}>
            {zoom === 1 ? "100%" : `${Math.round(zoom * 100)}% · Fit`}
          </button>
          <button type="button" className="pdf-zoom-step" aria-label="Zoom in" onClick={() => step(1.2)}>
            +
          </button>
        </div>
      </div>
      <div
        className="pdf-pages"
        ref={scroller}
        onScroll={onScroll}
      >
        <div className="pdf-stack" ref={stack}>
          {pdf ? sizes.map((size, i) => <PdfPage key={i} doc={pdf.doc} number={i + 1} scale={scale} size={size} onSize={onSize} />) : null}
        </div>
      </div>
      {reading && pdf ? (
        <div className="pdf-pill" aria-hidden>
          {current} / {total}
        </div>
      ) : null}
    </div>
  );
}
