import { test, expect, describe } from "bun:test";
import { truncateText, truncateResult } from "./truncate-result.ts";

describe("truncateText", () => {
  test("returns text unchanged when under limit", () => {
    expect(truncateText("hello", 100)).toBe("hello");
  });

  test("returns text unchanged when at limit", () => {
    const text = "a".repeat(100);
    expect(truncateText(text, 100)).toBe(text);
  });

  test("truncates text over limit with head + tail", () => {
    const text = "A".repeat(50) + "B".repeat(50) + "C".repeat(50);
    const result = truncateText(text, 100);
    expect(result).toContain("A".repeat(50));
    expect(result).toContain("C".repeat(50));
    expect(result).toContain("[...50 chars omitted...]");
    expect(result.length).toBeLessThan(text.length);
  });

  test("handles empty string", () => {
    expect(truncateText("", 100)).toBe("");
  });
});

describe("truncateResult", () => {
  test("truncates string values in objects", () => {
    const obj = { title: "short", content: "x".repeat(200) };
    const result = truncateResult(obj, 100) as Record<string, unknown>;
    expect(result.title).toBe("short");
    expect((result.content as string).length).toBeLessThan(200);
    expect(result.content).toContain("[...");
  });

  test("truncates strings in arrays", () => {
    const arr = ["short", "x".repeat(200)];
    const result = truncateResult(arr, 100) as string[];
    expect(result[0]).toBe("short");
    expect(result[1]).toContain("[...");
  });

  test("leaves numbers, booleans, and nulls untouched", () => {
    const obj = { num: 42, bool: true, nil: null };
    expect(truncateResult(obj, 10)).toEqual({ num: 42, bool: true, nil: null });
  });

  test("handles nested objects", () => {
    const nested = {
      a: { b: { c: "x".repeat(200) } },
      d: [{ e: "y".repeat(200) }],
    };
    const result = truncateResult(nested, 100) as any;
    expect(result.a.b.c).toContain("[...");
    expect(result.d[0].e).toContain("[...");
  });

  test("handles undefined", () => {
    expect(truncateResult(undefined, 100)).toBeUndefined();
  });
});
