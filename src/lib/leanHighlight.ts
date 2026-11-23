// Lean highlighted for the Lean block's editor: Shiki with its Lean grammar
// and the JavaScript regex engine (as code blocks use), loaded once. Once
// loaded it tokenises synchronously, so highlighting keeps up with typing.

import { createHighlighter } from "shiki";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

export interface LeanToken {
  content: string;
  color?: string | undefined;
}

export interface LeanHighlighter {
  tokens(code: string, dark: boolean): LeanToken[][];
}

let loading: Promise<LeanHighlighter> | null = null;

// Spec: LEAN-1
export function leanHighlighter(): Promise<LeanHighlighter> {
  loading ??= createHighlighter({
    themes: ["github-light", "github-dark"],
    langs: ["lean"],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  }).then((h) => ({
    tokens: (code, dark) => h.codeToTokensBase(code, { lang: "lean", theme: dark ? "github-dark" : "github-light" }),
  }));
  return loading;
}
