import { test, expect, describe } from "bun:test";
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

test("line-range edit replaces lines", async () => {
  const result = await applyEdits(sampleFile, [
    { startLine: 2, endLine: 3, newText: "Replaced line 2\nReplaced line 3" },
  ]);
  const lines = result.split("\n");
  expect(lines[0]).toBe("# My Document");
  expect(lines[1]).toBe("Replaced line 2");
  expect(lines[2]).toBe("Replaced line 3");
  expect(lines[3]).toBe("Line 4 content");
});

test("line-range edit can delete lines (empty newText)", async () => {
  const result = await applyEdits(sampleFile, [
    { startLine: 2, endLine: 3, newText: "" },
  ]);
  const lines = result.split("\n");
  expect(lines[0]).toBe("# My Document");
  expect(lines[1]).toBe("Line 4 content");
  expect(lines.length).toBe(3);
});

test("line-range edit can insert more lines than removed", async () => {
  const result = await applyEdits(sampleFile, [
    { startLine: 2, endLine: 2, newText: "New A\nNew B\nNew C" },
  ]);
  const lines = result.split("\n");
  expect(lines[1]).toBe("New A");
  expect(lines[2]).toBe("New B");
  expect(lines[3]).toBe("New C");
  expect(lines[4]).toBe("Line 3 content");
});

test("line-range edit clamps endLine to file length", async () => {
  const result = await applyEdits(sampleFile, [
    { startLine: 4, endLine: 100, newText: "Last line" },
  ]);
  const lines = result.split("\n");
  expect(lines.length).toBe(4);
  expect(lines[3]).toBe("Last line");
});

test("line-range edit throws on out-of-bounds startLine", async () => {
  expect(
    applyEdits(sampleFile, [{ startLine: 0, endLine: 2, newText: "x" }])
  ).rejects.toThrow("out of bounds");

  expect(
    applyEdits(sampleFile, [{ startLine: 100, endLine: 200, newText: "x" }])
  ).rejects.toThrow("out of bounds");
});

test("mixed edit types in single call", async () => {
  const result = await applyEdits(sampleFile, [
    { startLine: 2, endLine: 2, newText: "Replaced via line range" },
    { oldText: "Line 4 content", newText: "Replaced via search" },
  ]);
  expect(result).toContain("Replaced via line range");
  expect(result).toContain("Replaced via search");
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
