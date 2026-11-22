import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { EntityHeader } from "../components/EntityHeader";
import { KIND_NAMES, isKind } from "../lib/library";
import { useTablesVersion } from "../lib/live";
import { listPeople, mergePeople, PEOPLE_TABLES, personView, renamePerson, type Counted } from "../lib/people";

type View = NonNullable<Awaited<ReturnType<typeof personView>>>;

export function ItemList(props: { items: View["items"] }) {
  return (
    <ul className="entity-items">
      {props.items.map((i) => (
        <li key={i.id}>
          <Link to={`/library/${i.id}`}>{i.title}</Link>
          <span className="muted"> · {[i.year, isKind(i.kind) ? KIND_NAMES[i.kind] : null].filter(Boolean).join(" · ")}</span>
        </li>
      ))}
    </ul>
  );
}

export function CountedList(props: { rows: readonly Counted[]; to: (id: string) => string; empty: string }) {
  if (props.rows.length === 0) return <p className="muted">{props.empty}</p>;
  return (
    <ul className="entity-links">
      {props.rows.map((r) => (
        <li key={r.id}>
          <Link to={props.to(r.id)}>{r.name}</Link>
          <span className="muted"> {r.items}</span>
        </li>
      ))}
    </ul>
  );
}

// Spec: PPL-3, PPL-5, PPL-6
/** A person: what they wrote, where they were, and who they wrote with. */
export default function PersonPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const version = useTablesVersion(PEOPLE_TABLES);
  const [view, setView] = useState<View | null | "missing">(null);
  const [others, setOthers] = useState<Counted[]>([]);

  useEffect(() => {
    let live = true;
    void Promise.all([personView(id), listPeople()]).then(([v, all]) => {
      if (!live) return;
      setView(v ?? "missing");
      if (v && v.person.id !== id) void navigate(`/library/people/${v.person.id}`, { replace: true });
      setOthers(all.filter((p) => p.id !== (v?.person.id ?? id)));
    });
    return () => {
      live = false;
    };
  }, [id, version, navigate]);

  if (view === "missing") return <div className="screen"><h1>Not in the library</h1><Link to="/library">Back to the library</Link></div>;
  if (view === null) return null;

  return (
    <div className="screen entity-screen">
      <Link to="/library?tab=people" className="back-link">← People</Link>
      <EntityHeader
        name={view.person.name}
        kindLabel="person"
        others={others}
        onRename={(name) => void renamePerson(view.person.id, name)}
        onMerge={(into) => void mergePeople(view.person.id, into).then(() => navigate(`/library/people/${into}`, { replace: true }))}
      />
      <section>
        <h2>In the library ({view.items.length})</h2>
        <ItemList items={view.items} />
      </section>
      <section>
        <h2>Institutions</h2>
        <CountedList rows={view.institutions} to={(i) => `/library/institutions/${i}`} empty="None listed." />
      </section>
      <section>
        <h2>Wrote with</h2>
        <CountedList rows={view.coauthors} to={(p) => `/library/people/${p}`} empty="No co-authors in the library." />
      </section>
    </div>
  );
}
