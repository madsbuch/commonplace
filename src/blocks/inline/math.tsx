import { useState } from "react";
import katex from "katex";
import { createReactInlineContentSpec } from "@blocknote/react";
import { Extension as TiptapExtension, InputRule } from "@tiptap/core";

/** KaTeX's HTML for `latex`, or the error as text when it doesn't parse. */
function typeset(latex: string): string {
  return katex.renderToString(latex || "\\square", { throwOnError: false, displayMode: false, output: "htmlAndMathml" });
}

function MathView(props: { latex: string; onChange: (latex: string) => void; editable: boolean }) {
  const [editing, setEditing] = useState(props.latex === "");
  const [draft, setDraft] = useState(props.latex);
  if (editing && props.editable) {
    return (
      <input
        className="math-input"
        autoFocus
        value={draft}
        size={Math.max(draft.length, 4)}
        placeholder="LaTeX"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false);
          if (draft !== props.latex) props.onChange(draft);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "Escape") {
            e.preventDefault();
            e.currentTarget.blur();
          }
          e.stopPropagation();
        }}
      />
    );
  }
  return (
    <span
      className="math-inline"
      title={props.latex}
      onClick={() => {
        setDraft(props.latex);
        setEditing(true);
      }}
      dangerouslySetInnerHTML={{ __html: typeset(props.latex) }}
    />
  );
}

/**
 * Typing `$…$` turns it into maths. The opening `$` must follow a space or the
 * start of the text and both ends must touch the formula, so prices ("$5 or
 * $10") stay text.
 */
const MATH_INPUT = /(?:^|\s)\$([^\s$](?:[^$\n]*[^\s$])?)\$$/;

const mathInputRule = TiptapExtension.create({
  name: "mathInputRule",
  addInputRules() {
    return [
      new InputRule({
        find: MATH_INPUT,
        handler: ({ state, range, match }) => {
          const type = state.schema.nodes["math"];
          const latex = match[1];
          if (!type || latex === undefined) return null;
          // The closing `$` is still being typed: the text before it is `$` + latex.
          const start = range.to - latex.length - 1;
          state.tr.replaceWith(start, range.to, type.create({ latex }));
          return undefined;
        },
      }),
    ];
  },
});

// Spec: BOOK-8
/** Inline LaTeX, typeset with KaTeX. Click it to edit the source. */
export const mathInlineSpec = createReactInlineContentSpec(
  {
    type: "math",
    propSchema: { latex: { default: "" } },
    content: "none",
  },
  {
    render: ({ inlineContent, updateInlineContent, editor }) => (
      <MathView
        latex={inlineContent.props.latex}
        editable={editor.isEditable}
        onChange={(latex) => updateInlineContent({ type: "math", props: { latex } })}
      />
    ),
  },
  [{ key: "mathInputRule", tiptapExtensions: [mathInputRule] }],
);
