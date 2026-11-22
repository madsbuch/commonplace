// The things an id can name in an assistant message (CHAT-7): a page or a
// block, a library item, a person or an institution. Each has a title and an
// address. Ids are TypeIDs, so the prefix says which.

import { splitTypeIds } from "./ids";
import { blockInfo, getItem, institutionView, pageTitle, personView } from "./lookup";
import { pagePath } from "./navigation";

export interface Entity {
  id: string;
  title: string;
  path: string;
  kind: "page" | "block" | "library item" | "person" | "institution";
}

const cache = new Map<string, Promise<Entity | null>>();

async function resolveEntity(id: string): Promise<Entity | null> {
  const prefix = id.slice(0, id.lastIndexOf("_"));
  if (prefix === "blk") {
    const b = await blockInfo(id);
    if (!b) return null;
    if (b.type === "page") return { id, title: (await pageTitle(id)) ?? b.text, path: pagePath(id), kind: "page" };
    const page = b.pageId ? await pageTitle(b.pageId) : null;
    const snippet = b.text.length > 40 ? `${b.text.slice(0, 40)}…` : b.text;
    return { id, title: page ? `${page} › ${snippet}` : snippet, path: b.pageId ? pagePath(b.pageId, id) : "/", kind: "block" };
  }
  if (prefix === "lib") {
    const item = await getItem(id);
    return item ? { id, title: item.title, path: `/library/${id}`, kind: "library item" } : null;
  }
  if (prefix === "person") {
    const v = await personView(id);
    return v ? { id, title: v.person.name, path: `/library/people/${v.person.id}`, kind: "person" } : null;
  }
  if (prefix === "institution") {
    const v = await institutionView(id);
    return v ? { id, title: v.institution.name, path: `/library/institutions/${v.institution.id}`, kind: "institution" } : null;
  }
  return null;
}

/** What an id names, or null (cached for the session; titles change rarely). */
export function entityOf(id: string): Promise<Entity | null> {
  let p = cache.get(id);
  if (!p) {
    p = resolveEntity(id).catch(() => null);
    cache.set(id, p);
  }
  return p;
}

/** Forget cached titles (after the book or library changed). */
export function clearEntityCache(): void {
  cache.clear();
}

export { splitTypeIds };
