import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { listInstitutions, listPeople, PEOPLE_TABLES, type Counted } from "../lib/people";
import { CountedList } from "./PersonPage";
import { addFile, KIND_NAMES, LIBRARY_TABLES, listItems, problemWith, sizeText, type Kind, type LibraryItem } from "../lib/library";
import { useTablesVersion } from "../lib/live";

type Filter = "all" | Kind;
type Tab = "items" | "people" | "institutions";

// Spec: PPL-3, PPL-4
/** Everyone, or every institution, in the library, searchable. */
function Browse(props: { tab: "people" | "institutions"; query: string }) {
  const version = useTablesVersion(PEOPLE_TABLES);
  const [rows, setRows] = useState<Counted[] | null>(null);
  useEffect(() => {
    let live = true;
    void (props.tab === "people" ? listPeople() : listInstitutions()).then((r) => {
      if (live) setRows(r);
    });
    return () => {
      live = false;
    };
  }, [props.tab, version]);
  const q = props.query.trim().toLowerCase();
  const shown = (rows ?? []).filter((r) => q === "" || r.name.toLowerCase().includes(q));
  return (
    <CountedList
      rows={shown}
      to={(id) => (props.tab === "people" ? `/library/people/${id}` : `/library/institutions/${id}`)}
      empty={rows === null ? "" : props.tab === "people" ? "No authors yet." : "No institutions yet."}
    />
  );
}

// Spec: LIB-1, LIB-2
/** The papers and books: search, filter by kind, add PDFs by choosing or dropping them. */
export default function LibraryPage() {
  const version = useTablesVersion(LIBRARY_TABLES);
  const navigate = useNavigate();
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [params, setParams] = useSearchParams();
  const tabParam = params.get("tab");
  const tab: Tab = tabParam === "people" || tabParam === "institutions" ? tabParam : "items";
  const [busy, setBusy] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    void listItems().then((list) => {
      if (live) setItems(list);
    });
    return () => {
      live = false;
    };
  }, [version]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (items ?? []).filter(
      (i) => (filter === "all" || i.kind === filter) && (q === "" || `${i.title} ${i.authors} ${i.year ?? ""}`.toLowerCase().includes(q)),
    );
  }, [items, query, filter]);

  const add = async (files: File[]) => {
    const issues: string[] = [];
    let last: string | null = null;
    for (const f of files) {
      const problem = problemWith(f);
      if (problem) {
        issues.push(problem);
        continue;
      }
      setBusy(`Adding ${f.name}…`);
      try {
        last = await addFile(f);
      } catch (e) {
        issues.push(`${f.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    setBusy(null);
    setProblems(issues);
    if (files.length === 1 && last) void navigate(`/library/${last}`);
  };

  return (
    <div
      className={dragging ? "screen library-screen dropping" : "screen library-screen"}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(false);
        void add([...e.dataTransfer.files]);
      }}
    >
      <div className="library-head">
        <h1>Library</h1>
        <button type="button" className="button-primary" disabled={busy !== null} onClick={() => input.current?.click()}>
          Add PDF
        </button>
        <input
          ref={input}
          type="file"
          accept="application/pdf,.pdf"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            void add(files);
          }}
        />
      </div>
      {busy ? <p className="muted">{busy}</p> : null}
      {problems.map((p) => (
        <p key={p} className="library-problem">
          {p}
        </p>
      ))}
      <div className="segmented library-tabs" role="tablist">
        {(["items", "people", "institutions"] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setParams(k === "items" ? {} : { tab: k }, { replace: true })}>
            {k === "items" ? "Papers and books" : k === "people" ? "People" : "Institutions"}
          </button>
        ))}
      </div>
      <div className="library-filters">
        <input
          className="library-search"
          placeholder={tab === "items" ? "Search titles and authors" : tab === "people" ? "Search people" : "Search institutions"}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {tab === "items" ? (
          <div className="segmented" role="tablist">
            {(["all", "paper", "book"] as const).map((f) => (
              <button key={f} type="button" role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}>
                {f === "all" ? "All" : `${KIND_NAMES[f]}s`}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {tab !== "items" ? (
        <Browse tab={tab} query={query} />
      ) : (
        <>
          {items && items.length === 0 ? (
            <p className="muted library-empty">No papers or books yet. Add a PDF, or drop one here.</p>
          ) : null}
          <ul className="library-list">
            {shown.map((i) => (
              <li key={i.id}>
                <Link to={`/library/${i.id}`} className="library-row">
                  <span className="library-title">{i.title}</span>
                  <span className="library-meta muted">
                    {[i.authors || null, i.year, KIND_NAMES[i.kind], i.pages ? `${i.pages} pages` : null, sizeText(i.fileSize)]
                      .filter((x) => x !== null && x !== "")
                      .join(" · ")}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
