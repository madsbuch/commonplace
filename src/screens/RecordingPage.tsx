import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { MoreMenu } from "../components/MoreMenu";
import { PauseIcon, PlayIcon } from "../components/Icons";
import { replaceFragment } from "../lib/address";
import { AUDIO_TABLES, getRecording, hasAudio, makeAll, readInVoice, removeRecording, retryRecording } from "../lib/audio";
import { chapterAt, chunksOf, clock, SPEEDS, timeOfFragment, VOICES } from "../lib/audioModel";
import { getItem } from "../lib/library";
import { useTablesVersion } from "../lib/live";
import { chapterStep, load, seek, setSpeed, skip, toggle, unload, usePlayer } from "../lib/player";
import type { Provenance, Recording } from "../lib/schemas";
import { recordingState } from "./AudioPage";

// Spec: AUD-15
/** Choosing another voice for a reading: it starts afresh in it. */
function VoiceDialog(props: { rec: Recording; onClose: () => void }) {
  const [voice, setVoice] = useState(props.rec.voice);
  const [busy, setBusy] = useState(false);
  return (
    <div className="dialog-backdrop" onClick={props.onClose}>
      <div className="dialog" role="dialog" aria-label="Read in another voice" onClick={(e) => e.stopPropagation()}>
        <h2>Read in another voice</h2>
        <label className="record-field">
          <span>Voice</span>
          <select value={voice} onChange={(e) => setVoice(e.target.value)} aria-label="Voice">
            {VOICES.map((v) => (
              <option key={v.name} value={v.name}>
                {v.name} ({v.character})
              </option>
            ))}
          </select>
        </label>
        <p className="muted">What's been spoken in {props.rec.voice} goes; the reading starts afresh in {voice}.</p>
        <div className="dialog-actions">
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button-primary"
            disabled={busy || voice === props.rec.voice}
            onClick={() => {
              setBusy(true);
              unload(props.rec.id);
              void readInVoice(props.rec.id, voice)
                .then(() => getRecording(props.rec.id))
                .then((r) => (r ? load(r) : undefined))
                .finally(props.onClose);
            }}
          >
            Read in {voice}
          </button>
        </div>
      </div>
    </div>
  );
}

// Spec: AUD-16
/** Where a summary came from, and its script. */
function WhereItCameFrom(props: { rec: Recording; provenance: Provenance }) {
  const p = props.provenance;
  return (
    <details className="recording-provenance">
      <summary>Where it came from</summary>
      <ul>
        {p.sources.map((s) => (
          <li key={s.itemId}>
            <Link to={`/library/${s.itemId}`}>{s.title}</Link>
            {s.year ? ` (${s.year})` : ""}: {s.text === "html" ? "its HTML version" : "its PDF"}, {s.characters.toLocaleString("en")} characters read
          </li>
        ))}
        <li>
          Written by {p.scriptModel}
          {p.minutes ? `, about ${p.minutes} minutes long` : ""}
        </li>
        <li>
          Read by {p.voice} ({p.speechModel})
        </li>
        <li>Made {new Date(p.made).toLocaleString()}</li>
      </ul>
      <details>
        <summary>What the script model was told</summary>
        <pre className="recording-instructions">{p.instructions}</pre>
      </details>
      <details>
        <summary>The script</summary>
        {(props.rec.script?.chapters ?? []).map((c, i) => (
          <section key={i} className="recording-script">
            <h3>{c.title}</h3>
            {chunksOf(c).flatMap((k, j) => (k.passages ?? []).map((text, n) => <p key={`${j}.${n}`}>{text}</p>))}
          </section>
        ))}
      </details>
    </details>
  );
}

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
  const [revoicing, setRevoicing] = useState(false);
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

  // Spec: AUD-6
  // Into the player, at the address's moment or where it was left, as soon as
  // there's a script to make it from (or, made before as one file, once it's here).
  const oneFile = rec !== null && rec !== "missing" && rec.durationSeconds !== null;
  const ready = rec !== null && rec !== "missing" && (oneFile ? here : rec.script !== null && rec.status !== "writing");
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
  // The chapters as the player has them (a recording made as it's listened to has them from its timeline).
  const chapters = mine && p.chapters.length > 0 ? p.chapters : rec.chapters;
  const current = chapterAt(chapters, mine ? p.position : 0);
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
              // Spec: AUD-13
              ...(rec.status === "listening" ? [{ label: "Make it all now", onClick: () => void makeAll(rec.id) }] : []),
              // Spec: AUD-15
              ...(rec.kind === "verbatim" && !oneFile ? [{ label: "Read in another voice…", onClick: () => setRevoicing(true) }] : []),
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
        {rec.kind === "summary" ? `Summary · ${rec.minutes ?? ""} min · ` : oneFile ? "Read aloud · " : "Reading · "}
        {sources.map((s, i) => (
          <span key={s.id}>
            {i > 0 ? ", " : ""}
            <Link to={`/library/${s.id}`}>{s.title}</Link>
          </span>
        ))}
        {rec.kind === "verbatim" ? ` · read by ${rec.voice}` : null}
      </p>
      {rec.provenance ? <WhereItCameFrom rec={rec} provenance={rec.provenance} /> : null}
      {revoicing ? <VoiceDialog rec={rec} onClose={() => setRevoicing(false)} /> : null}

      {rec.status === "writing" || rec.status === "making" || rec.status === "speaking" || rec.status === "failed" || (rec.error && !oneFile) ? (
        <div className="recording-progress">
          <p>{recordingState(rec)}</p>
          {rec.status === "failed" || rec.error ? (
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
      ) : null}
      {!ready ? (
        oneFile && !here ? <p className="muted">This recording hasn't reached this device yet. It arrives with the next sync.</p> : null
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
          {/* Spec: AUD-6 */}
          {mine && p.waiting ? <p className="muted recording-waiting">Making this part…</p> : null}
          {mine && p.made !== null && rec.status === "listening" ? (
            <p className="muted recording-made">
              Made as you listen · {clock(p.made)} of {p.duration > 0 ? `about ${clock(p.duration)}` : "it"} made
            </p>
          ) : null}
          {p.error && mine ? <p className="ai-error">{p.error}</p> : null}
        </div>
      )}

      {chapters.length > 0 ? (
        <ol className="recording-chapters" aria-label="Chapters">
          {chapters.map((c, i) => (
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
