import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { pageOfFragment } from "../lib/address";
import { AuthorsEditor } from "../components/AuthorsEditor";
import { InfoButton } from "../components/InfoButton";
import { Contents } from "../components/Contents";
import { MoreMenu } from "../components/MoreMenu";
import { PdfViewer } from "../components/PdfViewer";
import { pdfOutline, type PdfDocument } from "../lib/pdf";
import { readDetails, useDetailsStatus } from "../lib/libraryDetails";
import { getItem, hasFile, isKind, KIND_NAMES, KINDS, LIBRARY_TABLES, readFile, removeItem, saveToc, updateItem, type LibraryItem } from "../lib/library";
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
  const [showDetails, setShowDetails] = useState(false);
  const [showContents, setShowContents] = useState(contentsWanted);
  const [page, setPage] = useState(1);
  const [jump, setJump] = useState<{ itemId: string; page: number; seq: number } | null>(null);

  // Spec: LIB-22, APP-10
  // The address names the page to open at; a later navigation (a link to
  // another page of it, Back) goes there. Scrolling writes the address past
  // the router, so the router's changes are always navigations.
  const location = useLocation();
  const [start, setStart] = useState(() => ({ id, key: location.key, page: pageOfFragment(location.hash) }));
  if (start.id !== id) setStart({ id, key: location.key, page: pageOfFragment(location.hash) });
  useEffect(() => {
    if (location.key === start.key) return;
    const p = pageOfFragment(location.hash);
    if (p !== null) setJump((j) => ({ itemId: id, page: p, seq: (j?.seq ?? 0) + 1 }));
  }, [location.key, location.hash, start.key, id]);

  useEffect(() => {
    let live = true;
    void Promise.all([getItem(id), hasFile(id)]).then(([i, f]) => {
      if (!live) return;
      setItem(i ?? "missing");
      setFileHere(f);
    });
    return () => {
      live = false;
    };
  }, [id, version]);

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
  const toc = item !== null && item !== "missing" ? (item.toc ?? []) : [];
  const toggleContents = () =>
    setShowContents((s) => {
      rememberContents(!s);
      return !s;
    });

  if (item === "missing") {
    return (
      <div className="screen">
        <h1>Not in the library</h1>
        <Link to="/library">Back to the library</Link>
      </div>
    );
  }
  if (item === null) return null;

  return (
    <div className="library-item">
      <div className="library-item-bar">
        <Link to="/library">← Library</Link>
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
      {fileHere === false ? (
        <p className="muted library-waiting">This PDF hasn't reached this device yet. It arrives with the next sync.</p>
      ) : fileHere ? (
        <div className={showContents && toc.length > 0 ? "library-body with-contents" : "library-body"}>
          {/* Spec: LIB-15 */}
          {showContents && toc.length > 0 ? (
            <aside className="toc-panel" aria-label="Contents">
              <div className="toc-head">
                <strong>Contents</strong>
                <button type="button" className="assistant-ghost" aria-label="Close the contents" onClick={toggleContents}>
                  ×
                </button>
              </div>
              <Contents
                toc={toc}
                page={page}
                onPick={(p) => {
                  setJump((j) => ({ itemId: id, page: p, seq: (j?.seq ?? 0) + 1 }));
                  // On a phone the contents cover the page: get out of the way.
                  if (window.matchMedia("(max-width: 760px)").matches) setShowContents(false);
                }}
              />
            </aside>
          ) : null}
          <PdfViewer
            key={id}
            load={load}
            initialPage={start.id === id ? start.page : null}
            itemId={id}
            onOpen={onOpen}
            onPage={setPage}
            jump={jump?.itemId === id ? jump : null}
            toolbarStart={
              toc.length > 0 ? (
                <button type="button" className="toc-toggle" aria-pressed={showContents} onClick={toggleContents}>
                  Contents
                </button>
              ) : null
            }
          />
        </div>
      ) : null}
    </div>
  );
}
