// ---------------------------------------------------------------------------
// A Lean block in the editor (LEAN-1 to LEAN-5, LEAN-9): its name (the
// module others import), its source in a textarea over Lean highlighting,
// what Lean found, and on a computer the proof state at the cursor.
//
// On a computer the block is checked a moment after typing pauses, as it is
// (saved or not); the verdict is saved and syncs. A phone only shows the
// verdict a computer reached, while it holds for the source as it is.
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { dbId } from "../blocks/ids";
import { LEAN_TABLES, leanCheck, leanGoal, leanHash, leanIndex, runsLean, storedVerdict } from "../lib/lean";
import { leanHighlighter, type LeanHighlighter, type LeanToken } from "../lib/leanHighlight";
import { abbreviationAt, isModuleName, LEAN_MODULE_ROOT, verdictHolds } from "../lib/leanModel";
import { useTablesVersion } from "../lib/live";
import { go } from "../lib/navigation";
import type { LeanGoals, LeanMessage, LeanVerdict } from "../lib/schemas";
import { ago } from "../lib/sync";
import { useColorScheme } from "../lib/theme";
import { InfoButton } from "./InfoButton";

/** Typing pauses this long before a computer checks the block. */
const CHECK_AFTER_MS = 900;
/** The cursor rests this long before the proof state is asked for. */
const GOAL_AFTER_MS = 200;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Where each line starts in `text`. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

interface Mark {
  from: number;
  to: number;
  severity: "error" | "warning";
}

/** Lean's errors and warnings as ranges of the text (an empty range marks the character after it). */
function marksOf(text: string, messages: readonly LeanMessage[]): Mark[] {
  const starts = lineStarts(text);
  const at = (line: number, column: number) => Math.min(text.length, (starts[line] ?? text.length) + column);
  return messages.flatMap((m): Mark[] => {
    if (m.severity !== "error" && m.severity !== "warning") return [];
    const from = at(m.line, m.column);
    const to = Math.max(at(m.endLine, m.endColumn), Math.min(text.length, from + 1));
    return to > from ? [{ from, to, severity: m.severity }] : [];
  });
}

/** The highlighted text, with Lean's errors and warnings underlined. */
function Highlighted(props: { text: string; hl: LeanHighlighter | null; dark: boolean; marks: readonly Mark[] }) {
  const { text, hl, dark, marks } = props;
  const lines = useMemo((): LeanToken[][] => (hl ? hl.tokens(text, dark) : text.split("\n").map((l) => [{ content: l }])), [text, hl, dark]);
  const out: ReactNode[] = [];
  let offset = 0;
  lines.forEach((line, li) => {
    for (const token of line) {
      let start = 0;
      while (start < token.content.length) {
        const pos = offset + start;
        const inside = marks.find((m) => m.from <= pos && pos < m.to);
        // The piece runs to the next mark boundary, or the token's end.
        const next = Math.min(
          token.content.length,
          ...marks.flatMap((m) => [m.from, m.to]).filter((b) => b > pos).map((b) => b - offset),
        );
        const piece = token.content.slice(start, next);
        out.push(
          <span key={`${li}:${pos}`} style={token.color ? { color: token.color } : undefined} className={inside ? `lean-mark ${inside.severity}` : undefined}>
            {piece}
          </span>,
        );
        start = next;
      }
      offset += token.content.length;
    }
    if (li < lines.length - 1) {
      out.push("\n");
      offset += 1;
    }
  });
  // A last empty line still takes its height, as in the textarea.
  if (text === "" || text.endsWith("\n")) out.push("\u200b");
  return <pre className="lean-highlight" aria-hidden>{out}</pre>;
}

function Status(props: { checking: boolean; problem: string | null; verdict: LeanVerdict | null; holds: boolean }) {
  const { checking, problem, verdict, holds } = props;
  const info = (
    <InfoButton title="Lean blocks">
      <p>
        Your computers verify Lean blocks with Lean and Mathlib, once Lean is set up on them (Settings → Lean): as you edit a block there,
        and by themselves when a block changed on another device. A phone shows what a computer found.
      </p>
      <p>A verdict holds for the source it was reached for, and for the blocks it imports as they were. Change either, and it shows as not verified until it's checked again.</p>
      <p>
        Name a block to use it from others: a block named <code>Peano</code> is imported with <code>import {LEAN_MODULE_ROOT}.Peano</code>, from any page.
      </p>
    </InfoButton>
  );
  if (checking) return <span className="lean-status checking">Checking…{info}</span>;
  if (problem) {
    return (
      <span className="lean-status problem" title={problem}>
        <button type="button" className="lean-link" onClick={() => go("/settings/lean")}>
          {problem.includes("set up") || problem.includes("installed") ? "Lean isn't set up here" : "Lean couldn't check it"}
        </button>
        {info}
      </span>
    );
  }
  if (!verdict || !holds) return <span className="lean-status none">Not verified{info}</span>;
  const errors = verdict.messages.filter((m) => m.severity === "error").length;
  const label = verdict.status === "verified" ? "✓ Verified" : verdict.status === "sorry" ? "Verified with sorry" : `${errors} ${errors === 1 ? "error" : "errors"}`;
  return (
    <span className={`lean-status ${verdict.status}`}>
      {label}
      <span className="lean-status-by">
        {" "}
        · {verdict.device}, {ago(verdict.checkedAt)}
      </span>
      {info}
    </span>
  );
}

// Spec: LEAN-1, LEAN-2, LEAN-3, LEAN-4, LEAN-5, LEAN-9
export function LeanBlock(props: {
  editorId: string;
  name: string;
  source: string;
  editable: boolean;
  onChange: (changed: { name?: string; source?: string }) => void;
}) {
  const blockId = dbId(props.editorId);
  const computer = runsLean();
  const dark = useColorScheme() === "dark";
  const area = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(props.source);
  const [name, setName] = useState(props.name);
  const [focused, setFocused] = useState(false);
  const [naming, setNaming] = useState(false);

  // What arrives from elsewhere (sync) shows when it isn't being edited here.
  useEffect(() => {
    if (!focused) setText(props.source);
  }, [props.source, focused]);
  useEffect(() => {
    if (!naming) setName(props.name);
  }, [props.name, naming]);

  const [hl, setHl] = useState<LeanHighlighter | null>(null);
  useEffect(() => {
    let live = true;
    void leanHighlighter().then((h) => {
      if (live) setHl(h);
    });
    return () => {
      live = false;
    };
  }, []);

  // The stored verdict, and the book's named blocks (whom a name belongs to, and their hashes now).
  const version = useTablesVersion(LEAN_TABLES);
  const [stored, setStored] = useState<{ verdict: LeanVerdict | null; ids: Map<string, string>; hashes: Map<string, string> } | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.all([storedVerdict(blockId), leanIndex()]).then(([verdict, index]) => {
      if (live) setStored({ verdict, ...index });
    });
    return () => {
      live = false;
    };
  }, [blockId, version]);

  const [hash, setHash] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void leanHash(name, text).then((h) => {
      if (live) setHash(h);
    });
    return () => {
      live = false;
    };
  }, [name, text]);

  const verdict = stored?.verdict ?? null;
  const holds = verdict !== null && hash !== null && stored !== null && verdictHolds(verdict, hash, stored.hashes);

  // Spec: LEAN-3
  // On a computer: checked once typing pauses, whenever the verdict doesn't hold.
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const loaded = stored !== null && hash !== null;
  useEffect(() => {
    if (!computer || !props.editable || !loaded || holds) return;
    const t = setTimeout(() => {
      setChecking(true);
      leanCheck(blockId, name, text)
        .then(() => setProblem(null))
        .catch((e: unknown) => setProblem(errorText(e)))
        .finally(() => setChecking(false));
    }, CHECK_AFTER_MS);
    return () => clearTimeout(t);
  }, [computer, props.editable, loaded, holds, blockId, name, text]);

  // Spec: LEAN-4
  const [goals, setGoals] = useState<LeanGoals>(null);
  const goalTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const askGoal = () => {
    const el = area.current;
    if (!computer || !props.editable || !el) return;
    if (goalTimer.current) clearTimeout(goalTimer.current);
    goalTimer.current = setTimeout(() => {
      const at = el.selectionStart;
      const before = el.value.slice(0, at);
      const line = before.split("\n").length - 1;
      const character = at - (before.lastIndexOf("\n") + 1);
      leanGoal(blockId, name, el.value, line, character)
        .then(setGoals)
        .catch(() => setGoals(null));
    }, GOAL_AFTER_MS);
  };
  useEffect(
    () => () => {
      if (goalTimer.current) clearTimeout(goalTimer.current);
    },
    [],
  );

  const commit = (source: string) => {
    setText(source);
    props.onChange({ source });
  };

  // Spec: LEAN-9
  const onInput = (el: HTMLTextAreaElement) => {
    const caret = el.selectionStart;
    const hit = caret === el.selectionEnd ? abbreviationAt(el.value, caret) : null;
    if (hit) {
      el.setSelectionRange(hit.from, hit.to);
      // As if typed, so undo takes it back.
      if (!document.execCommand("insertText", false, hit.symbol)) el.setRangeText(hit.symbol, hit.from, hit.to, "end");
      const after = hit.from + hit.symbol.length + 1;
      el.setSelectionRange(after, after);
    }
    commit(el.value);
    askGoal();
  };

  const messages = useMemo(() => (holds && verdict ? verdict.messages : []), [holds, verdict]);
  const marks = useMemo(() => marksOf(text, messages), [text, messages]);
  const validName = name === "" || isModuleName(name);
  const owner = stored?.ids.get(name);
  const taken = name !== "" && owner !== undefined && owner !== blockId;

  return (
    <div className="lean-block" contentEditable={false}>
      <div className="lean-head">
        <span className="lean-badge">Lean</span>
        <label className={validName && !taken ? "lean-name" : "lean-name invalid"} title={taken ? `Another Lean block is ${LEAN_MODULE_ROOT}.${name}` : validName ? "" : "Letters, digits and _, in parts joined by dots"}>
          <span className="lean-root">{LEAN_MODULE_ROOT}.</span>
          <input
            value={name}
            placeholder="Name"
            aria-label="Module name"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            readOnly={!props.editable}
            onFocus={() => setNaming(true)}
            onBlur={() => setNaming(false)}
            onChange={(e) => {
              setName(e.target.value);
              props.onChange({ name: e.target.value });
            }}
          />
        </label>
        <Status checking={checking} problem={problem} verdict={verdict} holds={holds} />
      </div>
      <div className="lean-code">
        <Highlighted text={text} hl={hl} dark={dark} marks={marks} />
        <textarea
          ref={area}
          className="lean-input"
          value={text}
          readOnly={!props.editable}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          aria-label="Lean source"
          placeholder="theorem …"
          onChange={(e) => onInput(e.currentTarget)}
          onSelect={askGoal}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            setGoals(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Tab" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
              e.preventDefault();
              if (!document.execCommand("insertText", false, "  ")) e.currentTarget.setRangeText("  ", e.currentTarget.selectionStart, e.currentTarget.selectionEnd, "end");
              commit(e.currentTarget.value);
            }
          }}
        />
      </div>
      {messages.length > 0 ? (
        <ol className="lean-messages" aria-label="What Lean said">
          {messages.map((m, i) => (
            <li key={i} className={`lean-message ${m.severity}`}>
              <span className="lean-message-line">{m.line + 1}</span>
              <pre>{m.text}</pre>
            </li>
          ))}
        </ol>
      ) : null}
      {focused && goals ? (
        <div className="lean-goals" aria-label="Proof state">
          {goals.goals.length > 0 ? goals.goals.map((g, i) => <pre key={i}>{g}</pre>) : null}
          {goals.term ? <pre className="lean-term">{goals.term}</pre> : null}
        </div>
      ) : null}
    </div>
  );
}
