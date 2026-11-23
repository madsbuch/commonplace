import { describe, expect, test } from "bun:test";
import { parseArxivFeed, parseArxivId } from "../src/lib/arxivModel";

// Spec: LIB-23
describe("arXiv identifiers", () => {
  test("however they're written", () => {
    expect(parseArxivId("1706.03762")).toBe("1706.03762");
    expect(parseArxivId(" arXiv:1706.03762v5 ")).toBe("1706.03762");
    expect(parseArxivId("https://arxiv.org/abs/1706.03762")).toBe("1706.03762");
    expect(parseArxivId("https://arxiv.org/pdf/1706.03762v2.pdf")).toBe("1706.03762");
    expect(parseArxivId("arxiv.org/html/2310.06825v1/")).toBe("2310.06825");
    expect(parseArxivId("hep-th/9901001")).toBe("hep-th/9901001");
    expect(parseArxivId("https://arxiv.org/abs/math.GT/0309136v2")).toBe("math.GT/0309136");
  });
  test("and nothing else", () => {
    expect(parseArxivId("")).toBeNull();
    expect(parseArxivId("attention is all you need")).toBeNull();
    expect(parseArxivId("1706.037")).toBeNull();
    expect(parseArxivId("https://example.com/abs/1706.03762x")).toBeNull();
  });
});

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="html">ArXiv Query: search_query=&amp;id_list=1706.03762</title>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <published>2017-06-12T17:57:34Z</published>
    <title>Attention Is All
      You Need</title>
    <summary>  The dominant sequence transduction models &amp; more.</summary>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name><arxiv:affiliation xmlns:arxiv="http://arxiv.org/schemas/atom">Google</arxiv:affiliation></author>
    <author><name>&#321;ukasz Kaiser</name></author>
  </entry>
</feed>`;

describe("arXiv's listing", () => {
  test("title, authors and year", () => {
    expect(parseArxivFeed(FEED)).toEqual({
      id: "1706.03762",
      title: "Attention Is All You Need",
      authors: ["Ashish Vaswani", "Noam Shazeer", "Łukasz Kaiser"],
      year: 2017,
      summary: "The dominant sequence transduction models & more.",
    });
  });
  test("an unknown identifier is no paper", () => {
    const error = `<feed><entry><id>http://arxiv.org/api/errors#incorrect_id_format_for_1706.0376</id><title>Error</title></entry></feed>`;
    expect(parseArxivFeed(error)).toBeNull();
    expect(parseArxivFeed("<feed></feed>")).toBeNull();
  });
});
