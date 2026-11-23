import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { pageOfFragment, useQueryParam } from "../lib/address";
import { AuthorsEditor } from "../components/AuthorsEditor";
import { InfoButton } from "../components/InfoButton";
import { Contents } from "../components/Contents";
import { HtmlReader } from "../components/HtmlReader";
import { MoreMenu } from "../components/MoreMenu";
import { RecordDialog } from "../components/RecordDialog";
import { refetchArxivHtml } from "../lib/arxiv";
import { PdfViewer } from "../components/PdfViewer";
import { pdfOutline, type PdfDocument } from "../lib/pdf";
import { readDetails, useDetailsStatus } from "../lib/libraryDetails";
import { getItem, hasFile, hasHtml, isKind, KIND_NAMES, KINDS, LIBRARY_TABLES, readFile, readHtml, removeItem, saveToc, updateItem, type LibraryItem } from "../lib/library";
import type { TocEntry } from "../lib/schemas";
import { useTablesVersion } from "../lib/live";

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
  const [recording, setRecording] = useState(false);
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
  const toc = view === "text" ? htmlToc : item !== null && item !== "missing" ? (item.toc ?? []) : [];
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
        <button type="button" className="assistant-ghost" aria-label="Close the contents" onClick={toggleContents}>
          ×
        </button>
      </div>
      <Contents
        toc={toc}
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
    toc.length > 0 ? (
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
              { label: "Record aloud…", onClick: () => setRecording(true) },
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
          <span>{[item.year, KIND_NAMES[item.kind], item.pages ? `${item.pages} pages` : null].filter(Boolean).join(" · ")}</span>
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
          <div className={showContents && toc.length > 0 ? "library-body with-contents" : "library-body"}>
            {showContents && toc.length > 0 ? contentsPanel : null}
            <div className="html-view">
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
        <div className={showContents && toc.length > 0 ? "library-body with-contents" : "library-body"}>
          {/* Spec: LIB-15 */}
          {showContents && toc.length > 0 ? contentsPanel : null}
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
      {recording ? <RecordDialog item={item} onClose={() => setRecording(false)} /> : null}
    </div>
  );
}
