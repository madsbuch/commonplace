import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQueryParam } from "../lib/address";
import { listInstitutions, listPeople, PEOPLE_TABLES, type Counted } from "../lib/people";
import { CountedList } from "./PersonPage";
import { addFile, isKind, KIND_NAMES, LIBRARY_TABLES, listItems, problemWith, sizeText, type Kind, type LibraryItem } from "../lib/library";
import { useTablesVersion } from "../lib/live";
import { importArxiv } from "../lib/arxiv";
import { parseArxivId } from "../lib/arxivModel";
import { importWebPage } from "../lib/web";
import { importHnThread } from "../lib/threads";
import { parseHnId } from "../lib/threadModel";
import { nextShare, onShares } from "../lib/share";
import { hostOf, webAddress } from "../lib/webModel";
import { detailsOf, messageOf, note } from "../lib/diagnostics";

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
/** The papers, books and posts: search, filter by kind, add PDFs by choosing or dropping them, or arXiv papers and posts by address. */
export default function LibraryPage() {
  const version = useTablesVersion(LIBRARY_TABLES);
  const navigate = useNavigate();
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  // Spec: APP-10
  // The tab, the search and the kind are the address's (`?tab=…&q=…&kind=…`).
  const [tabParam, setTab] = useQueryParam("tab");
  const tab: Tab = tabParam === "people" || tabParam === "institutions" ? tabParam : "items";
  const [queryParam, setQuery] = useQueryParam("q");
  const query = queryParam ?? "";
  const [kindParam, setKind] = useQueryParam("kind");
  const filter: Filter = isKind(kindParam) ? kindParam : "all";
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

  // Spec: LIB-23, LIB-28, LIB-31
  // An arXiv number (or arXiv address) adds the paper; a Hacker News address, the thread; any other web address, the post there.
  const [addressInput, setAddressInput] = useState("");
  const arxivId = parseArxivId(addressInput);
  const hnId = arxivId ? null : parseHnId(addressInput);
  const fromAddress = async (input: string) => {
    const arxiv = parseArxivId(input);
    const hn = arxiv ? null : parseHnId(input);
    setProblems([]);
    try {
      if (hn !== null) {
        const { itemId, comment } = await importHnThread(input, setBusy);
        setAddressInput("");
        void navigate(`/library/${itemId}${comment ? `#c${comment}` : ""}`);
        return;
      }
      const id = arxiv ? await importArxiv(input, setBusy) : await importWebPage(input, setBusy);
      setAddressInput("");
      void navigate(`/library/${id}`);
    } catch (e) {
      // Spec: DIAG-1
      note("error", "library", `Adding ${arxiv ? "from arXiv" : hn !== null ? "from Hacker News" : "from the web"} failed: ${messageOf(e)}`, detailsOf(e));
      setProblems([messageOf(e)]);
    } finally {
      setBusy(null);
    }
  };

  const add = async (files: File[], known: string[] = []) => {
    const issues = [...known];
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
    // Spec: DIAG-1
    for (const issue of issues) note("warning", "library", issue);
    setProblems(issues);
    if (files.length === 1 && last) void navigate(`/library/${last}`);
  };

  // Spec: LIB-30
  // What another app shared is added here, one share at a time, as if typed in the field or uploaded.
  const adding = useRef(false);
  const addShared = useRef<() => Promise<void>>(async () => undefined);
  addShared.current = async () => {
    if (adding.current) return;
    adding.current = true;
    try {
      for (let share = nextShare(); share; share = nextShare()) {
        if (share.kind === "files") {
          await add(share.files, share.problems);
          continue;
        }
        setAddressInput(share.address ?? share.text);
        if (share.address) await fromAddress(share.address);
        else setProblems(["What was shared has no web address or arXiv number in it."]);
      }
    } finally {
      adding.current = false;
    }
  };
  useEffect(() => {
    void addShared.current();
    return onShares(() => void addShared.current());
  }, []);

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
          Add PDF or HTML
        </button>
        <input
          ref={input}
          type="file"
          accept="application/pdf,.pdf,text/html,.html,.htm"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            void add(files);
          }}
        />
      </div>
      {/* Spec: LIB-23, LIB-28 */}
      <form
        className="arxiv-form"
        onSubmit={(e) => {
          e.preventDefault();
          void fromAddress(addressInput);
        }}
      >
        <input
          value={addressInput}
          onChange={(e) => setAddressInput(e.target.value)}
          placeholder="arXiv number or web address"
          aria-label="arXiv number or web address"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          disabled={busy !== null}
        />
        <button type="submit" disabled={busy !== null || (arxivId === null && webAddress(addressInput) === null)}>
          {arxivId ? "Add from arXiv" : hnId !== null ? "Add from Hacker News" : "Add"}
        </button>
      </form>
      {busy ? <p className="muted">{busy}</p> : null}
      {problems.map((p) => (
        <p key={p} className="library-problem">
          {p}
        </p>
      ))}
      <div className="segmented library-tabs" role="tablist">
        {(["items", "people", "institutions"] as const).map((k) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k === "items" ? null : k)}>
            {k === "items" ? "Items" : k === "people" ? "People" : "Institutions"}
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
            {(["all", "paper", "book", "post", "thread"] as const).map((f) => (
              <button key={f} type="button" role="tab" aria-selected={filter === f} onClick={() => setKind(f === "all" ? null : f)}>
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
            <p className="muted library-empty">Nothing here yet. Add a PDF or drop one here, or give an arXiv number or a post's address.</p>
          ) : null}
          <ul className="library-list">
            {shown.map((i) => (
              <li key={i.id}>
                <Link to={`/library/${i.id}`} className="library-row">
                  <span className="library-title">{i.title}</span>
                  <span className="library-meta muted">
                    {[i.authors || null, i.year, KIND_NAMES[i.kind], i.pages ? `${i.pages} pages` : null, i.kind === "post" || i.kind === "thread" ? hostOf(i.filename) : sizeText(i.fileSize)]
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
