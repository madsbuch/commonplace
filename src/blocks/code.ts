import { createCodeBlockSpec } from "@blocknote/core";
import { codeBlockOptions } from "@blocknote/code-block";
import type { BlockType } from "./types";

// Spec: CODE-1, BOOK-9
/**
 * The languages code blocks offer. `book.code-languages` (Lean) must be
 * highlighted; the editor's usual ones come along.
 */
export const CODE_LANGUAGES = {
  lean: { name: "Lean", aliases: ["lean", "lean4"] },
  ...codeBlockOptions.supportedLanguages,
};

export const codeBlockSpec = createCodeBlockSpec({
  ...codeBlockOptions,
  defaultLanguage: "lean",
  supportedLanguages: CODE_LANGUAGES,
});

/** Source code in a named language (` ``` `). */
export const code: BlockType = {
  stored: "code",
  editorTypes: ["codeBlock"],
  toEditor: (b) => ({ type: "codeBlock", props: b.props, content: b.content }),
  fromEditor: (b) => ({ type: "code", props: b.props, content: b.content }),
};
