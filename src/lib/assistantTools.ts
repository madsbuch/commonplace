// ---------------------------------------------------------------------------
// The assistant's tools: looking at the screen, reading the book and the
// library, and keeping its memory. Every reading tool goes through
// lib/lookup.ts, which has no writes (ATL-5); the only writes here are to
// the memory (MEM-4).
// ---------------------------------------------------------------------------

import { currentSelection, currentView, ROUTES } from "./currentView";
import { captureScreen } from "./screenshot";
import {
  getItem,
  htmlSections,
  htmlSectionText,
  institutionView,
  itemAuthors,
  itemPdfText,
  blockInfo,
  pageList,
  pageMarkdown,
  pdfText,
  personView,
  searchLibrary,
  searchLinkTargets,
} from "./lookup";
import { addMemory, deleteMemory, isMemoryKind, updateMemory } from "./memory";
import type { ToolDef } from "./openrouter";
import type { TocEntry } from "./schemas";

// Spec: ATL-3
/** `assistant.pdf-pages-per-read` in the spec. */
export const PDF_PAGES_PER_READ = 10;
/** Longer results are cut, with a note saying so. */
const MAX_RESULT_CHARS = 24_000;

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const str = (description: string) => ({ type: "string", description });
const int = (description: string) => ({ type: "integer", description });

export const TOOLS: ToolDef[] = [
  {
    name: "look_at_screen",
    description:
      "What the author is looking at right now: a picture of the screen (when you can see images), its address and what the app's addresses mean, what the author has selected, and the page (with its content and the block the cursor is in), library item (with the text of the PDF page in view), person or institution on it. Use it whenever the author says 'this', 'here', 'this page', 'this paper' or 'what I selected'.",
    parameters: obj({}),
  },
  { name: "list_pages", description: "Every page of the book: id, title and depth in the page tree.", parameters: obj({}) },
  {
    name: "read_page",
    description: "A page of the book as Markdown, title first.",
    parameters: obj({ page_id: str("The page's id (blk_…).") }, ["page_id"]),
  },
  {
    name: "search_book",
    description: "Pages whose title, and blocks whose text, contain the words. Returns page ids, and block ids with their text.",
    parameters: obj({ query: str("Words to look for.") }, ["query"]),
  },
  {
    name: "search_library",
    description: "Papers and books whose title or authors contain the words (all, newest first, for an empty query).",
    parameters: obj({ query: str("Words to look for; may be empty.") }, ["query"]),
  },
  {
    name: "read_library_item",
    description:
      "A paper's or book's details: title, authors with their institutions (and ids), year, kind, page count, and its table of contents with the page each entry starts on (use it to pick pages for read_pdf_pages).",
    parameters: obj({ item_id: str("The item's id (lib_…).") }, ["item_id"]),
  },
  {
    name: "read_pdf_pages",
    description: `The text of pages of a paper's or book's PDF, at most ${PDF_PAGES_PER_READ} pages per call.`,
    parameters: obj(
      { item_id: str("The item's id (lib_…)."), from_page: int("First page, from 1."), to_page: int("Last page, inclusive.") },
      ["item_id", "from_page", "to_page"],
    ),
  },
  {
    name: "read_section",
    description:
      "One section of a paper's HTML version (when read_library_item lists text_sections), as text with maths in LaTeX. Better than read_pdf_pages for papers that have one.",
    parameters: obj({ item_id: str("The item's id (lib_…)."), section_id: str("A section's id, from text_sections.") }, ["item_id", "section_id"]),
  },
  {
    name: "read_person",
    description: "A person in the library: every item they wrote, the institutions they were listed with, and who they wrote with.",
    parameters: obj({ person_id: str("The person's id (person_…).") }, ["person_id"]),
  },
  {
    name: "read_institution",
    description: "An institution in the library: the items with an author listed there, and those authors.",
    parameters: obj({ institution_id: str("The institution's id (institution_…).") }, ["institution_id"]),
  },
  {
    name: "remember",
    description:
      "Keep something in your memory for every future chat: how the author wants to be helped (preference), what they're working on (focus), or another note. Only what the author asked you to remember or told you about how they want to be helped.",
    parameters: obj({ kind: { type: "string", enum: ["preference", "focus", "note"] }, text: str("What to remember, in one or two sentences.") }, [
      "kind",
      "text",
    ]),
  },
  {
    name: "update_memory",
    description: "Change one memory entry.",
    parameters: obj({ memory_id: str("The entry's id (memory_…)."), text: str("Its new text.") }, ["memory_id", "text"]),
  },
  {
    name: "forget",
    description: "Remove one memory entry.",
    parameters: obj({ memory_id: str("The entry's id (memory_…).") }, ["memory_id"]),
  },
];

/** Short names for the tools, for "Checked pages · library" under an answer. */
const TOOL_LABELS: Record<string, string> = {
  look_at_screen: "the screen",
  list_pages: "pages",
  read_page: "pages",
  search_book: "the book",
  search_library: "the library",
  read_library_item: "the library",
  read_pdf_pages: "a PDF",
  read_section: "a paper",
  read_person: "people",
  read_institution: "institutions",
  remember: "memory",
  update_memory: "memory",
  forget: "memory",
};

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

function text(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

function out(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value, null, 1);
  return s.length > MAX_RESULT_CHARS ? `${s.slice(0, MAX_RESULT_CHARS)}\n…(cut: the result was longer than ${MAX_RESULT_CHARS} characters)` : s;
}

// Spec: ATL-9
/** A table of contents as lines, "  2.1 Title (p. 14)", indented by depth: compact for the model. */
function contentsLines(toc: readonly TocEntry[], depth = 0): string[] {
  return toc.flatMap((e) => [`${"  ".repeat(depth)}${e.title}${e.page !== null ? ` (p. ${e.page})` : ""}`, ...contentsLines(e.children, depth + 1)]);
}

async function itemDetails(id: string) {
  const item = await getItem(id);
  if (!item) return null;
  const authors = await itemAuthors(id);
  return {
    id: item.id,
    title: item.title,
    year: item.year,
    kind: item.kind,
    pages: item.pages,
    authors: authors.map((a) => ({ person_id: a.personId, name: a.name, institutions: a.institutions.map((i) => ({ institution_id: i.id, name: i.name })) })),
    contents: item.toc === null ? "not read yet" : item.toc.length === 0 ? "the PDF has none" : contentsLines(item.toc).join("\n"),
    ...(item.arxivId ? { arxiv_id: item.arxivId } : {}),
    // Spec: ATL-10
    text_sections: (await htmlSections(id)) ?? "none: it has no HTML version",
  };
}

// Spec: ATL-1, ATL-6
async function lookAtScreen(): Promise<Record<string, unknown>> {
  const v = currentView();
  const sel = currentSelection();
  const screen: Record<string, unknown> = {
    screen: v.kind,
    address: v.address,
    addresses: ROUTES,
    selection: sel
      ? {
          text: sel.text,
          in: sel.in,
          ...(sel.blockIds.length > 0 ? { block_ids: sel.blockIds } : {}),
          ...(sel.pdfPages.length > 0 ? { pdf_pages: sel.pdfPages } : {}),
        }
      : null,
  };
  if ((v.kind === "page" || v.kind === "page-history") && v.id) {
    const cursor = v.cursorBlockId ? await blockInfo(v.cursorBlockId) : null;
    return {
      ...screen,
      page_id: v.id,
      page: await pageMarkdown(v.id),
      cursor_block: cursor && v.cursorBlockId ? { block_id: v.cursorBlockId, text: cursor.text } : null,
    };
  }
  if (v.kind === "library-item" && v.id) {
    const details = await itemDetails(v.id);
    const inView = v.pdf && v.pdf.itemId === v.id ? v.pdf : null;
    // Spec: ATL-10
    const reading = v.html && v.html.itemId === v.id ? v.html : null;
    if (reading) {
      return {
        ...screen,
        library_item: details,
        read_as: "text (its HTML version)",
        section_in_view: { section_id: reading.anchor, ...((await htmlSectionText(v.id, reading.anchor)) ?? {}) },
      };
    }
    return {
      ...screen,
      library_item: details,
      pdf_page_in_view: inView?.page ?? null,
      text_of_page_in_view: inView ? ((await pdfText(inView.doc, inView.page, inView.page))[0]?.text ?? "") : null,
    };
  }
  if (v.kind === "person" && v.id) return { ...screen, person: await personView(v.id) };
  if (v.kind === "institution" && v.id) return { ...screen, institution: await institutionView(v.id) };
  return screen;
}

/** What a tool hands back: text for the model, and maybe a picture to show it. */
export interface ToolResult {
  content: string;
  image?: string;
}

// Spec: ATL-1, ATL-2, ATL-3, ATL-4, ATL-5, MEM-4
/** Runs one tool call; the result is text for the model (errors too, so it can recover). */
export async function runTool(name: string, args: Record<string, unknown>, ctx: { canSeeImages: boolean } = { canSeeImages: false }): Promise<ToolResult> {
  if (name === "look_at_screen") {
    // Spec: ATL-1, ATL-7
    try {
      const looked = await lookAtScreen();
      const image = ctx.canSeeImages ? await captureScreen() : null;
      looked["picture"] = image
        ? "A picture of the screen follows this result."
        : ctx.canSeeImages
          ? "The screen couldn't be drawn this time."
          : "Your model can't read images, so there's no picture.";
      return image ? { content: out(looked), image } : { content: out(looked) };
    } catch (e) {
      return { content: `The tool failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  return { content: await runReadTool(name, args) };
}

async function runReadTool(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    switch (name) {
      case "list_pages":
        return out(await pageList());
      case "read_page": {
        const md = await pageMarkdown(text(args["page_id"]));
        return md ? out(md) : "No such page.";
      }
      case "search_book":
        return out(
          (await searchLinkTargets(text(args["query"]))).map((t) =>
            t.blockId ? { block_id: t.blockId, page_id: t.pageId, page: t.title, text: t.snippet } : { page_id: t.pageId, title: t.title },
          ),
        );
      case "search_library":
        return out(
          (await searchLibrary(text(args["query"]))).slice(0, 40).map((i) => ({ item_id: i.id, title: i.title, authors: i.authors, year: i.year, kind: i.kind })),
        );
      case "read_library_item":
        return out((await itemDetails(text(args["item_id"]))) ?? "No such item in the library.");
      case "read_pdf_pages": {
        const id = text(args["item_id"]);
        const from = Math.max(1, num(args["from_page"], 1));
        const to = Math.min(num(args["to_page"], from), from + PDF_PAGES_PER_READ - 1);
        const r = await itemPdfText(id, from, to);
        return out({ item_id: id, pages_in_pdf: r.pages, pages: r.text });
      }
      // Spec: ATL-10
      case "read_section": {
        const s = await htmlSectionText(text(args["item_id"]), text(args["section_id"]) || null);
        return s ? out(s) : "No such section: read_library_item lists an item's text_sections.";
      }
      case "read_person":
        return out((await personView(text(args["person_id"]))) ?? "No such person in the library.");
      case "read_institution":
        return out((await institutionView(text(args["institution_id"]))) ?? "No such institution in the library.");
      case "remember": {
        const kind = args["kind"];
        const what = text(args["text"]);
        if (!what) return "Nothing to remember: the text was empty.";
        return `Remembered as ${await addMemory(isMemoryKind(kind) ? kind : "note", what)}.`;
      }
      case "update_memory":
        return (await updateMemory(text(args["memory_id"]), { text: text(args["text"]) })) ? "Updated." : "No such memory entry.";
      case "forget":
        return (await deleteMemory(text(args["memory_id"]))) ? "Forgotten." : "No such memory entry.";
      default:
        return `There is no tool called ${name}.`;
    }
  } catch (e) {
    return `The tool failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}
