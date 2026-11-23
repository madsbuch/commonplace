import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTablesVersion } from "../lib/live";
import {
  addAffiliation,
  addAuthor,
  itemAuthors,
  loadInstitutions,
  loadPeople,
  PEOPLE_TABLES,
  removeAffiliation,
  removeAuthorship,
  type ItemAuthor,
} from "../lib/people";
import type { Named } from "../lib/peopleModel";
import { NamePicker } from "./NamePicker";

/** Names shown before "and N more". */
const SHORT_LIST = 3;

/** An item's authors as links, with where they were; editable when `editing`. */
export function AuthorsEditor(props: { itemId: string; editing: boolean }) {
  const [open, setOpen] = useState(false);
  const version = useTablesVersion(PEOPLE_TABLES);
  const [authors, setAuthors] = useState<ItemAuthor[]>([]);
  const [people, setPeople] = useState<Named[]>([]);
  const [insts, setInsts] = useState<Named[]>([]);
  const [addingTo, setAddingTo] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void Promise.all([itemAuthors(props.itemId), loadPeople(), loadInstitutions()]).then(([a, p, i]) => {
      if (!live) return;
      setAuthors(a);
      setPeople(p.filter((x) => x.mergedInto === null));
      setInsts(i.filter((x) => x.mergedInto === null));
    });
    return () => {
      live = false;
    };
  }, [props.itemId, version]);

  if (!props.editing) {
    if (authors.length === 0) return null;
    // Spec: PPL-8
    // A line of names; the rest of a long list, and the institutions, when asked for.
    const shown = open ? authors : authors.slice(0, SHORT_LIST);
    const more = authors.length - shown.length;
    const institutions = authors.some((a) => a.institutions.length > 0);
    return (
      <p className={open ? "item-authors open" : "item-authors"}>
        {shown.map((a, i) => (
          <span key={a.authorshipId}>
            {i > 0 ? ", " : null}
            <Link to={`/library/people/${a.personId}`}>{a.name}</Link>
            {open && a.institutions.length > 0 ? (
              <span className="muted">
                {" ("}
                {a.institutions.map((inst, j) => (
                  <span key={inst.affiliationId}>
                    {j > 0 ? "; " : null}
                    <Link to={`/library/institutions/${inst.id}`} className="muted-link">
                      {inst.name}
                    </Link>
                  </span>
                ))}
                {")"}
              </span>
            ) : null}
          </span>
        ))}
        {more > 0 || institutions || open ? (
          <button type="button" className="authors-more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? "Less" : more > 0 ? `and ${more} more` : "Institutions"}
          </button>
        ) : null}
      </p>
    );
  }

  // Spec: PPL-7
  return (
    <div className="authors-editor">
      <span className="field-label">Authors</span>
      <ul>
        {authors.map((a) => (
          <li key={a.authorshipId}>
            <div className="author-line">
              <Link to={`/library/people/${a.personId}`}>{a.name}</Link>
              <button type="button" className="chip-x" aria-label={`Remove ${a.name}`} onClick={() => void removeAuthorship(props.itemId, a.authorshipId)}>
                ×
              </button>
            </div>
            <div className="author-insts">
              {a.institutions.map((inst) => (
                <span key={inst.affiliationId} className="chip">
                  <Link to={`/library/institutions/${inst.id}`}>{inst.name}</Link>
                  <button type="button" className="chip-x" aria-label={`Remove ${inst.name}`} onClick={() => void removeAffiliation(inst.affiliationId)}>
                    ×
                  </button>
                </span>
              ))}
              {addingTo === a.authorshipId ? (
                <NamePicker
                  autoFocus
                  options={insts}
                  placeholder="Institution"
                  onCancel={() => setAddingTo(null)}
                  onPick={(id) => {
                    setAddingTo(null);
                    void addAffiliation(a.authorshipId, { institutionId: id });
                  }}
                  onNew={(name) => {
                    setAddingTo(null);
                    void addAffiliation(a.authorshipId, { name });
                  }}
                />
              ) : (
                <button type="button" className="chip-add" onClick={() => setAddingTo(a.authorshipId)}>
                  + institution
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      <NamePicker
        options={people}
        placeholder="Add an author"
        onPick={(id) => void addAuthor(props.itemId, { personId: id })}
        onNew={(name) => void addAuthor(props.itemId, { name })}
      />
    </div>
  );
}
