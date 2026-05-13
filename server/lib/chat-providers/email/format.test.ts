import { test, expect, describe } from "vitest";
import { markdownToHtml, replySubject } from "./format.ts";

describe("markdownToHtml", () => {
  test("escapes HTML entities in plain text", () => {
    const html = markdownToHtml("a < b & c");
    expect(html).toContain("a &lt; b &amp; c");
  });

  test("converts bold and inline code", () => {
    const html = markdownToHtml("**hello** `code`");
    expect(html).toContain("<strong>hello</strong>");
    expect(html).toContain("<code>code</code>");
  });

  test("preserves fenced code block contents verbatim (re-escaped)", () => {
    const html = markdownToHtml("```\nif (a < b) { return; }\n```");
    expect(html).toContain("<pre><code>");
    expect(html).toContain("if (a &lt; b)");
  });

  test("renders bullet lists", () => {
    const html = markdownToHtml("- one\n- two");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>one</li>");
  });

  test("renders links", () => {
    const html = markdownToHtml("[home](https://example.com)");
    expect(html).toContain('<a href="https://example.com">home</a>');
  });
});

describe("replySubject", () => {
  test("prepends Re: when missing", () => {
    expect(replySubject("Hello")).toBe("Re: Hello");
  });
  test("leaves existing Re: untouched", () => {
    expect(replySubject("Re: Hello")).toBe("Re: Hello");
    expect(replySubject("RE: Hello")).toBe("RE: Hello");
  });
});
