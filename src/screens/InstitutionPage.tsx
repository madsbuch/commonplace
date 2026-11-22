import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { EntityHeader } from "../components/EntityHeader";
import { useTablesVersion } from "../lib/live";
import { institutionView, listInstitutions, mergeInstitutions, PEOPLE_TABLES, renameInstitution, type Counted } from "../lib/people";
import { CountedList, ItemList } from "./PersonPage";

type View = NonNullable<Awaited<ReturnType<typeof institutionView>>>;

// Spec: PPL-4, PPL-5, PPL-6
/** An institution: the items with an author listed there, and those authors. */
export default function InstitutionPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const version = useTablesVersion(PEOPLE_TABLES);
  const [view, setView] = useState<View | null | "missing">(null);
  const [others, setOthers] = useState<Counted[]>([]);

  useEffect(() => {
    let live = true;
    void Promise.all([institutionView(id), listInstitutions()]).then(([v, all]) => {
      if (!live) return;
      setView(v ?? "missing");
      if (v && v.institution.id !== id) void navigate(`/library/institutions/${v.institution.id}`, { replace: true });
      setOthers(all.filter((i) => i.id !== (v?.institution.id ?? id)));
    });
    return () => {
      live = false;
    };
  }, [id, version, navigate]);

  if (view === "missing") return <div className="screen"><h1>Not in the library</h1><Link to="/library">Back to the library</Link></div>;
  if (view === null) return null;

  return (
    <div className="screen entity-screen">
      <Link to="/library?tab=institutions" className="back-link">← Institutions</Link>
      <EntityHeader
        name={view.institution.name}
        kindLabel="institution"
        others={others}
        onRename={(name) => void renameInstitution(view.institution.id, name)}
        onMerge={(into) => void mergeInstitutions(view.institution.id, into).then(() => navigate(`/library/institutions/${into}`, { replace: true }))}
      />
      <section>
        <h2>In the library ({view.items.length})</h2>
        <ItemList items={view.items} />
      </section>
      <section>
        <h2>People</h2>
        <CountedList rows={view.people} to={(p) => `/library/people/${p}`} empty="No one listed." />
      </section>
    </div>
  );
}
