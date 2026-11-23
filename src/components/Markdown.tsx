import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { openUrl } from "@tauri-apps/plugin-opener";
import { splitTypeIds } from "../lib/entities";
import { go } from "../lib/navigation";
import { EntityChip } from "./EntityChip";

const ENTITY = "entity:";

/** Ids of ours in the text as links to `entity:<id>`, which render as chips (not inside code, nor in a link's address). */
function linkIds(text: string): string {
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`|\]\([^)\s]*\))/)
    .map((part, i) => (i % 2 === 1 ? part : splitTypeIds(part).map((p) => (typeof p === "string" ? p : `[${p.id}](${ENTITY}${p.id})`)).join("")))
    .join("");
}

/**
 * An assistant message: Markdown with maths, ids of pages, blocks, library
 * items, people and institutions as chips (CHAT-7). Links to the web open in
 * the system browser, never in the app's window; the app's own addresses open
 * in the app (CHAT-8).
 */
export function Markdown(props: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      urlTransform={(url) => (url.startsWith(ENTITY) ? url : defaultUrlTransform(url))}
      components={{
        a: ({ href, children }) => {
          if (href?.startsWith(ENTITY)) return <EntityChip id={href.slice(ENTITY.length)} />;
          return (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault();
                if (href && /^https?:\/\//.test(href)) void openUrl(href);
                // Spec: CHAT-8
                // An address of the app's own (`/library/lib_…#page=12`) opens here.
                else if (href?.startsWith("/") && !href.startsWith("//")) go(href);
              }}
            >
              {children}
            </a>
          );
        },
      }}
    >
      {linkIds(props.text)}
    </ReactMarkdown>
  );
}
