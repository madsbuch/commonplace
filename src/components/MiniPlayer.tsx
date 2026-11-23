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
  return (
    <div className="mini-player" role="region" aria-label="Playing">
      <button type="button" className="mini-player-toggle" aria-label={p.playing ? "Pause" : "Play"} onClick={toggle}>
        {p.playing ? <PauseIcon /> : <PlayIcon />}
      </button>
      <Link to={`/audio/${p.recordingId}`} className="mini-player-text">
        <span className="mini-player-title">{p.title}</span>
        <span className="mini-player-sub">
          {chapter ? `${chapter.title} · ` : ""}
          {clock(p.position)}
        </span>
      </Link>
    </div>
  );
}
