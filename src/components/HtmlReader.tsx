// ---------------------------------------------------------------------------
// An item's HTML version, read as text that fits the screen (LIB-25): made
// safe again as it's shown, its sections handed up as contents, the section
// at the top of the view kept in the address (LIB-26) and told to the
// assistant (ATL-10). Links within the paper move within it; links out open
// in the system browser.
// ---------------------------------------------------------------------------

import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { replaceFragment } from "../lib/address";
import { setHtmlInView } from "../lib/currentView";
import { sanitizePaper, sectionsOf } from "../lib/paperHtml";
import type { TocEntry } from "../lib/schemas";

function anchors(toc: readonly TocEntry[], out: string[] = []): string[] {
  for (const e of toc) {
    if (e.anchor) out.push(e.anchor);
    anchors(e.children, out);
  }
  return out;
}

// Spec: LIB-25, LIB-26, ATL-10
export function HtmlReader(props: {
  itemId: string;
  html: string;
  /** The section to open at (the address's). */
  initialAnchor: string | null;
  /** A section to go to; `seq` makes going to the same one twice a new request. */
  jump: { anchor: string; seq: number } | null;
  onContents: (toc: TocEntry[]) => void;
  onSection: (anchor: string | null) => void;
}) {
  const { itemId, initialAnchor, jump, onContents, onSection } = props;
  const safe = useMemo(() => sanitizePaper(props.html), [props.html]);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLElement>(null);
  const order = useRef<string[]>([]);
  const current = useRef<string | null>(null);

  const find = (anchor: string): Element | null => content.current?.querySelector(`[id="${CSS.escape(anchor)}"]`) ?? null;
  const goTo = (anchor: string) => find(anchor)?.scrollIntoView({ block: "start" });

  // The contents, and the place to open at, once the text is laid out.
  useLayoutEffect(() => {
    const root = content.current;
    if (!root) return;
    const toc = sectionsOf(root);
    order.current = anchors(toc);
    onContents(toc);
    if (initialAnchor) goTo(initialAnchor);
    // Opening counts once: later moves come by `jump`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [safe]);

  useEffect(() => {
    if (jump) goTo(jump.anchor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump]);

  useEffect(() => () => setHtmlInView(null), []);

  // The section at the top of the view: in the address, the contents and the assistant's view.
  const frame = useRef(0);
  const onScroll = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const s = scroller.current;
      if (!s) return;
      const line = s.getBoundingClientRect().top + 12;
      let at: string | null = null;
      for (const a of order.current) {
        const el = find(a);
        if (el && el.getBoundingClientRect().top <= line) at = a;
      }
      if (s.scrollTop < 20) at = null;
      if (at === current.current) return;
      current.current = at;
      onSection(at);
      setHtmlInView({ itemId, anchor: at });
      replaceFragment(at ?? "");
    });
  };
  useEffect(() => setHtmlInView({ itemId, anchor: current.current }), [itemId]);

  return (
    <div className="html-pages" ref={scroller} onScroll={onScroll}>
      <article
        className="html-reader"
        ref={content}
        dangerouslySetInnerHTML={{ __html: safe }}
        onClick={(e) => {
          const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
          const href = a?.getAttribute("href") ?? "";
          if (!a) return;
          e.preventDefault();
          if (href.startsWith("#")) goTo(decodeURIComponent(href.slice(1)));
          else if (/^https?:\/\//.test(href)) void openUrl(href);
        }}
      />
    </div>
  );
}
