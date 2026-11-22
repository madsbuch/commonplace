import { useEffect, useRef, useState } from "react";
import { openPdf, type OpenPdf, type PdfDocument } from "../lib/pdf";
import { setPdfInView } from "../lib/currentView";

/** How far outside the view a page starts rendering, so scrolling finds it drawn. */
const RENDER_MARGIN = "1200px 0px";
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;

interface PageSize {
  width: number;
  height: number;
}

/** One page: a placeholder of the right size, drawn when it comes near the view. */
function PdfPage(props: { doc: PdfDocument; number: number; scale: number; size: PageSize; onVisible: (n: number) => void }) {
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  const { doc, number, scale, onVisible } = props;

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => setNear(entries.some((e) => e.isIntersecting)), { rootMargin: RENDER_MARGIN });
    const seen = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) onVisible(number);
    }, { threshold: 0.5 });
    io.observe(el);
    seen.observe(el);
    return () => {
      io.disconnect();
      seen.disconnect();
    };
  }, [number, onVisible]);

  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    let cancel: (() => void) | null = null;
    void (async () => {
      const page = await doc.getPage(number);
      const c = canvas.current;
      if (cancelled || !c) return;
      const ratio = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: scale * ratio });
      c.width = Math.floor(viewport.width);
      c.height = Math.floor(viewport.height);
      const task = page.render({ canvas: c, viewport });
      cancel = () => task.cancel();
      await task.promise.catch(() => undefined);
    })();
    return () => {
      cancelled = true;
      cancel?.();
    };
  }, [near, doc, number, scale]);

  return (
    <div
      ref={holder}
      className="pdf-page"
      data-page={number}
      style={{ width: props.size.width * scale, height: props.size.height * scale }}
    >
      {near ? <canvas ref={canvas} style={{ width: "100%", height: "100%" }} /> : null}
    </div>
  );
}

// Spec: LIB-6
/**
 * A PDF, page under page, drawn with pdf.js as pages come into view. Zoom is
 * relative to the width of the view: 1 fits a page to it.
 */
export function PdfViewer(props: { load: () => Promise<Uint8Array>; itemId?: string }) {
  const [pdf, setPdf] = useState<OpenPdf | null>(null);
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(0);
  const [current, setCurrent] = useState(1);
  const scroller = useRef<HTMLDivElement>(null);
  const { load, itemId } = props;

  // Spec: ATL-1
  // Tell the assistant which page of which PDF is in view.
  useEffect(() => {
    if (!pdf || !itemId) return;
    setPdfInView({ itemId, page: current, doc: pdf.doc });
  }, [pdf, itemId, current]);
  useEffect(() => () => setPdfInView(null), []);

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
        // Every page's own size (at scale 1), for placeholders that don't jump.
        const out: PageSize[] = [];
        for (let n = 1; n <= opened.doc.numPages; n++) {
          const v = (await opened.doc.getPage(n)).getViewport({ scale: 1 });
          out.push({ width: v.width, height: v.height });
        }
        if (!live) return;
        setSizes(out);
        setPdf(opened);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
      opened?.close();
    };
  }, [load]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [pdf]);

  if (error) return <p className="pdf-error">This PDF couldn't be opened: {error}</p>;

  const widest = sizes.reduce((m, s) => Math.max(m, s.width), 0) || 612;
  const fit = width > 0 ? Math.max((width - 32) / widest, 0.1) : 1;
  const scale = fit * zoom;
  const step = (f: number) => setZoom((z) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(z * f * 100) / 100)));

  return (
    <div className="pdf-viewer">
      <div className="pdf-toolbar">
        <span className="muted">{pdf ? `Page ${current} of ${pdf.doc.numPages}` : "Opening…"}</span>
        <div className="pdf-zoom">
          <button type="button" aria-label="Zoom out" onClick={() => step(1 / 1.2)}>
            −
          </button>
          <button type="button" onClick={() => setZoom(1)}>
            {Math.round(zoom * 100)}%
          </button>
          <button type="button" aria-label="Zoom in" onClick={() => step(1.2)}>
            +
          </button>
        </div>
      </div>
      <div className="pdf-pages" ref={scroller}>
        {pdf
          ? sizes.map((size, i) => (
              <PdfPage key={i} doc={pdf.doc} number={i + 1} scale={scale} size={size} onVisible={setCurrent} />
            ))
          : null}
      </div>
    </div>
  );
}
