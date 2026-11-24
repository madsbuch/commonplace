// ---------------------------------------------------------------------------
// The one player (AUD-8 to AUD-11), for the whole app, so a recording keeps
// playing from screen to screen, with chapters, speed, and the media keys.
//
// A recording is made as it's listened to (AUD-6): it's a run of pieces, a
// passage each, and the player plays them one after another over one
// timeline (audioModel's `timeline`: what's made as it is, the rest as it
// will likely be), telling Rust where it is so it makes `audio.lead` ahead.
// At a part not yet made it waits, and goes on when the piece arrives.
// Recordings made before are one file, and play as one.
//
// On a computer it's two audio elements (the next piece loaded while one
// plays), with Media Session for the keys; on Android, the native player
// (plugins/audio-player: Media3 in a foreground service, which plays with the
// screen off and has the lock-screen controls), its queue set by Rust, which
// adds pieces as they're made. Where it is is saved as it plays, and a
// recording starts where it was left, on any device. A state outside React;
// screens subscribe.
// ---------------------------------------------------------------------------

import { addPluginListener, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";
import { z } from "zod";
import { getListening, getRecording, listenAt, pieceAudio, recordingAudio, recordingPieces, saveListening } from "./audio";
import { isAndroid } from "./sync";
import { chapterAt, slotAt, startOf, timeline, type Timeline } from "./audioModel";
import { onTablesChanged } from "./live";
import { AudioEventSchema, type Recording, type RecordingChapter } from "./schemas";

export interface PlayerState {
  recordingId: string | null;
  title: string;
  chapters: RecordingChapter[];
  duration: number;
  position: number;
  playing: boolean;
  speed: number;
  loading: boolean;
  /** Waiting for the part it's at to be made. */
  waiting: boolean;
  /** How much of it is made, in seconds: null for a recording kept as one file. */
  made: number | null;
  error: string | null;
}

const SPEED_KEY = "player-speed";
/** How often, while playing, where it is is saved. */
const SAVE_EVERY_MS = 5000;
/** How often, while playing, Rust is told where it is (so it makes ahead of there). */
const ASK_EVERY_MS = 5000;

function savedSpeed(): number {
  try {
    const n = Number(localStorage.getItem(SPEED_KEY));
    return n > 0 ? n : 1;
  } catch {
    return 1;
  }
}

let state: PlayerState = {
  recordingId: null,
  title: "",
  chapters: [],
  duration: 0,
  position: 0,
  playing: false,
  speed: savedSpeed(),
  loading: false,
  waiting: false,
  made: null,
  error: null,
};
const listeners = new Set<() => void>();

/** The recording in the player. */
let rec: Recording | null = null;
/** Its timeline, when it's made a piece at a time; null when it's one file. */
let tl: Timeline | null = null;
/** The slot playing. */
let current = -1;
/** A part not yet made that it waits for: the slot's id, how far into it, and whether to play. */
let want: { id: string; offset: number; play: boolean } | null = null;
let lastSaved = 0;
let lastAsked = 0;

function set(patch: Partial<PlayerState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function usePlayer(): PlayerState {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
  );
}

export function playerState(): PlayerState {
  return state;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const native = isAndroid();
const PLUGIN = "plugin:audio-player|";

// ---------------------------------------------------------------------------
// Computers: two audio elements, one playing, the next piece loaded in the other
// ---------------------------------------------------------------------------

let audio: HTMLAudioElement | null = null;
let spare: HTMLAudioElement | null = null;
/** The piece loaded in `spare`. */
let spareFor: string | null = null;
const urls = new Map<HTMLAudioElement, string>();

/** The seconds into the recording the element playing is at. */
function elementPosition(): number {
  if (!audio) return state.position;
  const slot = tl?.slots[current];
  return (slot ? slot.start : 0) + audio.currentTime;
}

function onTime(a: HTMLAudioElement): void {
  if (a !== audio) return;
  const before = chapterAt(state.chapters, state.position);
  set({ position: elementPosition() });
  if (chapterAt(state.chapters, state.position) !== before) mediaSession();
  save();
  askAhead();
}

function element(): HTMLAudioElement {
  const a = new Audio();
  a.preload = "auto";
  a.addEventListener("timeupdate", () => onTime(a));
  a.addEventListener("loadedmetadata", () => {
    if (a === audio && !tl) set({ duration: Number.isFinite(a.duration) ? a.duration : state.duration });
  });
  a.addEventListener("play", () => {
    if (a !== audio) return;
    set({ playing: true, waiting: false });
    mediaSession();
  });
  a.addEventListener("pause", () => {
    if (a !== audio || a.ended) return;
    set({ playing: false });
    mediaSession();
    save(true);
  });
  a.addEventListener("ended", () => {
    if (a === audio) void onEnded();
  });
  return a;
}

// Spec: AUD-11
function mediaSessionHandlers(): void {
  if (!("mediaSession" in navigator)) return;
  const ms = navigator.mediaSession;
  ms.setActionHandler("play", () => void play());
  ms.setActionHandler("pause", () => pause());
  ms.setActionHandler("seekbackward", () => skip(-15));
  ms.setActionHandler("seekforward", () => skip(30));
  ms.setActionHandler("previoustrack", () => chapterStep(-1));
  ms.setActionHandler("nexttrack", () => chapterStep(1));
  ms.setActionHandler("seekto", (d) => {
    if (d.seekTime !== undefined) seek(d.seekTime);
  });
}

function mediaSession(): void {
  if (!("mediaSession" in navigator)) return;
  const chapter = state.chapters[chapterAt(state.chapters, state.position)];
  navigator.mediaSession.metadata = new MediaMetadata({ title: state.title, artist: "Commonplace", album: chapter?.title ?? "" });
  navigator.mediaSession.playbackState = state.playing ? "playing" : "paused";
}

/** Puts `bytes` in `a`, ready to play. */
async function fill(a: HTMLAudioElement, bytes: Uint8Array): Promise<void> {
  const old = urls.get(a);
  if (old) URL.revokeObjectURL(old);
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const url = URL.createObjectURL(new Blob([copy], { type: "audio/webm" }));
  urls.set(a, url);
  a.src = url;
  a.playbackRate = state.speed;
  await new Promise<void>((resolve, reject) => {
    a.onloadedmetadata = () => resolve();
    a.onerror = () => reject(new Error("This recording can't be played here."));
  });
}

/** Loads the piece after the one playing into the spare element, if it's made. */
function preloadNext(): void {
  if (native || !tl) return;
  const next = tl.slots[current + 1];
  if (!next?.made || spareFor === next.id) return;
  spare ??= element();
  const s = spare;
  spareFor = next.id;
  void pieceAudio(next.id)
    .then((bytes) => (spareFor === next.id ? fill(s, bytes) : undefined))
    .catch(() => {
      if (spareFor === next.id) spareFor = null;
    });
}

async function onEnded(): Promise<void> {
  const r = rec;
  if (!tl || !r) {
    set({ playing: false });
    save(true);
    return;
  }
  const next = tl.slots[current + 1];
  if (!next) {
    set({ playing: false, position: tl.duration });
    save(true);
    return;
  }
  if (next.made) {
    await start(current + 1, 0, true);
    return;
  }
  // Spec: AUD-6
  // The next part isn't made yet: wait for it.
  want = { id: next.id, offset: 0, play: true };
  current += 1;
  listenAt(r.id, next.id);
  set({ waiting: true, playing: false, position: next.start });
}

// ---------------------------------------------------------------------------
// Android: the native player
// ---------------------------------------------------------------------------

const NativeStateSchema = z.object({ id: z.string(), playing: z.boolean(), position: z.number(), duration: z.number(), ended: z.boolean().catch(false) });
let following = false;
let nativeAt = 0;

function followNative(): void {
  if (following) return;
  following = true;
  void addPluginListener("audio-player", "state", (payload: unknown) => {
    const s = NativeStateSchema.safeParse(payload);
    const id = state.recordingId;
    if (!s.success || !id || (s.data.id !== id && !s.data.id.startsWith(`${id}.`))) return;
    const wasPlaying = state.playing;
    nativeAt = s.data.position;
    if (tl) {
      const i = tl.slots.findIndex((x) => x.id === s.data.id);
      if (i >= 0) current = i;
      const slot = tl.slots[current];
      const next = tl.slots[current + 1];
      // Spec: AUD-6
      // Played to the end of what's made: it waits, and Rust adds the next piece when it's made.
      const waiting = s.data.ended && next !== undefined && !next.made;
      set({ playing: s.data.playing, waiting, position: (slot?.start ?? 0) + s.data.position });
    } else {
      set({ playing: s.data.playing, position: s.data.position, ...(s.data.duration > 0 ? { duration: s.data.duration } : {}) });
    }
    save(wasPlaying && !s.data.playing);
  }).catch(() => {
    following = false;
  });
}

function nativeCall(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return invoke(`${PLUGIN}${command}`, args).catch((e: unknown) => {
    set({ error: message(e) });
  });
}

// ---------------------------------------------------------------------------
// Both
// ---------------------------------------------------------------------------

// Spec: AUD-9
/** Saves where it is: into its piece, or into a recording kept as one file. */
function save(force = false): void {
  const id = state.recordingId;
  if (!id || want) return;
  const now = Date.now();
  if (!force && now - lastSaved < SAVE_EVERY_MS) return;
  lastSaved = now;
  const slot = tl?.slots[current];
  if (tl && slot) {
    const into = native ? nativeAt : (audio?.currentTime ?? 0);
    void saveListening(id, into, slot.id);
  } else {
    void saveListening(id, native ? state.position : (audio?.currentTime ?? state.position), null);
  }
}

// Spec: AUD-6
/** Tells Rust where it is now and then, so it makes ahead of there (Android's Rust asks the player itself). */
function askAhead(force = false): void {
  const id = state.recordingId;
  const slot = tl?.slots[current];
  // All of it made, or making it failed (it's tried again when the author seeks or asks to): nothing to ask.
  if (native || !id || !slot || rec?.error || tl?.slots.every((s) => s.made)) return;
  const now = Date.now();
  if (!force && now - lastAsked < ASK_EVERY_MS) return;
  lastAsked = now;
  listenAt(id, slot.id);
}

/** Plays the slot at `index` from `offset` seconds into it (it's made). */
async function start(index: number, offset: number, play: boolean): Promise<void> {
  const r = rec;
  const slot = tl?.slots[index];
  if (!r || !slot) return;
  current = index;
  want = null;
  set({ waiting: false, position: slot.start + offset, error: null });
  if (native) {
    nativeAt = offset;
    await invoke("audio_native_play", { id: r.id, piece: slot.id, position: offset, play, speed: state.speed }).catch((e: unknown) => set({ error: message(e) }));
    return;
  }
  const old = audio;
  if (spare && spareFor === slot.id && spare.readyState >= 1) {
    // The next piece, loaded already: swapped in.
    audio = spare;
    spare = old;
    spareFor = null;
  } else {
    audio ??= element();
    try {
      await fill(audio, await pieceAudio(slot.id));
    } catch (e) {
      set({ error: message(e) });
      return;
    }
  }
  old?.pause();
  if (rec !== r || current !== index) return;
  audio.currentTime = Math.min(offset, Math.max(0, (audio.duration || slot.seconds) - 0.05));
  audio.playbackRate = state.speed;
  if (play) await audio.play().catch((e: unknown) => set({ error: message(e) }));
  mediaSession();
  preloadNext();
  askAhead(true);
}

// Spec: AUD-6, AUD-8
/** Goes to `t` seconds into the recording: plays from there if it's made, else waits while it's made. */
async function goTo(t: number, play: boolean): Promise<void> {
  const r = rec;
  if (!tl || !r) return;
  const at = slotAt(tl, t);
  const slot = at ? tl.slots[at.index] : undefined;
  if (!at || !slot) return;
  listenAt(r.id, slot.id);
  lastAsked = Date.now();
  if (slot.made) {
    await start(at.index, at.offset, play);
    return;
  }
  current = at.index;
  want = { id: slot.id, offset: slot.passage === null ? 0 : at.offset, play };
  if (native) void nativeCall("pause");
  else audio?.pause();
  set({ waiting: true, playing: false, position: slot.start + want.offset });
}

/** What's made of the recording, again: its timeline, and the part it waits for if that's made now. */
async function refresh(): Promise<void> {
  const r = rec;
  if (!r || !tl) return;
  const fresh = await getRecording(r.id);
  if (!fresh?.script || rec !== r) return;
  rec = fresh;
  const made = await recordingPieces(r.id);
  if (rec !== fresh) return;
  const playing = tl.slots[current]?.id;
  tl = timeline(fresh.id, fresh.script, made);
  if (playing) {
    const i = tl.slots.findIndex((s) => s.id === playing);
    if (i >= 0) current = i;
  }
  const slot = tl.slots[current];
  const into = native ? nativeAt : (audio?.currentTime ?? 0);
  set({ title: fresh.title, chapters: tl.chapters, duration: tl.duration, made: tl.madeSeconds, ...(slot && !want ? { position: slot.start + into } : {}) });
  if (want) {
    const w = want;
    // A chunk not yet written was waited for by its first passage's id: once written, its first passage.
    const [c, k] = w.id.split(".").slice(-3);
    const target = tl.slots.find((s) => s.id === w.id) ?? tl.slots.find((s) => `${s.chapter}` === c && `${s.chunk}` === k);
    const i = target ? tl.slots.indexOf(target) : -1;
    if (target?.made && i >= 0) await start(i, w.offset, w.play);
    else if (target) set({ position: target.start + w.offset });
  } else {
    preloadNext();
  }
}

let followingPieces = false;

function followPieces(): void {
  if (followingPieces) return;
  followingPieces = true;
  void listen("audio-piece", (e) => {
    const p = AudioEventSchema.safeParse(e.payload);
    if (p.success && p.data.id === state.recordingId) void refresh();
  }).catch(() => {
    followingPieces = false;
  });
  // Pieces another device made arrive by sync.
  onTablesChanged(["recording_pieces", "recordings"], () => {
    if (tl) void refresh();
  });
}

// Spec: AUD-8, AUD-9
/** Puts a recording in the player, at `at` seconds or where it was left; plays if asked. */
export async function load(r: Recording, opts: { at?: number | null; play?: boolean } = {}): Promise<void> {
  if (native) followNative();
  else mediaSessionHandlers();
  followPieces();
  if (state.recordingId === r.id) {
    rec = r;
    if (tl) await refresh();
    if (opts.at !== undefined && opts.at !== null) seek(opts.at);
    if (opts.play) await play();
    return;
  }
  save(true);
  stopOutput();
  rec = r;
  tl = null;
  current = -1;
  want = null;
  // A recording made before, at once, is one file: only those have a length of their own.
  const oneFile = r.durationSeconds !== null;
  set({ recordingId: r.id, title: r.title, chapters: r.chapters, duration: r.durationSeconds ?? 0, position: 0, playing: false, loading: true, waiting: false, made: null, error: null });
  try {
    if (oneFile) {
      const saved = await getListening(r.id);
      const at = opts.at ?? (saved && saved.piece === null ? saved.position : 0);
      if (native) {
        nativeAt = at;
        await invoke("audio_native_play", { id: r.id, piece: null, position: at, play: opts.play === true, speed: state.speed });
        set({ loading: false, position: at });
      } else {
        audio ??= element();
        await fill(audio, await recordingAudio(r.id));
        if (rec !== r) return;
        audio.currentTime = at < (audio.duration || Infinity) - 1 ? at : 0;
        set({ loading: false, position: audio.currentTime, duration: Number.isFinite(audio.duration) ? audio.duration : state.duration });
        mediaSession();
        if (opts.play) await play();
      }
      return;
    }
    if (!r.script) throw new Error("Its script isn't ready yet.");
    tl = timeline(r.id, r.script, await recordingPieces(r.id));
    if (rec !== r) return;
    set({ chapters: tl.chapters, duration: tl.duration, made: tl.madeSeconds });
    const saved = opts.at === undefined || opts.at === null ? await getListening(r.id) : null;
    const at = opts.at ?? (saved ? (saved.piece ? (startOf(tl, saved.piece) ?? 0) : 0) + saved.position : 0);
    set({ loading: false });
    await goTo(at, opts.play === true);
  } catch (e) {
    set({ loading: false, error: message(e) });
  }
}

export async function play(): Promise<void> {
  if (want) {
    want = { ...want, play: true };
    set({ error: null });
    if (rec) listenAt(rec.id, want.id);
    return;
  }
  if (native) {
    await nativeCall("play");
    return;
  }
  if (!audio) return;
  try {
    await audio.play();
  } catch (e) {
    set({ error: message(e) });
  }
}

export function pause(): void {
  if (want) {
    want = { ...want, play: false };
    set({ playing: false });
    return;
  }
  if (native) void nativeCall("pause");
  else audio?.pause();
}

export function toggle(): void {
  if (state.playing || want?.play) pause();
  else void play();
}

export function seek(t: number): void {
  const to = Math.max(0, Math.min(t, state.duration > 0 ? state.duration - 0.05 : t));
  if (tl) {
    const at = slotAt(tl, to);
    const playing = state.playing || want?.play === true;
    if (at && at.index === current && !want && tl.slots[current]?.made) {
      // Within the piece playing.
      if (native) {
        nativeAt = at.offset;
        void nativeCall("seek_to", { seconds: at.offset });
      } else if (audio) audio.currentTime = at.offset;
      set({ position: to });
      save(true);
      return;
    }
    void goTo(to, playing);
    return;
  }
  if (native) {
    void nativeCall("seek_to", { seconds: to });
    set({ position: to });
    save(true);
    return;
  }
  if (!audio) return;
  audio.currentTime = to;
  set({ position: audio.currentTime });
  save(true);
}

export function skip(delta: number): void {
  seek((tl || native || !audio ? state.position : audio.currentTime) + delta);
}

export function chapterStep(delta: number): void {
  const i = chapterAt(state.chapters, state.position);
  const here = state.chapters[i];
  // Back within the first seconds of a chapter goes to the one before; later, to its start.
  const target = delta < 0 && here && state.position - here.start > 3 ? i : i + delta;
  const c = state.chapters[Math.max(0, Math.min(state.chapters.length - 1, target))];
  if (c) seek(c.start);
}

export function setSpeed(speed: number): void {
  if (native) void nativeCall("set_speed", { speed });
  if (audio) audio.playbackRate = speed;
  if (spare) spare.playbackRate = speed;
  set({ speed });
  try {
    localStorage.setItem(SPEED_KEY, String(speed));
  } catch {
    // A convenience only.
  }
}

function stopOutput(): void {
  for (const a of [audio, spare]) {
    if (!a) continue;
    a.pause();
    a.removeAttribute("src");
    const url = urls.get(a);
    if (url) URL.revokeObjectURL(url);
    urls.delete(a);
  }
  spareFor = null;
}

/** Empties the player (a recording deleted). */
export function unload(id: string): void {
  if (state.recordingId !== id) return;
  if (native) void nativeCall("stop");
  stopOutput();
  rec = null;
  tl = null;
  current = -1;
  want = null;
  set({ recordingId: null, title: "", chapters: [], duration: 0, position: 0, playing: false, waiting: false, made: null });
}
