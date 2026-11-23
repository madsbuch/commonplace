// Enforcement home for the project's JSON-boundary rule (see CLAUDE.md):
// all external JSON must be parsed through a zod schema in src/lib/schemas.ts,
// so raw `JSON.parse` is banned everywhere else. Runs as part of `bun run build`
// (and therefore in CI) and standalone via `bun run lint`.
//
// The config is deliberately minimal — a parser, the boundary rules, and a ban
// on native dialogs (they don't show in the desktop app) — so a lint failure
// always means one of those was broken, not style noise. Grow it
// intentionally if more rules are wanted.
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import eslintComments from "@eslint-community/eslint-plugin-eslint-comments";

export default tseslint.config(
  { ignores: ["dist/**", "src-tauri/**", "node_modules/**", ".claude/**"] },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [tseslint.configs.base],
    plugins: { "react-hooks": reactHooks, "eslint-comments": eslintComments },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      // None of the rules below may be switched off with a comment — only
      // the hooks dependency check, whose exceptions are judgment calls.
      // Spec: engineering-rules.TYP-4
      "eslint-comments/no-restricted-disable": [
        "error",
        // gitignore-style patterns: "*" swallows the "react-hooks/" folder,
        // so it's reopened before the one rule is let through.
        "*",
        "!react-hooks",
        "react-hooks/*",
        "!react-hooks/exhaustive-deps",
      ],
      "eslint-comments/no-unlimited-disable": "error",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // Spec: engineering-rules.JSN-1
      "no-restricted-properties": [
        "error",
        {
          object: "JSON",
          property: "parse",
          message:
            "Raw JSON.parse is banned outside src/lib/schemas.ts — route external JSON " +
            "through parseJson + a zod schema there (see CLAUDE.md).",
        },
        // The desktop app's WebView shows none of these, and confirm()
        // answers "no": deletes silently did nothing on the computer.
        ...["confirm", "alert", "prompt"].map((property) => ({
          object: "window",
          property,
          message: "Native dialogs don't show in the desktop app — use an in-app dialog instead.",
        })),
      ],
      // The other half of the boundary rule: a type argument or an `as` on
      // what a command, a query or a fetch hands back claims a shape nobody
      // checked. Parse it through src/lib/schemas.ts instead.
      // Spec: engineering-rules.JSN-2
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name='invoke'][typeArguments]",
          message:
            "invoke<T>() is an unchecked claim about what the command returns — " +
            "parse its result with a schema from src/lib/schemas.ts (see CLAUDE.md).",
        },
        {
          selector: "TSAsExpression[expression.type='AwaitExpression']",
          message:
            "Casting an awaited result skips validation — parse it with a schema " +
            "from src/lib/schemas.ts (see CLAUDE.md).",
        },
      ],
      // Spec: engineering-rules.TYP-1, engineering-rules.TYP-2, engineering-rules.TYP-3
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-expect-error": true, "ts-ignore": true, "ts-nocheck": true, "ts-check": false },
      ],
      "no-restricted-globals": [
        "error",
        ...["confirm", "alert", "prompt"].map((name) => ({
          name,
          message: "Native dialogs don't show in the desktop app — use an in-app dialog instead.",
        })),
      ],
    },
  },
  {
    // The one sanctioned JSON.parse (parseJson) lives here; the dialog bans still apply.
    files: ["src/lib/schemas.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        ...["confirm", "alert", "prompt"].map((property) => ({
          object: "window",
          property,
          message: "Native dialogs don't show in the desktop app — use an in-app dialog instead.",
        })),
      ],
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    // Spec: engineering-rules.TYP-2
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
    },
  },
  {
    // Spec: AST-2, ATL-5
    // The assistant never adds or changes anything in the book or the
    // library. Its modules can't reach their data layers at all: they read
    // through lib/lookup.ts, which has no writes, and write only their chats
    // (lib/chats.ts), their memory (lib/memory.ts) and, through
    // lib/openrouter.ts, the usage ledger.
    files: [
      "src/lib/assistant*.ts",
      "src/lib/entities.ts",
      "src/components/ChatView.tsx",
      "src/components/AssistantDock.tsx",
      "src/components/Markdown.tsx",
      "src/components/EntityChip.tsx",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "@tauri-apps/plugin-sql", message: "The assistant can't touch the database (AST-2)." },
            { name: "@tauri-apps/api/core", message: "The assistant can't call into the app's commands (AST-2)." },
            { name: "drizzle-orm", message: "The assistant can't touch the database (AST-2)." },
          ],
          patterns: [
            {
              regex: "(^|/)(db|book[^/]*|blocks[^/]*|revisions[^/]*|library[^/]*|people[^/]*)(\\.ts)?$|(^|/)db/",
              message: "The assistant never changes the book or the library: read them through lib/lookup.ts (AST-2, ATL-5).",
            },
          ],
        },
      ],
    },
  },
);
