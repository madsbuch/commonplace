// The book's page tree and titles, kept current for every screen that shows
// them (the sidebar, page blocks, links). One query for all of them, re-run
// when blocks change wherever the change came from.

import { useSyncExternalStore } from "react";
import { onTablesChanged } from "./live";
import { loadPageTree } from "./book";
import { flattenTree, UNTITLED, type PageNode } from "./bookModel";

interface Index {
  tree: PageNode[];
  titles: Map<string, string>;
  parents: Map<string, string | null>;
}

let index: Index = { tree: [], titles: new Map(), parents: new Map() };
let loaded = false;
const subscribers = new Set<() => void>();

async function refresh(): Promise<void> {
  try {
    const tree = await loadPageTree();
    const flat = flattenTree(tree);
    index = {
      tree,
      titles: new Map(flat.map(({ node }) => [node.id, node.title])),
      parents: new Map(flat.map(({ node }) => [node.id, node.parentPageId])),
    };
    loaded = true;
    for (const s of subscribers) s();
  } catch (e) {
    console.error("Loading the page tree failed", e);
  }
}

let started = false;
function start(): void {
  if (started) return;
  started = true;
  void refresh();
  onTablesChanged(["blocks"], () => void refresh());
}

function subscribe(fn: () => void): () => void {
  start();
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** The page tree, titles and parents, live. */
export function usePageIndex(): Index {
  return useSyncExternalStore(subscribe, () => index);
}

/** Whether the index has loaded at least once. */
export function usePageIndexLoaded(): boolean {
  return useSyncExternalStore(subscribe, () => loaded);
}

/** A page's title, live. */
export function usePageTitle(id: string): string {
  return useSyncExternalStore(subscribe, () => index.titles.get(id) ?? UNTITLED);
}

/** A page's title now, for code outside React. */
export function pageTitleNow(id: string): string {
  return index.titles.get(id) ?? UNTITLED;
}

/** The pages from the top down to `id` (inclusive). */
export function breadcrumbs(idx: Index, id: string): { id: string; title: string }[] {
  const out: { id: string; title: string }[] = [];
  for (let cur: string | null | undefined = id; cur; cur = idx.parents.get(cur)) {
    out.unshift({ id: cur, title: idx.titles.get(cur) ?? UNTITLED });
    if (out.length > 64) break;
  }
  return out;
}
