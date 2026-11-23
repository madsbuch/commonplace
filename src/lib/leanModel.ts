// ---------------------------------------------------------------------------
// Lean blocks without I/O: module names, imports between blocks, what a
// verdict is tied to and when it no longer holds, and the backslash
// abbreviations. The Rust side (src-tauri/src/lean/) computes the same
// hashes and imports; tests pin both to the same examples.
// ---------------------------------------------------------------------------

// Spec: LEAN-2
/** `lean.module-root` in the spec: a block named `Peano` is the module `Book.Peano`. */
export const LEAN_MODULE_ROOT = "Book";

const COMPONENT = /^[\p{L}_][\p{L}\p{N}_'!?]*$/u;

/** Whether `name` can name a block's module: identifiers joined by dots, `Peano` or `Logic.Classical`. */
export function isModuleName(name: string): boolean {
  return name.length > 0 && name.length <= 200 && name.split(".").every((c) => COMPONENT.test(c));
}

export function moduleOf(name: string): string {
  return `${LEAN_MODULE_ROOT}.${name}`;
}

/**
 * The blocks a source imports: the names after `import Book.` in its header
 * (the imports before anything else, comments aside).
 */
export function importsOf(source: string): string[] {
  const names: string[] = [];
  // Comments out of the way, then the header: `import` lines until the first other command.
  const text = source.replace(/\/-[\s\S]*?-\//g, " ").replace(/--[^\n]*/g, " ");
  const tokens = text.split(/\s+/).filter((t) => t.length > 0);
  let i = tokens[0] === "prelude" ? 1 : 0;
  while (tokens[i] === "import") {
    i++;
    if (tokens[i] === "runtime") i++;
    const m = tokens[i];
    if (m === undefined) break;
    const prefix = `${LEAN_MODULE_ROOT}.`;
    if (m.startsWith(prefix) && isModuleName(m.slice(prefix.length))) names.push(m.slice(prefix.length));
    i++;
  }
  return [...new Set(names)];
}

// Spec: LEAN-5
/** What a block's hash is taken over: its name, a newline, its source. */
export function hashInput(name: string, source: string): string {
  return `${name}\n${source}`;
}

export interface LeanDep {
  name: string;
  hash: string;
}

/**
 * Whether a verdict still holds: for the block as it is (`hash`), and for
 * every block it imported as they are now (`current`, name to hash; a block
 * gone or renamed away no longer matches).
 */
export function verdictHolds(verdict: { sourceHash: string; deps: readonly LeanDep[] }, hash: string, current: ReadonlyMap<string, string>): boolean {
  return verdict.sourceHash === hash && verdict.deps.every((d) => current.get(d.name) === d.hash);
}

// ---------------------------------------------------------------------------
// Abbreviations (LEAN-9): the common ones of Lean's own editors.
// ---------------------------------------------------------------------------

const GREEK: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", iota: "ι", kappa: "κ",
  lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", upsilon: "υ", phi: "φ", chi: "χ",
  psi: "ψ", omega: "ω", Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Phi: "Φ",
  Psi: "Ψ", Omega: "Ω", a: "α", b: "β", g: "γ", e: "ε", fun: "λ", lam: "λ",
};

const DIGITS = "0123456789".split("");
const SCRIPT_ENTRIES: [string, string][] = [
  ...DIGITS.map((d, i): [string, string] => [`_${d}`, "₀₁₂₃₄₅₆₇₈₉"[i] ?? d]),
  ...DIGITS.map((d, i): [string, string] => [`^${d}`, "⁰¹²³⁴⁵⁶⁷⁸⁹"[i] ?? d]),
  ["_i", "ᵢ"], ["_j", "ⱼ"], ["_n", "ₙ"], ["_k", "ₖ"], ["_m", "ₘ"], ["^n", "ⁿ"], ["^i", "ⁱ"],
  ["^+", "⁺"], ["^-", "⁻"], ["_+", "₊"], ["_-", "₋"],
];
const SCRIPTS: Record<string, string> = Object.fromEntries(SCRIPT_ENTRIES);

export const LEAN_ABBREVIATIONS: Readonly<Record<string, string>> = {
  ...GREEK,
  ...SCRIPTS,
  // Arrows
  to: "→", r: "→", "->": "→", rightarrow: "→", l: "←", "<-": "←", leftarrow: "←", "<->": "↔", iff: "↔", lr: "↔",
  "=>": "⇒", Rightarrow: "⇒", Leftarrow: "⇐", "<=>": "⇔", mapsto: "↦", u: "↑", d: "↓", hom: "⟶", longrightarrow: "⟶",
  // Logic
  forall: "∀", all: "∀", fa: "∀", exists: "∃", ex: "∃", and: "∧", or: "∨", not: "¬", neg: "¬", top: "⊤", bot: "⊥",
  "|-": "⊢", vdash: "⊢", models: "⊨", qed: "∎",
  // Relations
  ne: "≠", neq: "≠", le: "≤", ge: "≥", "<=": "≤", ">=": "≥", equiv: "≡", "==": "≡", approx: "≈", sim: "∼", "~": "∼",
  simeq: "≃", cong: "≅", iso: "≅", dvd: "∣", mid: "∣",
  // Sets and lattices
  in: "∈", notin: "∉", nin: "∉", sub: "⊂", subset: "⊂", sube: "⊆", ss: "⊆", subseteq: "⊆", supset: "⊃",
  supseteq: "⊇", cup: "∪", union: "∪", cap: "∩", inter: "∩", empty: "∅", emptyset: "∅", compl: "ᶜ", setminus: "\\",
  bigcup: "⋃", Union: "⋃", bigcap: "⋂", Inter: "⋂", powerset: "𝒫", inf: "⊓", glb: "⊓", sup: "⊔", lub: "⊔",
  // Numbers
  N: "ℕ", nat: "ℕ", Z: "ℤ", int: "ℤ", Q: "ℚ", rat: "ℚ", R: "ℝ", real: "ℝ", C: "ℂ", infty: "∞",
  // Brackets
  "<": "⟨", ">": "⟩", langle: "⟨", rangle: "⟩", "<<": "⟪", ">>": "⟫", "[[": "⟦", "]]": "⟧", "f<": "‹", "f>": "›",
  lceil: "⌈", rceil: "⌉", lfloor: "⌊", rfloor: "⌋", "||": "‖", norm: "‖",
  // Operators
  times: "×", x: "×", prod: "∏", sum: "∑", circ: "∘", comp: "∘", o: "∘", cdot: "·", ".": "·", bu: "•", smul: "•",
  oplus: "⊕", "o+": "⊕", otimes: "⊗", ox: "⊗", "-1": "⁻¹", inv: "⁻¹", sqrt: "√", partial: "∂", nabla: "∇",
  t: "▸", tr: "▸", star: "⋆", pm: "±", mp: "∓", div: "÷", ldots: "…", dots: "…",
};

const SYMBOLS = new Map(Object.entries(LEAN_ABBREVIATIONS));
const NAMES = [...SYMBOLS.keys()];

/** Whether some abbreviation starts with `prefix`. */
function continues(prefix: string): boolean {
  return NAMES.some((n) => n.startsWith(prefix));
}

// Spec: LEAN-9
/**
 * After a character is typed at `caret` (the text includes it): if it ends a
 * backslash abbreviation, the replacement to make, `{ from, to, symbol }`
 * over the text (the typed character itself stays).
 */
export function abbreviationAt(text: string, caret: number): { from: number; to: number; symbol: string } | null {
  if (caret < 2) return null;
  const typed = text[caret - 1];
  if (typed === undefined) return null;
  // The abbreviation being typed: from the last backslash, on this line, with no space.
  const before = text.slice(0, caret - 1);
  const slash = before.lastIndexOf("\\");
  if (slash < 0) return null;
  const name = before.slice(slash + 1);
  if (name.length === 0 || /\s/.test(name)) return null;
  // Still typing a longer one: wait.
  if (!/\s/.test(typed) && continues(name + typed)) return null;
  const symbol = SYMBOLS.get(name);
  return symbol === undefined ? null : { from: slash, to: caret - 1, symbol };
}
