import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { AuthorsEditor } from "../components/AuthorsEditor";
import { PdfViewer } from "../components/PdfViewer";
import { readDetails, useDetailsStatus } from "../lib/libraryDetails";
import { getItem, hasFile, isKind, KIND_NAMES, KINDS, LIBRARY_TABLES, readFile, removeItem, updateItem, type LibraryItem } from "../lib/library";
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

/** What the model is doing with this item's details, if anything. */
function DetailsStatusLine(props: { itemId: string }) {
  const status = useDetailsStatus(props.itemId);
  if (!status) return null;
  if (status.state === "reading") return <p className="details-status">Reading the details…</p>;
  if (status.state === "no-key")
    return (
      <p className="details-status">
        The details came from the PDF itself. <Link to="/settings">Add an OpenRouter key</Link> to have a model read them.
      </p>
    );
  return <p className="details-status failed">Reading the details failed: {status.message}</p>;
}

// Spec: LIB-5, LIB-6, LIB-8, LIB-11
/** One paper or book: its details, editable, and its PDF. */
export default function LibraryItemPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const version = useTablesVersion(LIBRARY_TABLES);
  const [item, setItem] = useState<LibraryItem | null | "missing">(null);
  const [fileHere, setFileHere] = useState<boolean | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

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
          {confirm ? (
            <button type="button" className="danger" onClick={() => void removeItem(id).then(() => navigate("/library", { replace: true }))}>
              Really remove?
            </button>
          ) : (
            <button type="button" onClick={() => setConfirm(true)}>
              Remove
            </button>
          )}
        </div>
      </div>
      <div className="item-head">
        <AuthorsEditor itemId={item.id} editing={false} />
        <p className="item-meta muted">{[item.year, KIND_NAMES[item.kind], item.pages ? `${item.pages} pages` : null].filter(Boolean).join(" · ")}</p>
        <DetailsStatusLine itemId={item.id} />
      </div>
      {showDetails ? (
        <>
          <Details item={item} />
          <div className="details-actions">
            <button type="button" onClick={() => void readDetails(item.id)}>
              Read details again
            </button>
            <span className="muted">The model reads the first pages and replaces the details above.</span>
          </div>
        </>
      ) : null}
      {fileHere === false ? (
        <p className="muted library-waiting">This PDF hasn't reached this device yet. It arrives with the next sync.</p>
      ) : fileHere ? (
        <PdfViewer load={load} itemId={id} />
      ) : null}
    </div>
  );
}
