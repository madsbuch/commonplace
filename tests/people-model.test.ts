import { describe, expect, test } from "bun:test";
import { groupOf, matchInstitution, matchPerson, normalizeName, resolver, samePersonName, splitAuthors, type Named } from "../src/lib/peopleModel";

const p = (id: string, name: string, mergedInto: string | null = null): Named => ({ id, name, mergedInto });

describe("names", () => {
  test("normalising drops case, accents and punctuation", () => {
    expect(normalizeName("Per Martin-Löf")).toBe("per martin lof");
    expect(normalizeName("  ÉCOLE Normale  Supérieure ")).toBe("ecole normale superieure");
  });

  // Spec: PPL-2
  test("initials match whole given names; different first names don't", () => {
    expect(samePersonName("Alan Turing", "A. M. Turing")).toBe(true);
    expect(samePersonName("Turing, Alan", "Alan Turing")).toBe(true);
    expect(samePersonName("Alan Turing", "Alan Mathison Turing")).toBe(true);
    expect(samePersonName("Alan Turing", "Dermot Turing")).toBe(false);
    expect(samePersonName("A. M. Turing", "A. J. Turing")).toBe(false);
    expect(samePersonName("Turing", "Alan Turing")).toBe(false);
  });
});

describe("linking to what's there", () => {
  // Spec: PPL-2
  test("a person links only when exactly one matches", () => {
    const people = [p("1", "Alan Turing"), p("2", "Per Martin-Löf"), p("3", "John Smith"), p("4", "Jane Smith")];
    expect(matchPerson("A. M. Turing", people)).toBe("1");
    expect(matchPerson("per martin-lof", people)).toBe("2");
    expect(matchPerson("J. Smith", people)).toBeNull();
    expect(matchPerson("John Smith", people)).toBe("3");
    expect(matchPerson("Haskell Curry", people)).toBeNull();
  });

  test("merged people aren't linked to directly", () => {
    expect(matchPerson("Alan Turing", [p("1", "Alan Turing", "2"), p("2", "A. Turing")])).toBe("2");
  });

  // Spec: PPL-2
  test("an institution links on the same words", () => {
    const insts = [p("1", "University of Cambridge"), p("2", "Princeton University")];
    expect(matchInstitution("university of CAMBRIDGE.", insts)).toBe("1");
    expect(matchInstitution("Cambridge", insts)).toBeNull();
  });
});

describe("merging", () => {
  // Spec: PPL-5
  test("chains resolve to the last; cycles to their smallest id, the same everywhere", () => {
    const rows = [p("a", "A", "b"), p("b", "B", "c"), p("c", "C"), p("x", "X", "y"), p("y", "Y", "x")];
    const resolve = resolver(rows);
    expect(resolve("a")).toBe("c");
    expect(resolve("x")).toBe("x");
    expect(resolve("y")).toBe("x");
    expect(groupOf(rows, "b").sort()).toEqual(["a", "b", "c"]);
  });
});

describe("author lines", () => {
  // Spec: LIB-9
  test("split on commas, semicolons and 'and', but keep 'Surname, Given' whole", () => {
    expect(splitAuthors("Alan Turing, Alonzo Church and Haskell Curry")).toEqual(["Alan Turing", "Alonzo Church", "Haskell Curry"]);
    expect(splitAuthors("Turing, Alan")).toEqual(["Alan Turing"]);
    expect(splitAuthors("A. Turing; A. Church")).toEqual(["A. Turing", "A. Church"]);
    expect(splitAuthors("")).toEqual([]);
  });
});
