import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { PageTree } from "./PageTree";

/** The sidebar (page tree, links to settings) and the screen beside it. */
export function Layout() {
  const [open, setOpen] = useState(false);
  return (
    <div className={open ? "layout sidebar-open" : "layout"}>
      <button type="button" className="sidebar-toggle" aria-label="Pages" onClick={() => setOpen((o) => !o)}>
        ☰
      </button>
      <nav className="sidebar" onClick={(e) => {
        if (e.target instanceof HTMLElement && e.target.closest("a")) setOpen(false);
      }}>
        <PageTree />
        <div className="sidebar-footer">
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
