import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { installSelectionTracking, setPath } from "../lib/currentView";
import { toggleDock, useDockOpen } from "../lib/dock";
import { setNavigate } from "../lib/navigation";
import { takeShares } from "../lib/share";
import { AssistantDock } from "./AssistantDock";
import { ChatIcon, HeadphonesIcon, LibraryIcon, SearchIcon, SettingsIcon, SparkIcon } from "./Icons";
import { MiniPlayer } from "./MiniPlayer";
import { Logo } from "./Logo";
import { PageTree } from "./PageTree";
import { QUICK_OPEN_KEYS, QuickOpen } from "./QuickOpen";
import { ThemeSwitch } from "./ThemeSwitch";

/** The sidebar (the book's pages, the other screens, the theme) and the screen beside it. */
export function Layout() {
  const [open, setOpen] = useState(false);
  const [quick, setQuick] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const dock = useDockOpen();
  useEffect(() => setNavigate((to) => void navigate(to)), [navigate]);
  // Spec: LIB-30
  // After navigate is set: what was shared opens the Library.
  useEffect(() => takeShares(), []);
  // Spec: ATL-1
  useEffect(() => setPath(location.pathname, `${location.pathname}${location.search}${location.hash}`), [location.pathname, location.search, location.hash]);
  // Spec: ATL-6
  useEffect(() => installSelectionTracking(), []);
  // Spec: APP-7
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setQuick((q) => !q);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // A chat on its own screen needs no assistant beside it.
  const onChatScreen = location.pathname.startsWith("/chats/");
  const showDock = dock && !onChatScreen;

  return (
    <div className={[open ? "layout sidebar-open" : "layout", showDock ? "dock-open" : ""].join(" ")}>
      <button type="button" className="sidebar-toggle" aria-label="Pages" onClick={() => setOpen((o) => !o)}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>
      <div className="sidebar-scrim" onClick={() => setOpen(false)} />
      <nav
        className="sidebar"
        onClick={(e) => {
          if (e.target instanceof HTMLElement && e.target.closest("a")) setOpen(false);
        }}
      >
        <div className="brand">
          {/* Spec: APP-3 */}
          <Link to="/" className="brand-link">
            <Logo size={28} />
            <span className="brand-name">Commonplace</span>
          </Link>
        </div>
        <button type="button" className="quick-open-button" onClick={() => setQuick(true)}>
          <SearchIcon />
          <span>Go to a page</span>
          <kbd>{QUICK_OPEN_KEYS}</kbd>
        </button>
        <div className="nav-main">
          <NavLink to="/library">
            <LibraryIcon />
            Library
          </NavLink>
          <NavLink to="/chats">
            <ChatIcon />
            Chats
          </NavLink>
          {/* Spec: AUD-1 */}
          <NavLink to="/audio">
            <HeadphonesIcon />
            Audio
          </NavLink>
        </div>
        <PageTree />
        <div className="sidebar-footer">
          <NavLink to="/settings">
            <SettingsIcon />
            Settings
          </NavLink>
          <ThemeSwitch />
        </div>
      </nav>
      <main className="main">
        <Outlet />
      </main>
      <MiniPlayer />
      {showDock ? <AssistantDock /> : null}
      {!showDock && !onChatScreen ? (
        <button type="button" className="dock-toggle" aria-label="Open the assistant" title="Assistant" onClick={toggleDock}>
          <SparkIcon />
          Ask
        </button>
      ) : null}
      <QuickOpen open={quick} onClose={() => setQuick(false)} />
    </div>
  );
}
