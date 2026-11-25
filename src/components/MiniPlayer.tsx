import { Link, useLocation } from "react-router-dom";
import { chapterAt, clock } from "../lib/audioModel";
import { toggle, usePlayer } from "../lib/player";
import { PauseIcon, PlayIcon } from "./Icons";

// Spec: AUD-8
/** What's playing, at the bottom of every other screen: play or pause it, or go to it. */
export function MiniPlayer() {
  const p = usePlayer();
  const location = useLocation();
  if (!p.recordingId || location.pathname === `/audio/${p.recordingId}`) return null;
  const chapter = p.chapters[chapterAt(p.chapters, p.position)];
  // Spec: AUD-20
  const busy = !p.playing && (p.waiting || p.loading);
  return (
    <div className="mini-player" role="region" aria-label="Playing">
      <button type="button" className={busy ? "mini-player-toggle busy" : "mini-player-toggle"} aria-label={p.playing ? "Pause" : busy ? "Getting ready" : "Play"} aria-busy={busy} onClick={toggle}>
        {busy ? <span className="spinner" aria-hidden="true" /> : p.playing ? <PauseIcon /> : <PlayIcon />}
      </button>
      <Link to={`/audio/${p.recordingId}`} className="mini-player-text">
        <span className="mini-player-title">{p.title}</span>
        <span className="mini-player-sub">
          {chapter ? `${chapter.title} · ` : ""}
          {p.waiting ? "Making this part…" : clock(p.position)}
        </span>
      </Link>
    </div>
  );
}
