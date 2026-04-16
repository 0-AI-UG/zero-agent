import { test, expect, describe } from "vitest";
import { applyEdits } from "./apply-edits.ts";
import { lintContent } from "./lint.ts";

const sampleFile = `# My Document
Line 2 content
Line 3 content
Line 4 content
Line 5 content`;

test("search-and-replace edit still works", async () => {
  const result = await applyEdits(sampleFile, [
    { oldText: "Line 2 content", newText: "Updated line 2" },
  ]);
  expect(result).toContain("Updated line 2");
  expect(result).toContain("# My Document");
});

// --- Fuzzy matching tests ---

describe("fuzzy whitespace matching", () => {
  test("matches despite trailing whitespace differences", async () => {
    const content = "hello world   \nfoo bar";
    const result = await applyEdits(content, [
      { oldText: "hello world\nfoo bar", newText: "replaced" },
    ]);
    expect(result).toBe("replaced");
  });

  test("matches despite tab vs space differences", async () => {
    const content = "\tindented line\n\t\tnested line";
    const result = await applyEdits(content, [
      { oldText: "  indented line\n    nested line", newText: "replaced" },
    ]);
    expect(result).toBe("replaced");
  });

  test("matches despite CRLF vs LF differences", async () => {
    const content = "line one\r\nline two\r\nline three";
    const result = await applyEdits(content, [
      { oldText: "line one\nline two", newText: "replaced" },
    ]);
    expect(result).toContain("replaced");
    expect(result).toContain("line three");
  });

  test("prefers exact match over fuzzy", async () => {
    const content = "exact match here";
    const result = await applyEdits(content, [
      { oldText: "exact match here", newText: "replaced" },
    ]);
    expect(result).toBe("replaced");
  });

  test("still throws when no fuzzy match possible", async () => {
    expect(
      applyEdits(sampleFile, [
        { oldText: "completely nonexistent text xyz", newText: "x" },
      ])
    ).rejects.toThrow("exact and fuzzy match both failed");
  });
});

// --- Linter tests ---

describe("lintContent", () => {
  test("valid JSON returns no issues", () => {
    const result = lintContent('{"key": "value"}', "application/json");
    expect(result).toEqual([]);
  });

  test("invalid JSON returns error diagnostic", () => {
    const result = lintContent('{"key": }', "application/json");
    expect(result.length).toBe(1);
    expect(result[0]!.severity).toBe("error");
    expect(result[0]!.message).toContain("JSON syntax error");
  });

  test("valid markdown returns no issues", () => {
    const result = lintContent("# Heading\n\nParagraph text.", "text/markdown");
    expect(result).toEqual([]);
  });

  test("markdown heading missing space", () => {
    const result = lintContent("#Missing space", "text/markdown");
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0]!.message).toContain("Heading missing space");
  });

  test("markdown unclosed code fence", () => {
    const result = lintContent("```js\nconst x = 1;\n", "text/markdown");
    expect(result.some((d) => d.message.includes("Unclosed fenced code block"))).toBe(true);
  });

  test("unknown mime type returns no issues", () => {
    const result = lintContent("anything", "image/png");
    expect(result).toEqual([]);
  });
});
