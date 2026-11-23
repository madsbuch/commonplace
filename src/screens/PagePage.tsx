import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { PageEditor } from "../components/PageEditor";
import { MoreMenu } from "../components/MoreMenu";
import { PagePicker } from "../components/PagePicker";
import { createPage, deletePage, loadPage, movePage, renamePage, type LoadedPage } from "../lib/book";
import { toggleDock, useDockOpen } from "../lib/dock";
import { setSetting } from "../lib/db";
import { flushOpenEditor } from "../lib/editorBridge";
import { pagePath } from "../lib/navigation";
import { breadcrumbs, usePageIndex } from "../lib/pageIndex";
import { SETTING_KEYS } from "../lib/settings";
import { UNTITLED } from "../lib/bookModel";

/** How long typing in the title pauses before it is saved. */
const TITLE_DELAY_MS = 500;

function TitleInput(props: { pageId: string; title: string }) {
  const [value, setValue] = useState(props.title === UNTITLED ? "" : props.title);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focused = useRef(false);
  const latest = useRef(value);

  // Follow renames from elsewhere while not typing here.
  useEffect(() => {
    if (!focused.current) setValue(props.title === UNTITLED ? "" : props.title);
  }, [props.title]);

  const save = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    void renamePage(props.pageId, latest.current.trim());
  }, [props.pageId]);

  useEffect(() => () => {
    if (timer.current) save();
  }, [save]);

  return (
    <input
      className="page-title"
      placeholder={UNTITLED}
      value={value}
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false;
        if (timer.current) save();
      }}
      onChange={(e) => {
        setValue(e.target.value);
        latest.current = e.target.value;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(save, TITLE_DELAY_MS);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const editor = document.querySelector<HTMLElement>(".bn-editor");
          editor?.focus();
        }
      }}
    />
  );
}

/** A page: its title, its blocks, and what can be done with it. */
export default function PagePage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const index = usePageIndex();
  const [loaded, setLoaded] = useState<LoadedPage | null | "missing">(null);
  const assistant = useDockOpen();
  const [moving, setMoving] = useState(false);
  const title = index.titles.get(id) ?? (loaded && loaded !== "missing" ? loaded.title : UNTITLED);

  useEffect(() => {
    let live = true;
    setLoaded(null);
    void loadPage(id).then((p) => {
      if (live) setLoaded(p ?? "missing");
    });
    void setSetting(SETTING_KEYS.lastPage, id);
    return () => {
      live = false;
    };
  }, [id]);

  if (loaded === "missing") {
    return (
      <div className="screen">
        <h1>Page not found</h1>
        <p className="muted">It may have been deleted, or not have reached this device yet.</p>
        <Link to="/">Back to the book</Link>
      </div>
    );
  }

  const crumbs = breadcrumbs(index, id).slice(0, -1);

  return (
    <div>
      <div className="screen page-screen">
        <div className="page-bar">
          <nav className="crumbs" aria-label="Breadcrumbs">
            {crumbs.map((c) => (
              <span key={c.id}>
                <Link to={pagePath(c.id)}>{c.title}</Link>
                <span className="crumb-sep">/</span>
              </span>
            ))}
          </nav>
          <div className="page-actions">
            <button type="button" onClick={toggleDock} aria-pressed={assistant}>
              Assistant
            </button>
            <Link to={`${pagePath(id)}/history`} className="button-link">
              History
            </Link>
            <button
              type="button"
              onClick={() =>
                void flushOpenEditor()
                  .then(() => createPage(id))
                  .then((sub) => navigate(pagePath(sub)))
              }
            >
              New subpage
            </button>
            {/* Spec: APP-12 */}
            <MoreMenu
              label="More for this page"
              actions={[
                { label: "Move…", onClick: () => setMoving(true) },
                {
                  label: "Delete page",
                  confirm: "Really delete this page?",
                  danger: true,
                  onClick: () =>
                    void deletePage(id).then(() => {
                      const parent = index.parents.get(id);
                      void navigate(parent ? pagePath(parent) : "/", { replace: true });
                    }),
                },
              ]}
            />
          </div>
        </div>
        {loaded === null ? null : (
          <>
            <TitleInput key={`title-${id}`} pageId={id} title={title} />
            <PageEditor key={`editor-${id}`} loaded={loaded} />
          </>
        )}
      </div>
      {moving ? (
        <PagePicker
          title="Move page into"
          exclude={id}
          excludeSubtree
          allowTop
          onClose={() => setMoving(false)}
          onPickTop={() => {
            setMoving(false);
            void movePage(id, null, null);
          }}
          onPick={(target) => {
            setMoving(false);
            void movePage(id, target, null);
          }}
        />
      ) : null}
    </div>
  );
}
