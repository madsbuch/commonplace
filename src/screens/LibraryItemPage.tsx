import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { pageOfFragment, useQueryParam } from "../lib/address";
import { AuthorsEditor } from "../components/AuthorsEditor";
import { InfoButton } from "../components/InfoButton";
import { Contents } from "../components/Contents";
import { HtmlReader } from "../components/HtmlReader";
import { MoreMenu } from "../components/MoreMenu";
import { refetchArxivHtml } from "../lib/arxiv";
import { PdfViewer } from "../components/PdfViewer";
import { pdfOutline, type PdfDocument } from "../lib/pdf";
import { readDetails, useDetailsStatus } from "../lib/libraryDetails";
import { getItem, hasFile, hasHtml, isKind, KIND_NAMES, KINDS, LIBRARY_TABLES, readFile, readHtml, removeItem, saveToc, updateItem, type LibraryItem } from "../lib/library";
import type { TocEntry } from "../lib/schemas";
import { useTablesVersion } from "../lib/live";
import { beginningEntry, chapterAt, flatContents, listenEntries } from "../lib/audioModel";
import { listenFrom, makeSection, useReading } from "../lib/listening";
import { usePlayer } from "../lib/player";
import { errorMessage } from "../lib/openrouter";
import { note } from "../lib/diagnostics";
import { hostOf } from "../lib/webModel";
import { openUrl } from "@tauri-apps/plugin-opener";


/** Whether the text follows the section being heard (AUD-19), per device. */
const FOLLOW_KEY = "follow-audio";

/** The details form: saved when a field is left. */
function Details(props: { item: LibraryItem }) {
  const { item } = props;
  const [title, setTitle] = useState(item.title);
  const [year, setYear] = useState(item.year === null ? "" : String(item.year));

  useEffect(() => {
    setTitle(item.title);
    setYear(item.year === null ? "" : String(item.year));
  }, [item.title, item.year]);

  const parsedYear = (): number | null => {
    const n = Number(year.trim());
    return year.trim() !== "" && Number.isInteger(n) ? n : null;
  };

  return (
    <div className="library-details">
      <label>
        <span>Title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => void updateItem(item.id, { title })} />
      </label>
      <div className="library-details-row">
        <label>
          <span>Year</span>
          <input
            inputMode="numeric"
            value={year}
            placeholder="—"
            onChange={(e) => setYear(e.target.value.replace(/[^0-9]/g, "").slice(0, 4))}
            onBlur={() => void updateItem(item.id, { year: parsedYear() })}
          />
        </label>
        <label>
          <span>Kind</span>
          <select
            value={item.kind}
            onChange={(e) => {
              const kind = e.target.value;
              if (isKind(kind)) void updateItem(item.id, { kind });
            }}
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_NAMES[k]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <AuthorsEditor itemId={item.id} editing />
    </div>
  );
}

// Spec: APP-9, LIB-4, LIB-9, LIB-11
/** Where the details come from, behind an ⓘ that also shows whether a model is reading them. */
function DetailsInfo(props: { itemId: string }) {
  const status = useDetailsStatus(props.itemId);
  const tone = status?.state === "reading" ? "busy" : status?.state === "failed" ? "warning" : undefined;
  return (
    <InfoButton title="Where these details come from" {...(tone ? { tone } : {})}>
      {status?.state === "reading" ? <p>A model is reading the details now.</p> : null}
      {status?.state === "failed" ? (
        <p className="info-error">
          Reading the details failed: {status.message}{" "}
          <button type="button" className="ai-link" onClick={() => void readDetails(props.itemId)}>
            Try again
          </button>
        </p>
      ) : null}
      {status?.state === "no-key" ? (
        <p>
          These came from the PDF itself, as there's no OpenRouter key yet. <Link to="/settings/ai">Add one in Settings</Link>, then
          choose Read details again under Details.
        </p>
      ) : null}
      <p>
        When a PDF is added, a model reads its first pages for the title, the authors and their institutions, the year and
        whether it's a paper or a book. Without a key, or if that fails, the PDF's own metadata is used.
      </p>
      <p>Change any of it under Details. Read details again there asks the model again and replaces what's shown.</p>
    </InfoButton>
  );
}

const CONTENTS_KEY = "library-contents-open";

/** Whether the contents were open last time, on this device (on a phone they start closed). */
function contentsWanted(): boolean {
  try {
    return localStorage.getItem(CONTENTS_KEY) !== "0" && !window.matchMedia("(max-width: 760px)").matches;
  } catch {
    return false;
  }
}

function rememberContents(open: boolean): void {
  try {
    localStorage.setItem(CONTENTS_KEY, open ? "1" : "0");
  } catch {
    // A convenience only.
  }
}

// Spec: LIB-5, LIB-6, LIB-8, LIB-11
/** One paper or book: its details, editable, and its PDF. */
export default function LibraryItemPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const version = useTablesVersion(LIBRARY_TABLES);
  const [item, setItem] = useState<LibraryItem | null | "missing">(null);
  const [fileHere, setFileHere] = useState<boolean | null>(null);
  const [htmlHere, setHtmlHere] = useState<boolean | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [showContents, setShowContents] = useState(contentsWanted);
  const [page, setPage] = useState(1);
  const [jump, setJump] = useState<{ itemId: string; page: number; seq: number } | null>(null);

  // Spec: LIB-22, APP-10
  // The address names the page to open at; a later navigation (a link to
  // another page of it, Back) goes there. Scrolling writes the address past
  // the router, so the router's changes are always navigations.
  const location = useLocation();
  const anchorOf = (hash: string) => (hash.length > 1 && pageOfFragment(hash) === null ? decodeURIComponent(hash.slice(1)) : null);
  const [start, setStart] = useState(() => ({ id, key: location.key, page: pageOfFragment(location.hash), anchor: anchorOf(location.hash) }));
  if (start.id !== id) setStart({ id, key: location.key, page: pageOfFragment(location.hash), anchor: anchorOf(location.hash) });
  const [htmlJump, setHtmlJump] = useState<{ itemId: string; anchor: string; seq: number } | null>(null);
  useEffect(() => {
    if (location.key === start.key) return;
    const p = pageOfFragment(location.hash);
    if (p !== null) setJump((j) => ({ itemId: id, page: p, seq: (j?.seq ?? 0) + 1 }));
    const a = anchorOf(location.hash);
    if (a !== null) setHtmlJump((j) => ({ itemId: id, anchor: a, seq: (j?.seq ?? 0) + 1 }));
  }, [location.key, location.hash, start.key, id]);

  useEffect(() => {
    let live = true;
    void Promise.all([getItem(id), hasFile(id), hasHtml(id)]).then(([i, f, h]) => {
      if (!live) return;
      setItem(i ?? "missing");
      setFileHere(f);
      setHtmlHere(h);
    });
    return () => {
      live = false;
    };
  }, [id, version]);

  // Spec: LIB-25, LIB-26
  // Text or PDF: the address says; otherwise a phone reads text, a computer the PDF.
  const [viewParam, setView] = useQueryParam("view");
  const phone = window.matchMedia("(max-width: 760px)").matches;
  const hasPdf = fileHere === true || (item !== null && item !== "missing" && item.pages !== null);
  const view: "text" | "pdf" =
    htmlHere && (viewParam === "text" || (viewParam !== "pdf" && (phone || !hasPdf))) ? "text" : hasPdf || !htmlHere ? "pdf" : "text";
  const [html, setHtml] = useState<{ id: string; html: string } | null>(null);
  useEffect(() => {
    let live = true;
    if (view === "text" && htmlHere)
      void readHtml(id).then((h) => {
        if (live && h !== null) setHtml({ id, html: h });
      });
    return () => {
      live = false;
    };
  }, [id, view, htmlHere, version]);
  const [htmlToc, setHtmlToc] = useState<TocEntry[]>([]);
  const [section, setSection] = useState<string | null>(null);

  const load = useCallback(() => readFile(id), [id]);

  // Spec: LIB-16
  // An item added before contents were taken gets them the first time its PDF opens.
  const needsToc = item !== null && item !== "missing" && item.toc === null;
  const onOpen = useCallback(
    (doc: PdfDocument) => {
      if (needsToc) void pdfOutline(doc).then((toc) => saveToc(id, toc));
    },
    [id, needsToc],
  );
  const pdfToc = item !== null && item !== "missing" ? item.toc : null;
  const toc = useMemo(() => (view === "text" ? htmlToc : (pdfToc ?? [])), [view, htmlToc, pdfToc]);

  // Spec: AUD-2, AUD-18, AUD-19
  // Listening from the contents: what each section is in the item's reading, the one being heard, and following it.
  const reading = useReading(id);
  const player = usePlayer();
  const script = reading.rec?.durationSeconds === null ? reading.rec.script : null;
  const entries = useMemo(() => listenEntries(toc, script, reading.made), [toc, script, reading.made]);
  const heard = reading.rec !== null && player.recordingId === reading.rec.id ? (player.chapterMade?.[chapterAt(player.chapters, player.position)]?.key ?? null) : null;
  const [starting, setStarting] = useState<string | null>(null);
  const [making, setMaking] = useState<ReadonlySet<string>>(new Set());
  const [follow, setFollow] = useState(() => {
    try {
      return localStorage.getItem(FOLLOW_KEY) === "1";
    } catch {
      return false;
    }
  });
  const chooseFollow = (on: boolean) => {
    setFollow(on);
    try {
      localStorage.setItem(FOLLOW_KEY, on ? "1" : "0");
    } catch {
      // A convenience only.
    }
  };
  // Spec: AUD-19
  // Following, the text goes to the section heard as it changes; scrolling it stops that.
  const following = follow && heard !== null && (player.playing || player.waiting);
  useEffect(() => {
    if (!following || heard === null) return;
    if (heard === "front") {
      if (view === "text") setHtmlJump((j) => ({ itemId: id, anchor: "", seq: (j?.seq ?? 0) + 1 }));
      else setJump((j) => ({ itemId: id, page: 1, seq: (j?.seq ?? 0) + 1 }));
      return;
    }
    const at = entries.findIndex((e) => e?.key === heard);
    const f = flatContents(toc)[at];
    if (!f) return;
    const anchor = f.entry.anchor;
    const p = f.entry.page;
    if (view === "text" && anchor) setHtmlJump((j) => ({ itemId: id, anchor, seq: (j?.seq ?? 0) + 1 }));
    else if (p !== null) setJump((j) => ({ itemId: id, page: p, seq: (j?.seq ?? 0) + 1 }));
    // Each section heard is gone to once; the contents and view settle in between.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heard, following]);
  const stopFollowing = () => {
    if (follow) setFollow(false);
  };
  const listening = {
    entries,
    beginning: beginningEntry(script, reading.made),
    hearing: heard,
    busy: starting,
    waiting: heard !== null && (player.waiting || player.loading),
    making,
    onListen: (key: string, title: string) => {
      setStarting(key);
      void listenFrom(id, { key, title })
        .catch((e: unknown) => note("error", "audio", `Listening from “${title}” failed: ${errorMessage(e)}`))
        .finally(() => setStarting(null));
    },
    onMake: (key: string, title: string) => {
      setMaking((s) => new Set([...s, key]));
      void makeSection(id, key, title).catch((e: unknown) => note("error", "audio", `Making “${title}” failed: ${errorMessage(e)}`));
    },
    onBeginning: () => {
      if (view === "text") setHtmlJump((j) => ({ itemId: id, anchor: "", seq: (j?.seq ?? 0) + 1 }));
      else setJump((j) => ({ itemId: id, page: 1, seq: (j?.seq ?? 0) + 1 }));
    },
  };
  // Spec: AUD-2
  // The contents are where listening starts, so every item has them: one without sections, its Beginning alone.
  const hasContents = toc.length > 0 || listening.beginning !== null;
  const toggleContents = () =>
    setShowContents((s) => {
      rememberContents(!s);
      return !s;
    });

  // Spec: LIB-15, LIB-25
  const contentsPanel = (
    <aside className="toc-panel" aria-label="Contents">
      <div className="toc-head">
        <strong>Contents</strong>
        {/* Spec: AUD-20 */}
        {starting !== null || listening.waiting ? (
          <span className="toc-status" role="status">
            {starting !== null ? "Getting ready…" : "Making this part…"}
          </span>
        ) : null}
        {/* Spec: AUD-19 */}
        {heard !== null ? (
          <button type="button" className="toc-follow" aria-pressed={follow} title="Keep the section being heard in view" onClick={() => chooseFollow(!follow)}>
            Follow
          </button>
        ) : null}
        <button type="button" className="assistant-ghost" aria-label="Close the contents" onClick={toggleContents}>
          ×
        </button>
      </div>
      <Contents
        toc={toc}
        listen={listening}
        {...(view === "text" ? { anchor: section } : { page })}
        onPick={(entry) => {
          if (view === "text" && entry.anchor) {
            const anchor = entry.anchor;
            setHtmlJump((j) => ({ itemId: id, anchor, seq: (j?.seq ?? 0) + 1 }));
          } else if (entry.page !== null) {
            const p = entry.page;
            setJump((j) => ({ itemId: id, page: p, seq: (j?.seq ?? 0) + 1 }));
          }
          // On a phone the contents cover the page: get out of the way.
          if (window.matchMedia("(max-width: 760px)").matches) setShowContents(false);
        }}
      />
    </aside>
  );

  if (item === "missing") {
    return (
      <div className="screen">
        <h1>Not in the library</h1>
        <Link to="/library">Back to the library</Link>
      </div>
    );
  }
  if (item === null) return null;

  // Spec: LIB-25
  // Beside the viewer's own controls, so the bar keeps room for the title.
  const viewSwitch =
    htmlHere && hasPdf ? (
      <div className="segmented view-switch" role="tablist" aria-label="Read as">
        <button type="button" role="tab" aria-selected={view === "text"} onClick={() => setView("text")}>
          Text
        </button>
        <button type="button" role="tab" aria-selected={view === "pdf"} onClick={() => setView("pdf")}>
          PDF
        </button>
      </div>
    ) : null;
  const contentsToggle =
    hasContents ? (
      <button type="button" className="toc-toggle" aria-pressed={showContents} onClick={toggleContents}>
        Contents
      </button>
    ) : null;

  return (
    <div className="library-item">
      <div className="library-item-bar">
        <Link to="/library" aria-label="Library">
          ←<span className="back-word"> Library</span>
        </Link>
        <span className="library-item-title" title={item.title}>
          {item.title}
        </span>
        <div className="page-actions">
          <button type="button" aria-pressed={showDetails} onClick={() => setShowDetails((s) => !s)}>
            Details
          </button>
          {/* Spec: LIB-8, APP-12 */}
          <MoreMenu
            label="More for this item"
            actions={[
              // Spec: AUD-2
              // Where it was left (its beginning, the first time); a section, from the contents.
              {
                label: "Listen",
                onClick: () => void listenFrom(item.id, null).catch((e: unknown) => note("error", "audio", `Listening to “${item.title}” failed: ${errorMessage(e)}`)),
              },
              // Spec: LIB-27
              ...(item.arxivId ? [{ label: "Fetch the text again from arXiv", onClick: () => void refetchArxivHtml(item.id).catch(() => undefined) }] : []),
              {
                label: "Remove from the library",
                confirm: "Really remove it?",
                danger: true,
                onClick: () => void removeItem(id).then(() => navigate("/library", { replace: true })),
              },
            ]}
          />
        </div>
      </div>
      <div className="item-head">
        <AuthorsEditor itemId={item.id} editing={false} />
        <p className="item-meta muted with-info">
          <span>
            {[item.year, KIND_NAMES[item.kind], item.pages ? `${item.pages} pages` : null].filter(Boolean).join(" · ")}
            {/* Spec: LIB-28 */}
            {item.kind === "post" ? (
              <>
                {" · "}
                <a
                  href={item.filename}
                  onClick={(e) => {
                    e.preventDefault();
                    void openUrl(item.filename);
                  }}
                >
                  {hostOf(item.filename)}
                </a>
              </>
            ) : null}
          </span>
          <DetailsInfo itemId={item.id} />
        </p>
      </div>
      {showDetails ? (
        <>
          <Details item={item} />
          <div className="details-actions">
            <button type="button" onClick={() => void readDetails(item.id)}>
              Read details again
            </button>
          </div>
        </>
      ) : null}
      {view === "text" ? (
        html?.id === id ? (
          <div className={showContents && hasContents ? "library-body with-contents" : "library-body"}>
            {showContents && hasContents ? contentsPanel : null}
            <div className="html-view" onWheelCapture={stopFollowing} onTouchMoveCapture={stopFollowing} onKeyDownCapture={stopFollowing}>
              {contentsToggle || viewSwitch ? (
                <div className="pdf-toolbar">
                  {contentsToggle}
                  {viewSwitch}
                </div>
              ) : null}
              <HtmlReader
                key={id}
                itemId={id}
                html={html.html}
                initialAnchor={start.id === id ? start.anchor : null}
                jump={htmlJump?.itemId === id ? htmlJump : null}
                onContents={setHtmlToc}
                onSection={setSection}
              />
            </div>
          </div>
        ) : null
      ) : fileHere === false ? (
        <p className="muted library-waiting">This PDF hasn't reached this device yet. It arrives with the next sync.</p>
      ) : fileHere ? (
        <div className={showContents && hasContents ? "library-body with-contents" : "library-body"} onWheelCapture={stopFollowing} onTouchMoveCapture={stopFollowing}>
          {/* Spec: LIB-15 */}
          {showContents && hasContents ? contentsPanel : null}
          <PdfViewer
            key={id}
            load={load}
            initialPage={start.id === id ? start.page : null}
            itemId={id}
            onOpen={onOpen}
            onPage={setPage}
            jump={jump?.itemId === id ? jump : null}
            toolbarStart={
              contentsToggle || viewSwitch ? (
                <>
                  {contentsToggle}
                  {viewSwitch}
                </>
              ) : null
            }
          />
        </div>
      ) : null}
    </div>
  );
}
