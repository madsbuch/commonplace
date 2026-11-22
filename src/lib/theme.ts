import { useSyncExternalStore } from "react";

const query = () => window.matchMedia("(prefers-color-scheme: dark)");

function subscribe(fn: () => void): () => void {
  const q = query();
  q.addEventListener("change", fn);
  return () => q.removeEventListener("change", fn);
}

/** The system's colour scheme, live. */
export function useColorScheme(): "light" | "dark" {
  return useSyncExternalStore(subscribe, () => (query().matches ? "dark" : "light"));
}
