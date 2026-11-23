import { describe, expect, test } from "bun:test";
import { bylineAuthors, charsetOf, fullerTitle, hostOf, isPage, webAddress, yearOf } from "../src/lib/webModel";
import { detailsMessages } from "../src/lib/libraryDetailsModel";

describe("blog posts by address", () => {
  // Spec: LIB-28
  test("a web address is read however it's written, without its fragment", () => {
    expect(webAddress("https://z.ai/blog/glm-5.4")).toBe("https://z.ai/blog/glm-5.4");
    expect(webAddress("  z.ai/blog/glm-5.4 ")).toBe("https://z.ai/blog/glm-5.4");
    expect(webAddress("http://example.com/a?b=1#section")).toBe("http://example.com/a?b=1");
    expect(webAddress("example.com")).toBe("https://example.com/");
    for (const no of ["", "1706.03762", "not an address", "file:///etc/passwd", "javascript:alert(1)", "ftp://example.com/x", "localhost/x"]) {
      expect(webAddress(no)).toBeNull();
    }
    expect(hostOf("https://www.example.com/a")).toBe("example.com");
  });

  // Spec: LIB-28
  test("a page's character set comes from its header, else its own meta", () => {
    expect(charsetOf("text/html; charset=ISO-8859-1", "")).toBe("iso-8859-1");
    expect(charsetOf("text/html", '<meta charset="windows-1252">')).toBe("windows-1252");
    expect(charsetOf("text/html", '<meta http-equiv="Content-Type" content="text/html; charset=shift_jis">')).toBe("shift_jis");
    expect(charsetOf("", "<html>")).toBe("utf-8");
    expect(isPage("text/html; charset=utf-8")).toBe(true);
    expect(isPage("")).toBe(true);
    expect(isPage("application/pdf")).toBe(false);
  });

  // Spec: LIB-28
  test("a byline gives the people it names, and nothing when it isn't one", () => {
    expect(bylineAuthors("By Ada Lovelace and Charles Babbage")).toEqual(["Ada Lovelace", "Charles Babbage"]);
    expect(bylineAuthors("Written by: Grace Hopper")).toEqual(["Grace Hopper"]);
    expect(bylineAuthors("Lovelace, Ada")).toEqual(["Ada Lovelace"]);
    expect(bylineAuthors(null)).toEqual([]);
    expect(bylineAuthors("Posted on March 3, 2024 in Research")).toEqual([]);
    expect(bylineAuthors("Follow us at https://example.com")).toEqual([]);
    expect(bylineAuthors("A very long sentence that goes on about the post and what it says, and is no byline at all")).toEqual([]);
  });

  test("a date gives its year", () => {
    expect(yearOf("2026-11-23T09:00:00Z")).toBe(2026);
    expect(yearOf("March 1, 1999")).toBe(1999);
    expect(yearOf("yesterday")).toBeNull();
    expect(yearOf(null)).toBeNull();
  });

  // Spec: LIB-28
  test("a heading that holds the page's short title is the whole title", () => {
    const short = "Toward Generalized Coding with Our First Loop Transformer";
    expect(fullerTitle(short, ["GLM-5.4: Toward Generalized Coding with Our First Loop Transformer"])).toBe(`GLM-5.4: ${short}`);
    expect(fullerTitle(short, ["Something else entirely", "Menu"])).toBe(short);
    expect(fullerTitle("", [" A  heading "])).toBe("A heading");
    // A heading far longer isn't the title: the whole page in one heading, say.
    expect(fullerTitle("Short", [`Short ${"x".repeat(40)}`])).toBe("Short");
  });

  // Spec: LIB-28
  test("the model hears what the page gives of a post, and keeps it", () => {
    const [, user] = detailsMessages({ text: "Over the past three months…" }, undefined, {
      title: "GLM-5.4: Toward Generalized Coding",
      authors: [],
      year: null,
      site: "z.ai",
    });
    expect(typeof user?.content === "string" && user.content).toContain('blog post in my library, from z.ai');
    expect(typeof user?.content === "string" && user.content).toContain('title "GLM-5.4: Toward Generalized Coding"');
    expect(typeof user?.content === "string" && user.content).not.toContain("authors");
  });
});
