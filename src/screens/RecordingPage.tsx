import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { MoreMenu } from "../components/MoreMenu";
import { PauseIcon, PlayIcon } from "../components/Icons";
import { replaceFragment } from "../lib/address";
import { AUDIO_TABLES, getRecording, hasAudio, removeRecording, retryRecording } from "../lib/audio";
import { chapterAt, clock, SPEEDS, timeOfFragment } from "../lib/audioModel";
import { getItem } from "../lib/library";
import { useTablesVersion } from "../lib/live";
import { chapterStep, load, seek, setSpeed, skip, toggle, unload, usePlayer } from "../lib/player";
import type { Recording } from "../lib/schemas";
import { recordingState } from "./AudioPage";

// Spec: AUD-8, AUD-9, AUD-12
/** One recording: its sources, how it's coming along, and the player with its chapters. */
export default function RecordingPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const version = useTablesVersion(AUDIO_TABLES);
  const [rec, setRec] = useState<Recording | null | "missing">(null);
  const [here, setHere] = useState(false);
  const [sources, setSources] = useState<{ id: string; title: string }[]>([]);
  const p = usePlayer();

  useEffect(() => {
    let live = true;
    void Promise.all([getRecording(id), hasAudio(id)]).then(async ([r, h]) => {
      if (!live) return;
      setRec(r ?? "missing");
      setHere(h);
      if (r) setSources((await Promise.all(r.items.map(getItem))).flatMap((i) => (i ? [{ id: i.id, title: i.title }] : [])));
    });
    return () => {
      live = false;
    };
  }, [id, version]);

  // Ready and here: into the player, at the address's moment or where it was left.
  const ready = rec !== null && rec !== "missing" && rec.status === "ready" && here;
  const [start] = useState(() => ({ key: location.key, at: timeOfFragment(location.hash) }));
  useEffect(() => {
    if (ready && rec !== null && typeof rec !== "string") void load(rec, { at: start.at });
    // Loading counts once a recording is ready; the player keeps it afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, id]);

  // Spec: AUD-12
  // A navigation to another moment of it (a link, Back) goes there.
  const mine = p.recordingId === id;
  useEffect(() => {
    if (location.key === start.key || !mine) return;
    const t = timeOfFragment(location.hash);
    if (t !== null) seek(t);
  }, [location.key, location.hash, start.key, mine]);
  const second = Math.floor(p.position);
  useEffect(() => {
    if (mine) replaceFragment(second > 0 ? `t=${second}` : "");
  }, [mine, second]);

  if (rec === "missing") {
    return (
      <div className="screen">
        <h1>No such recording</h1>
        <Link to="/audio">Back to the audio library</Link>
      </div>
    );
  }
  if (rec === null) return null;
  const current = chapterAt(rec.chapters, mine ? p.position : 0);
  const duration = mine && p.duration > 0 ? p.duration : (rec.durationSeconds ?? 0);

  return (
    <div className="screen recording-screen">
      <div className="page-bar">
        <Link to="/audio" className="back-link">
          ← Audio
        </Link>
        <div className="page-actions">
          {/* Spec: APP-12 */}
          <MoreMenu
            label="More for this recording"
            actions={[
              ...(rec.status === "failed" ? [{ label: "Try again", onClick: () => void retryRecording(rec) }] : []),
              {
                label: "Delete recording",
                confirm: "Really delete this recording?",
                danger: true,
                onClick: () => {
                  unload(id);
                  void removeRecording(id).then(() => navigate("/audio", { replace: true }));
                },
              },
            ]}
          />
        </div>
      </div>
      <h1>{rec.title}</h1>
      <p className="muted recording-meta">
        {rec.kind === "summary" ? `Summary · ${rec.minutes ?? ""} min · ` : "Read aloud · "}
        {sources.map((s, i) => (
          <span key={s.id}>
            {i > 0 ? ", " : ""}
            <Link to={`/library/${s.id}`}>{s.title}</Link>
          </span>
        ))}
      </p>

      {rec.status !== "ready" ? (
        <div className="recording-progress">
          <p>{recordingState(rec)}</p>
          {rec.status === "failed" ? (
            <>
              <p className="ai-error">{rec.error}</p>
              <button type="button" onClick={() => void retryRecording(rec)}>
                Try again
              </button>
            </>
          ) : (
            <div className="progress-bar" role="progressbar" aria-valuenow={Math.round(rec.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
              <div style={{ width: `${Math.round(rec.progress * 100)}%` }} />
            </div>
          )}
        </div>
      ) : !here ? (
        <p className="muted">This recording hasn't reached this device yet. It arrives with the next sync.</p>
      ) : (
        <div className="player" aria-label="Player">
          <input
            className="player-seek"
            type="range"
            min={0}
            max={Math.max(1, duration)}
            step={1}
            value={mine ? p.position : 0}
            aria-label="Position"
            onChange={(e) => seek(Number(e.target.value))}
          />
          <div className="player-times muted">
            <span>{clock(mine ? p.position : 0)}</span>
            <span>{clock(duration)}</span>
          </div>
          <div className="player-controls">
            <button type="button" aria-label="Previous chapter" onClick={() => chapterStep(-1)}>
              ⏮
            </button>
            <button type="button" aria-label="Back 15 seconds" onClick={() => skip(-15)}>
              −15
            </button>
            <button type="button" className="player-play" aria-label={mine && p.playing ? "Pause" : "Play"} disabled={!mine || p.loading} onClick={toggle}>
              {mine && p.playing ? <PauseIcon /> : <PlayIcon />}
            </button>
            <button type="button" aria-label="Forward 30 seconds" onClick={() => skip(30)}>
              +30
            </button>
            <button type="button" aria-label="Next chapter" onClick={() => chapterStep(1)}>
              ⏭
            </button>
          </div>
          <div className="segmented player-speeds" role="radiogroup" aria-label="Speed">
            {SPEEDS.map((s) => (
              <button key={s} type="button" role="radio" aria-checked={p.speed === s} onClick={() => setSpeed(s)}>
                {s}×
              </button>
            ))}
          </div>
          {p.error && mine ? <p className="ai-error">{p.error}</p> : null}
        </div>
      )}

      {rec.chapters.length > 0 ? (
        <ol className="recording-chapters" aria-label="Chapters">
          {rec.chapters.map((c, i) => (
            <li key={i}>
              <button type="button" className={mine && i === current ? "active" : undefined} onClick={() => (mine ? seek(c.start) : undefined)}>
                <span>{c.title}</span>
                <span className="muted">{clock(c.start)}</span>
              </button>
            </li>
          ))}
        </ol>
      ) : rec.script ? (
        <ol className="recording-chapters" aria-label="Chapters">
          {rec.script.chapters.map((c, i) => (
            <li key={i}>
              <span className="recording-chapter-pending">{c.title}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
