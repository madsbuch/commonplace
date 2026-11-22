import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createPage } from "../lib/book";
import { getSetting } from "../lib/db";
import { pagePath } from "../lib/navigation";
import { usePageIndex, usePageIndexLoaded } from "../lib/pageIndex";
import { SETTING_KEYS } from "../lib/settings";

/** The book's front: reopens the last page, or lists the top-level pages. */
export default function HomePage() {
  const { tree, titles } = usePageIndex();
  const loaded = usePageIndexLoaded();
  const navigate = useNavigate();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (!loaded || checked) return;
    setChecked(true);
    void getSetting(SETTING_KEYS.lastPage).then((last) => {
      if (last && titles.has(last)) void navigate(pagePath(last), { replace: true });
    });
  }, [loaded, checked, titles, navigate]);

  return (
    <div className="screen">
      <h1>My Book</h1>
      <p className="muted">
        An ever-evolving book of what I find interesting: type theory, ontologies, epistemology, probabilistic reasoning
        and programming.
      </p>
      {tree.length > 0 ? (
        <ul className="home-pages">
          {tree.map((n) => (
            <li key={n.id}>
              <Link to={pagePath(n.id)}>{n.title}</Link>
            </li>
          ))}
        </ul>
      ) : loaded ? (
        <p>The book is empty. Start with a first page.</p>
      ) : null}
      <button type="button" className="button-primary" onClick={() => void createPage(null).then((id) => navigate(pagePath(id)))}>
        New page
      </button>
    </div>
  );
}
