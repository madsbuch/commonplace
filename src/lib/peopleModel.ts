// ---------------------------------------------------------------------------
// People and institutions without the database: matching names, resolving
// merged records, and splitting an author line. lib/people.ts does the I/O.
// ---------------------------------------------------------------------------

/** A person or institution row, as far as resolving and matching go. */
export interface Named {
  id: string;
  name: string;
  mergedInto: string | null;
}

/** Lower case, accents and punctuation gone, single spaces. */
export function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** "Turing, Alan M." → "Alan M. Turing"; anything else as it is. */
export function naturalOrder(name: string): string {
  const parts = name.split(",");
  if (parts.length === 2 && (parts[0] ?? "").trim() !== "" && (parts[1] ?? "").trim() !== "") {
    return `${(parts[1] ?? "").trim()} ${(parts[0] ?? "").trim()}`;
  }
  return name.trim();
}

function personParts(name: string): { surname: string; given: string[] } {
  const words = normalizeName(naturalOrder(name)).split(" ").filter(Boolean);
  return { surname: words[words.length - 1] ?? "", given: words.slice(0, -1) };
}

/** Two given names agree: the same, or one is the other's initial. */
function givenAgrees(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length === 1) return b.startsWith(a);
  if (b.length === 1) return a.startsWith(b);
  return false;
}

// Spec: PPL-2
/**
 * Whether two people's names can be the same person: the same surname, and
 * first given names that agree (initials match whole names). Middle names
 * one side leaves out don't count against it.
 */
export function samePersonName(a: string, b: string): boolean {
  const x = personParts(a);
  const y = personParts(b);
  if (x.surname === "" || x.surname !== y.surname) return false;
  const [fx] = x.given;
  const [fy] = y.given;
  if (fx === undefined || fy === undefined) return fx === fy;
  if (!givenAgrees(fx, fy)) return false;
  // Middle names present on both sides have to agree too.
  const n = Math.min(x.given.length, y.given.length);
  for (let i = 1; i < n; i++) if (!givenAgrees(x.given[i] ?? "", y.given[i] ?? "")) return false;
  return true;
}

// Spec: PPL-2
/**
 * The one existing person a name links to: the only one with the same name
 * (case, accents and punctuation aside), else the only one whose name can be
 * the same person's. Null when there's none, or more than one.
 */
export function matchPerson(name: string, existing: readonly Named[]): string | null {
  const live = existing.filter((p) => p.mergedInto === null);
  const exact = live.filter((p) => normalizeName(naturalOrder(p.name)) === normalizeName(naturalOrder(name)));
  if (exact.length === 1) return exact[0]?.id ?? null;
  if (exact.length > 1) return null;
  const close = live.filter((p) => samePersonName(p.name, name));
  return close.length === 1 ? (close[0]?.id ?? null) : null;
}

// Spec: PPL-2
/** The one existing institution with the same name, case, accents and punctuation aside. */
export function matchInstitution(name: string, existing: readonly Named[]): string | null {
  const live = existing.filter((i) => i.mergedInto === null && normalizeName(i.name) === normalizeName(name));
  return live.length === 1 ? (live[0]?.id ?? null) : null;
}

// Spec: PPL-5
/**
 * Who each record now is, after merges: follow `merged_into` to the end.
 * Merges made on two devices at once can form a cycle (A into B, B into A);
 * every device then settles on the cycle's smallest id, so they agree.
 */
export function resolver(rows: readonly Named[]): (id: string) => string {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const memo = new Map<string, string>();
  return (id) => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    const path: string[] = [];
    const seen = new Set<string>();
    let cur = id;
    for (;;) {
      if (seen.has(cur)) {
        // A cycle: its members are the path from where `cur` first appeared.
        const cycle = path.slice(path.indexOf(cur));
        const root = [...cycle].sort()[0] ?? cur;
        for (const p of path) memo.set(p, root);
        return root;
      }
      seen.add(cur);
      path.push(cur);
      const next = byId.get(cur)?.mergedInto ?? null;
      if (next === null || !byId.has(next)) break;
      cur = next;
    }
    for (const p of path) memo.set(p, cur);
    return cur;
  };
}

/** Every id that resolves to `id`'s record (itself included). */
export function groupOf(rows: readonly Named[], id: string): string[] {
  const resolve = resolver(rows);
  const root = resolve(id);
  return rows.filter((r) => resolve(r.id) === root).map((r) => r.id);
}

// Spec: LIB-9
/** An author line from a PDF's metadata ("A, B and C"; "A; B") as names. */
export function splitAuthors(line: string): string[] {
  const s = line.trim();
  if (s === "") return [];
  // "Surname, Given" alone is one name, not two.
  if (/^[^,;&]+,\s*[^,;&\s]+(\s+[^,;&\s]\.?)*$/.test(s) && !/\band\b/i.test(s)) return [naturalOrder(s)];
  return s
    .split(/\s*(?:;|&|\band\b|,)\s*/i)
    .map((n) => n.trim())
    .filter((n) => n !== "");
}
