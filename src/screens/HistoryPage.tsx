import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/mantine/style.css";
import { schema, syntaxHighlighter, toEditorBlocks } from "../blocks";
import { pageRevisions } from "../lib/book";
import { momentsOf, pageAt, type DocBlock, type RevisionRow } from "../lib/bookModel";
import { useQueryParam } from "../lib/address";
import { useTablesVersion } from "../lib/live";
import { pagePath } from "../lib/navigation";
import { useColorScheme } from "../lib/theme";

function ReadOnlyPage(props: { blocks: DocBlock[] }) {
  const scheme = useColorScheme();
  const editor = useCreateBlockNote(
    { schema, extensions: [syntaxHighlighter], ...(props.blocks.length > 0 ? { initialContent: toEditorBlocks(props.blocks) } : {}) },
    [props.blocks],
  );
  return <BlockNoteView editor={editor} editable={false} theme={scheme} sideMenu={false} slashMenu={false} />;
}

function when(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

// Spec: BOOK-6
/** A page as it was at any moment it changed. */
export default function HistoryPage() {
  const { id = "" } = useParams();
  const version = useTablesVersion(["revisions"]);
  const [revisions, setRevisions] = useState<RevisionRow[] | null>(null);
  // Spec: APP-10
  // The moment shown is the address's (`?at=<time>`); without one, the latest.
  const [at, setAt] = useQueryParam("at");

  useEffect(() => {
    let live = true;
    void pageRevisions(id).then((r) => {
      if (live) setRevisions(r);
    });
    return () => {
      live = false;
    };
  }, [id, version]);

  const moments = useMemo(() => (revisions ? momentsOf(revisions, id) : []), [revisions, id]);
  const selected = (at && moments.includes(at) ? at : null) ?? moments[0] ?? null;
  const shown = useMemo(() => (revisions && selected ? pageAt(id, revisions, selected) : null), [revisions, selected, id]);

  return (
    <div className="screen history-screen">
      <div className="page-bar">
        <Link to={pagePath(id)}>← Back to the page</Link>
      </div>
      <h1>History{shown ? `: ${shown.title}` : ""}</h1>
      {revisions && moments.length === 0 ? <p className="muted">No changes recorded yet.</p> : null}
      <div className="history">
        <ol className="moments">
          {moments.map((m, i) => (
            <li key={m}>
              <button type="button" className={m === selected ? "active" : undefined} onClick={() => setAt(i === 0 ? null : m)}>
                {when(m)}
                {i === 0 ? <span className="muted"> · now</span> : null}
              </button>
            </li>
          ))}
        </ol>
        <div className="history-page">
          {shown && shown.blocks.length > 0 ? <ReadOnlyPage key={selected ?? ""} blocks={shown.blocks} /> : null}
          {shown && shown.blocks.length === 0 ? <p className="muted">The page was empty then.</p> : null}
        </div>
      </div>
    </div>
  );
}
