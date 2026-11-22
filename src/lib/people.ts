// ---------------------------------------------------------------------------
// People and institutions in the database: an item's authors and where they
// were, linking new names to existing records, merging, and what the library
// has from a person or a place. The decisions are in lib/peopleModel.ts.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { execute, nowIso, select } from "./db";
import { newId } from "./ids";
import { groupOf, matchInstitution, matchPerson, resolver, type Named } from "./peopleModel";

export const PEOPLE_TABLES = ["people", "institutions", "authorships", "affiliations", "library_items"] as const;

const NamedSchema = z
  .object({ id: z.string(), name: z.string(), merged_into: z.string().nullable() })
  .transform((r): Named => ({ id: r.id, name: r.name, mergedInto: r.merged_into }));

export async function loadPeople(): Promise<Named[]> {
  return z.array(NamedSchema).parse(await select(`SELECT id, name, merged_into FROM people`));
}

export async function loadInstitutions(): Promise<Named[]> {
  return z.array(NamedSchema).parse(await select(`SELECT id, name, merged_into FROM institutions`));
}

/** An item's author, with the institutions they're listed with on it. */
export interface ItemAuthor {
  authorshipId: string;
  personId: string;
  name: string;
  institutions: { affiliationId: string; id: string; name: string }[];
}

const AuthorshipRowSchema = z.object({ id: z.string(), item_id: z.string(), person_id: z.string(), position: z.number() });
const AffiliationRowSchema = z.object({ id: z.string(), authorship_id: z.string(), institution_id: z.string() });

/** Authors of the given items, in their order, resolved through merges. */
async function authorsOf(itemIds: readonly string[]): Promise<Map<string, ItemAuthor[]>> {
  const out = new Map<string, ItemAuthor[]>();
  if (itemIds.length === 0) return out;
  const marks = itemIds.map((_, i) => `$${i + 1}`).join(", ");
  const ships = z
    .array(AuthorshipRowSchema)
    .parse(await select(`SELECT id, item_id, person_id, position FROM authorships WHERE item_id IN (${marks}) ORDER BY position, id`, [...itemIds]));
  const affs = ships.length
    ? z
        .array(AffiliationRowSchema)
        .parse(
          await select(
            `SELECT id, authorship_id, institution_id FROM affiliations WHERE authorship_id IN (${ships.map((_, i) => `$${i + 1}`).join(", ")}) ORDER BY id`,
            ships.map((s) => s.id),
          ),
        )
    : [];
  const [people, insts] = await Promise.all([loadPeople(), loadInstitutions()]);
  const rp = resolver(people);
  const ri = resolver(insts);
  const personName = new Map(people.map((p) => [p.id, p.name]));
  const instName = new Map(insts.map((i) => [i.id, i.name]));
  for (const s of ships) {
    const pid = rp(s.person_id);
    const list = out.get(s.item_id) ?? [];
    list.push({
      authorshipId: s.id,
      personId: pid,
      name: personName.get(pid) ?? "Unknown",
      institutions: affs
        .filter((a) => a.authorship_id === s.id)
        .map((a) => {
          const iid = ri(a.institution_id);
          return { affiliationId: a.id, id: iid, name: instName.get(iid) ?? "Unknown" };
        }),
    });
    out.set(s.item_id, list);
  }
  return out;
}

// Spec: PPL-1
export async function itemAuthors(itemId: string): Promise<ItemAuthor[]> {
  return (await authorsOf([itemId])).get(itemId) ?? [];
}

/** Keeps `library_items.authors` (the line shown in lists and searched) in step with the authorships. */
async function refreshAuthorLine(itemId: string): Promise<void> {
  const line = (await itemAuthors(itemId)).map((a) => a.name).join(", ");
  await execute(`UPDATE library_items SET authors = $2 WHERE id = $1 AND authors != $2`, [itemId, line]);
}

// Spec: PPL-2
/** The person `name` means: an existing one when exactly one matches, else a new one. */
async function personFor(name: string, known: Named[]): Promise<string> {
  const match = matchPerson(name, known);
  if (match) return resolver(known)(match);
  const id = newId("people");
  const at = nowIso();
  await execute(`INSERT INTO people (id, name, merged_into, created_at, updated_at) VALUES ($1, $2, NULL, $3, $3)`, [id, name.trim(), at]);
  known.push({ id, name: name.trim(), mergedInto: null });
  return id;
}

// Spec: PPL-2
async function institutionFor(name: string, known: Named[]): Promise<string> {
  const match = matchInstitution(name, known);
  if (match) return resolver(known)(match);
  const id = newId("institutions");
  const at = nowIso();
  await execute(`INSERT INTO institutions (id, name, merged_into, created_at, updated_at) VALUES ($1, $2, NULL, $3, $3)`, [id, name.trim(), at]);
  known.push({ id, name: name.trim(), mergedInto: null });
  return id;
}

async function deleteAuthorships(itemId: string): Promise<void> {
  await execute(`DELETE FROM affiliations WHERE authorship_id IN (SELECT id FROM authorships WHERE item_id = $1)`, [itemId]);
  await execute(`DELETE FROM authorships WHERE item_id = $1`, [itemId]);
}

// Spec: PPL-1, PPL-2
/** Replaces an item's authors and their institutions, linking names to existing people and institutions. */
export async function setItemAuthors(itemId: string, authors: readonly { name: string; institutions: readonly string[] }[]): Promise<void> {
  await deleteAuthorships(itemId);
  const people = await loadPeople();
  const insts = await loadInstitutions();
  const at = nowIso();
  let position = 0;
  for (const a of authors) {
    if (a.name.trim() === "") continue;
    const personId = await personFor(a.name, people);
    const shipId = newId("authorships");
    await execute(`INSERT INTO authorships (id, item_id, person_id, position, created_at) VALUES ($1, $2, $3, $4, $5)`, [
      shipId,
      itemId,
      personId,
      position++,
      at,
    ]);
    const seen = new Set<string>();
    for (const name of a.institutions) {
      if (name.trim() === "") continue;
      const instId = await institutionFor(name, insts);
      if (seen.has(instId)) continue;
      seen.add(instId);
      await execute(`INSERT INTO affiliations (id, authorship_id, institution_id) VALUES ($1, $2, $3)`, [newId("affiliations"), shipId, instId]);
    }
  }
  await refreshAuthorLine(itemId);
}

/** Removes an item's authorships with the item (the people and institutions stay). */
export async function removeItemAuthors(itemId: string): Promise<void> {
  await deleteAuthorships(itemId);
}

// Spec: PPL-7
/** Adds an author at the end of an item's list: an existing person by id, or a name. */
export async function addAuthor(itemId: string, who: { personId: string } | { name: string }): Promise<void> {
  const personId = "personId" in who ? who.personId : await personFor(who.name, await loadPeople());
  const rows = z
    .array(z.object({ n: z.number().nullable() }))
    .parse(await select(`SELECT max(position) AS n FROM authorships WHERE item_id = $1`, [itemId]));
  await execute(`INSERT INTO authorships (id, item_id, person_id, position, created_at) VALUES ($1, $2, $3, $4, $5)`, [
    newId("authorships"),
    itemId,
    personId,
    (rows[0]?.n ?? -1) + 1,
    nowIso(),
  ]);
  await refreshAuthorLine(itemId);
}

// Spec: PPL-7
export async function removeAuthorship(itemId: string, authorshipId: string): Promise<void> {
  await execute(`DELETE FROM affiliations WHERE authorship_id = $1`, [authorshipId]);
  await execute(`DELETE FROM authorships WHERE id = $1`, [authorshipId]);
  await refreshAuthorLine(itemId);
}

// Spec: PPL-7
export async function addAffiliation(authorshipId: string, where: { institutionId: string } | { name: string }): Promise<void> {
  const institutionId = "institutionId" in where ? where.institutionId : await institutionFor(where.name, await loadInstitutions());
  await execute(`INSERT INTO affiliations (id, authorship_id, institution_id) VALUES ($1, $2, $3)`, [newId("affiliations"), authorshipId, institutionId]);
}

export async function removeAffiliation(affiliationId: string): Promise<void> {
  await execute(`DELETE FROM affiliations WHERE id = $1`, [affiliationId]);
}

// Spec: PPL-6
export async function renamePerson(id: string, name: string): Promise<void> {
  if (name.trim() === "") return;
  await execute(`UPDATE people SET name = $2, updated_at = $3 WHERE id = $1 AND name != $2`, [resolver(await loadPeople())(id), name.trim(), nowIso()]);
  for (const itemId of await itemsOfPeople(groupOf(await loadPeople(), id))) await refreshAuthorLine(itemId);
}

export async function renameInstitution(id: string, name: string): Promise<void> {
  if (name.trim() === "") return;
  await execute(`UPDATE institutions SET name = $2, updated_at = $3 WHERE id = $1 AND name != $2`, [
    resolver(await loadInstitutions())(id),
    name.trim(),
    nowIso(),
  ]);
}

// Spec: PPL-5
/** Marks `fromId` as the same person as `intoId`: from then on, they are one. */
export async function mergePeople(fromId: string, intoId: string): Promise<void> {
  const people = await loadPeople();
  const r = resolver(people);
  const from = r(fromId);
  const into = r(intoId);
  if (from === into) return;
  await execute(`UPDATE people SET merged_into = $2, updated_at = $3 WHERE id = $1`, [from, into, nowIso()]);
  for (const itemId of await itemsOfPeople(groupOf(await loadPeople(), into))) await refreshAuthorLine(itemId);
}

// Spec: PPL-5
export async function mergeInstitutions(fromId: string, intoId: string): Promise<void> {
  const r = resolver(await loadInstitutions());
  const from = r(fromId);
  const into = r(intoId);
  if (from === into) return;
  await execute(`UPDATE institutions SET merged_into = $2, updated_at = $3 WHERE id = $1`, [from, into, nowIso()]);
}

async function itemsOfPeople(personIds: readonly string[]): Promise<string[]> {
  if (personIds.length === 0) return [];
  const rows = z
    .array(z.object({ item_id: z.string() }))
    .parse(await select(`SELECT DISTINCT item_id FROM authorships WHERE person_id IN (${personIds.map((_, i) => `$${i + 1}`).join(", ")})`, [...personIds]));
  return rows.map((r) => r.item_id);
}

/** A short line about an item, for lists. */
export interface ItemLine {
  id: string;
  title: string;
  year: number | null;
  kind: string;
}

const ItemLineSchema = z.object({ id: z.string(), title: z.string(), year: z.number().nullable(), kind: z.string() });

async function itemLines(ids: readonly string[]): Promise<ItemLine[]> {
  if (ids.length === 0) return [];
  return z
    .array(ItemLineSchema)
    .parse(
      await select(
        `SELECT id, title, year, kind FROM library_items WHERE id IN (${ids.map((_, i) => `$${i + 1}`).join(", ")}) ORDER BY coalesce(year, 0) DESC, title`,
        [...ids],
      ),
    );
}

/** Counts of items per person or institution, for the browse lists. */
export interface Counted {
  id: string;
  name: string;
  items: number;
}

// Spec: PPL-3
/** A person: their items, the institutions they were listed with, and who they wrote with. */
export async function personView(id: string): Promise<{ person: Named; items: ItemLine[]; institutions: Counted[]; coauthors: Counted[] } | null> {
  const people = await loadPeople();
  const r = resolver(people);
  const root = r(id);
  const person = people.find((p) => p.id === root);
  if (!person) return null;
  const group = groupOf(people, root);
  const itemIds = await itemsOfPeople(group);
  const authors = await authorsOf(itemIds);
  const insts = new Map<string, Counted>();
  const co = new Map<string, Counted>();
  for (const list of authors.values()) {
    for (const a of list) {
      if (a.personId === root) {
        for (const i of a.institutions) insts.set(i.id, { id: i.id, name: i.name, items: (insts.get(i.id)?.items ?? 0) + 1 });
      } else {
        co.set(a.personId, { id: a.personId, name: a.name, items: (co.get(a.personId)?.items ?? 0) + 1 });
      }
    }
  }
  const byCount = (a: Counted, b: Counted) => b.items - a.items || a.name.localeCompare(b.name);
  return { person, items: await itemLines(itemIds), institutions: [...insts.values()].sort(byCount), coauthors: [...co.values()].sort(byCount) };
}

// Spec: PPL-4
/** An institution: the items with an author listed there, and those authors. */
export async function institutionView(id: string): Promise<{ institution: Named; items: ItemLine[]; people: Counted[] } | null> {
  const insts = await loadInstitutions();
  const root = resolver(insts)(id);
  const institution = insts.find((i) => i.id === root);
  if (!institution) return null;
  const group = groupOf(insts, root);
  const rows = z
    .array(z.object({ item_id: z.string() }))
    .parse(
      await select(
        `SELECT DISTINCT s.item_id FROM affiliations a JOIN authorships s ON s.id = a.authorship_id
         WHERE a.institution_id IN (${group.map((_, i) => `$${i + 1}`).join(", ")})`,
        group,
      ),
    );
  const itemIds = rows.map((r) => r.item_id);
  const authors = await authorsOf(itemIds);
  const ppl = new Map<string, Counted>();
  for (const list of authors.values()) {
    for (const a of list) {
      if (a.institutions.some((i) => i.id === root)) ppl.set(a.personId, { id: a.personId, name: a.name, items: (ppl.get(a.personId)?.items ?? 0) + 1 });
    }
  }
  return {
    institution,
    items: await itemLines(itemIds),
    people: [...ppl.values()].sort((a, b) => b.items - a.items || a.name.localeCompare(b.name)),
  };
}

/** Everyone with at least one item, and how many. */
export async function listPeople(): Promise<Counted[]> {
  const people = await loadPeople();
  const r = resolver(people);
  const rows = z.array(z.object({ person_id: z.string(), n: z.number() })).parse(
    await select(`SELECT person_id, count(DISTINCT item_id) AS n FROM authorships GROUP BY person_id`),
  );
  const name = new Map(people.map((p) => [p.id, p.name]));
  const out = new Map<string, Counted>();
  for (const row of rows) {
    const id = r(row.person_id);
    out.set(id, { id, name: name.get(id) ?? "Unknown", items: (out.get(id)?.items ?? 0) + row.n });
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Every institution with at least one item, and how many. */
export async function listInstitutions(): Promise<Counted[]> {
  const insts = await loadInstitutions();
  const r = resolver(insts);
  const rows = z.array(z.object({ institution_id: z.string(), n: z.number() })).parse(
    await select(
      `SELECT a.institution_id, count(DISTINCT s.item_id) AS n FROM affiliations a JOIN authorships s ON s.id = a.authorship_id GROUP BY a.institution_id`,
    ),
  );
  const name = new Map(insts.map((i) => [i.id, i.name]));
  const out = new Map<string, Counted>();
  for (const row of rows) {
    const id = r(row.institution_id);
    out.set(id, { id, name: name.get(id) ?? "Unknown", items: (out.get(id)?.items ?? 0) + row.n });
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}
