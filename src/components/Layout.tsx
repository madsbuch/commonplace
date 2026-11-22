import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { setPath } from "../lib/currentView";
import { toggleDock, useDockOpen } from "../lib/dock";
import { AssistantDock } from "./AssistantDock";
import { setNavigate } from "../lib/navigation";
import { PageTree } from "./PageTree";

/** The sidebar (page tree, links to the other screens) and the screen beside it. */
export function Layout() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const dock = useDockOpen();
  useEffect(() => setNavigate((to) => void navigate(to)), [navigate]);
  // Spec: ATL-1
  useEffect(() => setPath(location.pathname), [location.pathname]);
  // A chat on its own screen needs no assistant beside it.
  const showDock = dock && !location.pathname.startsWith("/chats/");
  return (
    <div className={[open ? "layout sidebar-open" : "layout", showDock ? "dock-open" : ""].join(" ")}>
      <button type="button" className="sidebar-toggle" aria-label="Pages" onClick={() => setOpen((o) => !o)}>
        ☰
      </button>
      <div className="sidebar-scrim" onClick={() => setOpen(false)} />
      <nav
        className="sidebar"
        onClick={(e) => {
          if (e.target instanceof HTMLElement && e.target.closest("a")) setOpen(false);
        }}
      >
        <PageTree />
        <div className="sidebar-footer">
          <NavLink to="/library">Library</NavLink>
          <NavLink to="/chats">Chats</NavLink>
          <NavLink to="/sync">Sync</NavLink>
          <NavLink to="/costs">AI costs</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </div>
      </nav>
      <main className="main">
        <Outlet />
      </main>
      {showDock ? <AssistantDock /> : null}
      {!showDock && !location.pathname.startsWith("/chats/") ? (
        <button type="button" className="dock-toggle" aria-label="Open the assistant" title="Assistant" onClick={toggleDock}>
          Ask
        </button>
      ) : null}
    </div>
  );
}
