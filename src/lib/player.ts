// ---------------------------------------------------------------------------
// The one player (AUD-8, AUD-9, AUD-11): an audio element for the whole app,
// so a recording keeps playing from screen to screen, with chapters, speed,
// and the media keys (Media Session). Where it is is saved as it plays, and
// a recording starts where it was left, on any device. A state outside
// React, like the assistant's runner; screens subscribe.
// ---------------------------------------------------------------------------

import { useSyncExternalStore } from "react";
import { getListening, recordingAudio, saveListening } from "./audio";
import { chapterAt } from "./audioModel";
import type { Recording, RecordingChapter } from "./schemas";

export interface PlayerState {
  recordingId: string | null;
  title: string;
  chapters: RecordingChapter[];
  duration: number;
  position: number;
  playing: boolean;
  speed: number;
  loading: boolean;
  error: string | null;
}

const SPEED_KEY = "player-speed";
/** How often, while playing, where it is is saved. */
const SAVE_EVERY_MS = 5000;

function savedSpeed(): number {
  try {
    const n = Number(localStorage.getItem(SPEED_KEY));
    return n > 0 ? n : 1;
  } catch {
    return 1;
  }
}

let state: PlayerState = { recordingId: null, title: "", chapters: [], duration: 0, position: 0, playing: false, speed: savedSpeed(), loading: false, error: null };
const listeners = new Set<() => void>();
let audio: HTMLAudioElement | null = null;
let url: string | null = null;
let lastSaved = 0;

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

// Spec: AUD-9
function save(force = false): void {
  const id = state.recordingId;
  if (!id || !audio) return;
  const now = Date.now();
  if (!force && now - lastSaved < SAVE_EVERY_MS) return;
  lastSaved = now;
  void saveListening(id, audio.currentTime);
}

// Spec: AUD-11
function mediaSession(): void {
  if (!("mediaSession" in navigator)) return;
  const chapter = state.chapters[chapterAt(state.chapters, state.position)];
  navigator.mediaSession.metadata = new MediaMetadata({ title: state.title, artist: "Commonplace", album: chapter?.title ?? "" });
  navigator.mediaSession.playbackState = state.playing ? "playing" : "paused";
}

function element(): HTMLAudioElement {
  if (audio) return audio;
  const a = new Audio();
  a.preload = "auto";
  a.addEventListener("timeupdate", () => {
    const before = chapterAt(state.chapters, state.position);
    set({ position: a.currentTime });
    if (chapterAt(state.chapters, a.currentTime) !== before) mediaSession();
    save();
  });
  a.addEventListener("loadedmetadata", () => set({ duration: Number.isFinite(a.duration) ? a.duration : state.duration }));
  a.addEventListener("play", () => {
    set({ playing: true });
    mediaSession();
  });
  a.addEventListener("pause", () => {
    set({ playing: false });
    mediaSession();
    save(true);
  });
  a.addEventListener("ended", () => save(true));
  if ("mediaSession" in navigator) {
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
  audio = a;
  return a;
}

// Spec: AUD-8, AUD-9
/** Puts a recording in the player, at `at` seconds or where it was left; plays if asked. */
export async function load(rec: Recording, opts: { at?: number | null; play?: boolean } = {}): Promise<void> {
  const a = element();
  if (state.recordingId !== rec.id) {
    save(true);
    a.pause();
    set({ recordingId: rec.id, title: rec.title, chapters: rec.chapters, duration: rec.durationSeconds ?? 0, position: 0, loading: true, error: null });
    try {
      const bytes = await recordingAudio(rec.id);
      if (state.recordingId !== rec.id) return;
      if (url) URL.revokeObjectURL(url);
      const copy = new Uint8Array(bytes.length);
      copy.set(bytes);
      url = URL.createObjectURL(new Blob([copy], { type: "audio/webm" }));
      a.src = url;
      a.playbackRate = state.speed;
      await new Promise<void>((resolve, reject) => {
        a.onloadedmetadata = () => resolve();
        a.onerror = () => reject(new Error("This recording can't be played here."));
      });
      const at = opts.at ?? (await getListening(rec.id)) ?? 0;
      a.currentTime = at < (a.duration || Infinity) - 1 ? at : 0;
      set({ loading: false, position: a.currentTime });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : String(e) });
      return;
    }
  } else {
    set({ title: rec.title, chapters: rec.chapters });
    if (opts.at !== undefined && opts.at !== null) seek(opts.at);
  }
  mediaSession();
  if (opts.play) await play();
}

export async function play(): Promise<void> {
  try {
    await element().play();
  } catch (e) {
    set({ error: e instanceof Error ? e.message : String(e) });
  }
}

export function pause(): void {
  audio?.pause();
}

export function toggle(): void {
  if (state.playing) pause();
  else void play();
}

export function seek(t: number): void {
  const a = element();
  a.currentTime = Math.max(0, Math.min(t, (a.duration || state.duration || t) - 0.05));
  set({ position: a.currentTime });
  save(true);
}

export function skip(delta: number): void {
  seek((audio?.currentTime ?? state.position) + delta);
}

export function chapterStep(delta: number): void {
  const i = chapterAt(state.chapters, state.position);
  const current = state.chapters[i];
  // Back within the first seconds of a chapter goes to the one before; later, to its start.
  const target = delta < 0 && current && state.position - current.start > 3 ? i : i + delta;
  const c = state.chapters[Math.max(0, Math.min(state.chapters.length - 1, target))];
  if (c) seek(c.start);
}

export function setSpeed(speed: number): void {
  if (audio) audio.playbackRate = speed;
  set({ speed });
  try {
    localStorage.setItem(SPEED_KEY, String(speed));
  } catch {
    // A convenience only.
  }
}

/** Empties the player (a recording deleted). */
export function unload(id: string): void {
  if (state.recordingId !== id) return;
  audio?.pause();
  audio?.removeAttribute("src");
  if (url) URL.revokeObjectURL(url);
  url = null;
  set({ recordingId: null, title: "", chapters: [], duration: 0, position: 0, playing: false });
}
