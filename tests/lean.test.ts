import { describe, expect, test } from "bun:test";
import { abbreviationAt, hashInput, importsOf, isModuleName, moduleOf, verdictHolds } from "../src/lib/leanModel";

// Spec: LEAN-2
describe("Lean module names", () => {
  test("identifiers joined by dots", () => {
    expect(isModuleName("Peano")).toBe(true);
    expect(isModuleName("Logic.Classical")).toBe(true);
    expect(isModuleName("Nat.add_comm'")).toBe(true);
    expect(isModuleName("Kategorien.Funktor")).toBe(true);
    expect(isModuleName("")).toBe(false);
    expect(isModuleName("1st")).toBe(false);
    expect(isModuleName("a..b")).toBe(false);
    expect(isModuleName("a b")).toBe(false);
    expect(isModuleName("Peano.")).toBe(false);
  });
  test("under the book's root", () => {
    expect(moduleOf("Peano")).toBe("Book.Peano");
  });
});

// Spec: LEAN-2
describe("imports between blocks", () => {
  test("the Book modules in the header, and nothing after it", () => {
    const src = `-- the naturals
import Mathlib.Data.Nat.Basic
import Book.Peano
/- a comment
import Book.Hidden -/
import Book.Logic.Classical

theorem x : True := trivial
import Book.NotHeader`;
    expect(importsOf(src)).toEqual(["Peano", "Logic.Classical"]);
  });
  test("prelude and none", () => {
    expect(importsOf("prelude\nimport Book.A")).toEqual(["A"]);
    expect(importsOf("def x := 1")).toEqual([]);
  });
});

// Spec: LEAN-5
describe("verdicts", () => {
  test("hold for the same source and the same imports", () => {
    const v = { sourceHash: "h1", deps: [{ name: "Peano", hash: "p1" }] };
    expect(verdictHolds(v, "h1", new Map([["Peano", "p1"]]))).toBe(true);
    expect(verdictHolds(v, "h2", new Map([["Peano", "p1"]]))).toBe(false);
    expect(verdictHolds(v, "h1", new Map([["Peano", "p2"]]))).toBe(false);
    expect(verdictHolds(v, "h1", new Map())).toBe(false);
  });
  test("are taken over the name and the source", () => {
    expect(hashInput("Peano", "def x := 1")).toBe("Peano\ndef x := 1");
  });
  test("hash as the Rust side does", async () => {
    // src-tauri/src/lean/model.rs pins the same input to the same hash.
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(hashInput("Peano", "def x := 1")));
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(hex).toBe("d40223bcd6415ac459f351d98e8eb80dc898e05cc28543bb790c023e17870c8c");
  });
});

// Spec: LEAN-9
describe("abbreviations", () => {
  const type = (text: string) => {
    // Types `text` one character at a time, replacing as an editor would.
    let out = "";
    for (const ch of text) {
      out += ch;
      const r = abbreviationAt(out, out.length);
      if (r) out = out.slice(0, r.from) + r.symbol + out.slice(r.to);
    }
    return out;
  };
  test("turn into their symbols when the next character is typed", () => {
    expect(type("\\forall x, x \\to x ")).toBe("∀ x, x → x ");
    expect(type("\\alpha ")).toBe("α ");
    expect(type("\\<a, b\\> ")).toBe("⟨a, b⟩ ");
    expect(type("\\N ")).toBe("ℕ ");
    expect(type("x\\_1 ")).toBe("x₁ ");
  });
  test("wait while a longer one is being typed", () => {
    expect(type("\\top ")).toBe("⊤ ");
    expect(type("\\to")).toBe("\\to");
    expect(type("\\inter ")).toBe("∩ ");
    expect(type("\\in ")).toBe("∈ ");
  });
  test("leave what isn't one alone", () => {
    expect(type("\\nope ")).toBe("\\nope ");
    expect(type("\\constructor ")).toBe("\\constructor ");
    expect(type("a \\ b")).toBe("a \\ b");
  });
});

// Spec: LEAN-1
describe("Lean blocks in Markdown", () => {
  test("a fence named lean, with the module it is", async () => {
    const { toMarkdown } = await import("../src/lib/bookModel");
    const md = toMarkdown([{ id: "blk_1", type: "lean", props: { name: "Peano" }, content: "theorem t : True := trivial", children: [] }], () => "");
    expect(md).toBe("```lean\n-- Book.Peano\ntheorem t : True := trivial\n```");
  });
});
