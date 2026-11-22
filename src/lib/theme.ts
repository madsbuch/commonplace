/**
 * Light and dark (APP-4, APP-5).
 *
 * The palette is tokens in App.css, the spec's `color.*` values.
 * `data-theme="light" | "dark"` on <html> picks one: the theme the author
 * pinned on this device, or, following the system, whichever it is in.
 *
 * The choice is kept in localStorage rather than the settings table: it has to
 * be known before the first paint, or the app flashes the wrong colours while
 * SQLite opens, and it's a per-device preference anyway. (As in Tally.)
 *
 * A change animates over `theme.transition`: where the WebView has View
 * Transitions, a pick grows out of the button pressed and a system change
 * fades in; where it doesn't (some Linux WebKits), the colours cross-fade.
 * With reduced motion asked for, it just switches.
 */
import { useSyncExternalStore } from "react";

export type ThemePref = "system" | "light" | "dark";
export type Theme = "light" | "dark";

const KEY = "commonplace.theme";
const PREFS: readonly ThemePref[] = ["system", "light", "dark"];

// Spec: APP-5
/** `theme.transition` in the spec. */
export const THEME_TRANSITION_MS = 480;

/** `color.paper` in each theme: what the window shows behind the page. */
const PAPER: Record<Theme, string> = { light: "#faf7f1", dark: "#15171c" };

const darkQuery = (): MediaQueryList | null =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: dark)") : null;

function storedPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return PREFS.find((p) => p === v) ?? "system";
  } catch {
    return "system";
  }
}

function resolve(pref: ThemePref): Theme {
  if (pref !== "system") return pref;
  return darkQuery()?.matches ? "dark" : "light";
}

/** A point on screen, in CSS pixels from the top left. */
export interface Origin {
  x: number;
  y: number;
}

let pref: ThemePref = "system";
let theme: Theme = "light";
let switches = 0;
const listeners = new Set<() => void>();

function reducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function paint(mode: Theme): void {
  const root = document.documentElement;
  root.setAttribute("data-theme", mode);
  root.style.colorScheme = mode;
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.content = PAPER[mode];
  theme = mode;
  for (const l of listeners) l();
}

// Spec: APP-5
/** Switches to `pref`'s theme, animated when it changes what's on screen. */
function apply(next: ThemePref, from?: Origin): void {
  const mode = resolve(next);
  const root = document.documentElement;
  const before = root.getAttribute("data-theme");
  const n = ++switches;
  if (before === null || before === mode || reducedMotion()) {
    paint(mode);
    return;
  }
  if ("startViewTransition" in document && typeof document.startViewTransition === "function") {
    root.classList.toggle("theme-reveal", from !== undefined);
    const transition = document.startViewTransition(() => paint(mode));
    if (from) {
      void transition.ready
        .then(() => {
          // Out to the farthest corner, so the circle ends covering it all.
          const r = Math.hypot(Math.max(from.x, window.innerWidth - from.x), Math.max(from.y, window.innerHeight - from.y));
          root.animate(
            { clipPath: [`circle(0px at ${from.x}px ${from.y}px)`, `circle(${r}px at ${from.x}px ${from.y}px)`] },
            { duration: THEME_TRANSITION_MS, easing: "cubic-bezier(0.4, 0, 0.2, 1)", pseudoElement: "::view-transition-new(root)" },
          );
        })
        .catch(() => {
          // Overtaken by another switch: the theme is applied anyway.
        });
    }
    void transition.finished
      .catch(() => undefined)
      .then(() => {
        if (n === switches) root.classList.remove("theme-reveal");
      });
    return;
  }
  // No View Transitions: let every colour ease into the new one.
  root.classList.add("theme-fade");
  paint(mode);
  setTimeout(() => {
    if (n === switches) root.classList.remove("theme-fade");
  }, THEME_TRANSITION_MS + 40);
}

// Spec: APP-4
/** Picks a theme for this device; `from` is the middle of the button pressed. */
export function setThemePref(next: ThemePref, from?: Origin): void {
  try {
    if (next === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {
    // Storage unavailable: still switch for this session.
  }
  pref = next;
  apply(next, from);
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The theme on screen, live. */
export function useColorScheme(): Theme {
  return useSyncExternalStore(subscribe, () => theme);
}

/** The author's pick on this device ("system" when following it), live. */
export function useThemePref(): ThemePref {
  return useSyncExternalStore(subscribe, () => pref);
}

/** Call once, before React renders. */
export function installTheme(): void {
  pref = storedPref();
  apply(pref);
  const follow = () => {
    if (pref === "system") apply(pref);
  };
  darkQuery()?.addEventListener("change", follow);
  // Back from the background: the system may have switched meanwhile.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") follow();
  });
}
