import { useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { setNavigate } from "../lib/navigation";
import { PageTree } from "./PageTree";

/** The sidebar (page tree, links to the other screens) and the screen beside it. */
export function Layout() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  useEffect(() => setNavigate((to) => void navigate(to)), [navigate]);
  return (
    <div className={open ? "layout sidebar-open" : "layout"}>
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
          <NavLink to="/sync">Sync</NavLink>
          <NavLink to="/costs">AI costs</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </div>
      </nav>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
