// Whether the assistant is open beside the screen (CHAT-3), remembered per
// device in the browser's storage (a convenience only).

import { useSyncExternalStore } from "react";

const KEY = "assistant-open";
let open = (() => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
})();
const listeners = new Set<() => void>();

export function setDockOpen(next: boolean): void {
  open = next;
  try {
    localStorage.setItem(KEY, next ? "1" : "0");
  } catch {
    // A convenience only.
  }
  for (const l of listeners) l();
}

export function toggleDock(): void {
  setDockOpen(!open);
}

export function useDockOpen(): boolean {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => open,
  );
}
