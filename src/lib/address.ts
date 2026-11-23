// ---------------------------------------------------------------------------
// The address holds what a screen shows within it (APP-10): where it's
// scrolled to, in the fragment, and what's chosen, in the query. Both are
// kept current by replacing the address, never by adding a step (APP-11).
//
// The fragment is written straight to the browser's history, past the
// router, so scrolling never re-renders a screen. The router's own location
// keeps the fragment it last navigated to; a screen reacts to the router's
// changes only, which are always navigations (a link, Back), never its own
// scrolling.
// ---------------------------------------------------------------------------

import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { setAddress } from "./currentView";

/** WebKit refuses more than 100 history changes in 10 seconds: write at most this often. */
const FRAGMENT_EVERY_MS = 250;

/** The fragment waiting to be written, and the screen (path) it belongs to. */
let pending: { path: string; fragment: string } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function write(): void {
  timer = null;
  const p = pending;
  pending = null;
  const { pathname, search, hash } = window.location;
  // The author has moved on to another screen meanwhile: it isn't theirs.
  if (!p || p.path !== pathname) return;
  const next = p.fragment ? `#${p.fragment}` : "";
  if (hash === next) return;
  try {
    window.history.replaceState(window.history.state, "", `${pathname}${search}${next}`);
    setAddress(`${pathname}${search}${next}`);
  } catch {
    // Too many changes too quickly: the next scroll writes it.
  }
}

// Spec: APP-10, APP-11
/** Puts where the screen is scrolled to in the address's fragment (without `#`; empty clears it). */
export function replaceFragment(fragment: string): void {
  pending = { path: window.location.pathname, fragment };
  timer ??= setTimeout(write, FRAGMENT_EVERY_MS);
}

// Spec: LIB-22
/** The PDF page a fragment names (`page=12`), if any. */
export function pageOfFragment(hash: string): number | null {
  const m = /^#?page=(\d+)$/.exec(hash);
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : null;
}

// Spec: APP-10, APP-11
/**
 * One value of the address's query, and a setter that replaces the address
 * (empty or `null` drops it, so a screen's defaults keep a clean address).
 */
export function useQueryParam(name: string): [string | null, (value: string | null) => void] {
  const [params, setParams] = useSearchParams();
  const set = useCallback(
    (value: string | null) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value === null || value === "") next.delete(name);
          else next.set(name, value);
          return next;
        },
        { replace: true, preventScrollReset: true },
      ),
    [setParams, name],
  );
  return [params.get(name), set];
}
