// What the model is told and asked for when it reads a library item's
// details, and how its answer is read. Kept apart from lib/libraryDetails.ts
// (which needs pdf.js and the database) so it can be tested on its own.

import { z } from "zod";
import type { ContentPart, RichMessage } from "./openrouter";

export const SYSTEM_PROMPT = `You read the first pages of a paper or a book, or a blog post, and give its bibliographic details.

- title: the work's full title as printed, subtitle included after a colon. Not a journal or series name.
- authors: in the order printed, each person's full name as printed, without titles (Dr., Prof.), degrees or footnote marks. For each author, the institutions they are listed with on this work, each as the institution's own full name: the university, institute or company, without department, address, city or country ("University of Cambridge", not "Computer Laboratory, Cambridge, UK"; "Massachusetts Institute of Technology", not "MIT CSAIL"). An empty list when none is given. Editors count as authors only for an edited book with no other authors. A blog post's authors are the people it names as its authors, none when it names none (never the site or the company itself); on an organisation's own blog, their institution is that organisation unless the post says otherwise.
- year: the year this work was published, if the pages say; never the year of a cited work. Otherwise null.
- kind: "book" for a book (monograph, textbook, edited volume, lecture notes in book form), otherwise "paper" (articles, preprints, theses, reports, chapters, conference papers).`;

export const DETAILS_FORMAT = {
  name: "library_item_details",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["title", "authors", "year", "kind"],
    properties: {
      title: { type: "string" },
      authors: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "institutions"],
          properties: { name: { type: "string" }, institutions: { type: "array", items: { type: "string" } } },
        },
      },
      year: { type: ["integer", "null"] },
      kind: { type: "string", enum: ["paper", "book"] },
    },
  },
};

/** What the model answered, forgivingly: a sloppy field degrades instead of failing the rest. */
const DetailsSchema = z.object({
  title: z.string().catch(""),
  authors: z
    .array(
      z.object({
        name: z.string().catch(""),
        institutions: z.array(z.string()).catch([]),
      }),
    )
    .catch([]),
  year: z.coerce
    .number()
    .int()
    .min(1400)
    .max(2200)
    .nullable()
    .catch(null),
  kind: z.string().catch("paper"),
});
export type ReadDetails = z.output<typeof DetailsSchema>;

export function parseDetails(raw: unknown): ReadDetails {
  return DetailsSchema.parse(raw);
}

/** What a blog post's page gives of itself (LIB-28). */
export interface PostDetails {
  title: string;
  authors: readonly string[];
  year: number | null;
  site: string;
}

export function detailsMessages(
  pages: { text: string } | { images: string[] },
  known?: { title: string; authors: readonly string[]; year: number | null },
  post?: PostDetails,
): RichMessage[] {
  // Spec: LIB-23
  // What arXiv's listing says stands; the pages give the institutions.
  const facts = known
    ? `\n\narXiv lists this paper as: title "${known.title}"; authors ${known.authors.join("; ")}${known.year ? `; year ${known.year}` : ""}. Give exactly these title, authors (in this order) and year, and find each author's institutions in the pages.`
    : "";
  // Spec: LIB-28
  // What the page gives of itself stands; the text gives the rest.
  const given = post
    ? [`title "${post.title}"`, post.authors.length > 0 ? `authors ${post.authors.join("; ")}` : null, post.year ? `year ${post.year}` : null].filter((x) => x !== null).join("; ")
    : "";
  const intro = post
    ? `The text of a blog post in my library, from ${post.site}, as its page shows it. Give its details. The page gives: ${given}. Keep what it gives, and find the rest in the text.`
    : `The first pages of a paper or book in my library. Give its details.${facts}`;
  const content: string | ContentPart[] =
    "text" in pages
      ? `${intro}\n\n${pages.text}`
      : [{ type: "text", text: `${intro} The pages are scanned, so here are images of them.` }, ...pages.images.map((url): ContentPart => ({ type: "image_url", image_url: { url } }))];
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content },
  ];
}

