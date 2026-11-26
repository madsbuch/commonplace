import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { getSyncStatus, lastSyncLine, onSyncStatus, type SyncStatus } from "../lib/sync";
import { SyncIcon } from "./Icons";

// Spec: SYN-26
/** The sidebar's line on when this device last synced; opens Settings → Sync. */
export function LastSync() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let live = true;
    const load = () =>
      getSyncStatus()
        .then((s) => {
          if (!live) return;
          setStatus(s);
          setNow(Date.now());
        })
        .catch(() => undefined);
    void load();
    const off = onSyncStatus(() => void load());
    // "5 min ago" moves on by itself.
    const tick = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      live = false;
      off();
      window.clearInterval(tick);
    };
  }, []);
  if (!status) return null;
  return (
    <NavLink to="/settings/sync" end className="sidebar-sync">
      <SyncIcon />
      {lastSyncLine(status, now)}
    </NavLink>
  );
}
