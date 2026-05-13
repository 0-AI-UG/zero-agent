import { test, expect, describe } from "vitest";
import {
  parseReferenceIds,
  normaliseMessageId,
  deriveThreadKey,
  buildOutboundReferences,
} from "./threading.ts";

describe("parseReferenceIds", () => {
  test("returns empty array when header missing", () => {
    expect(parseReferenceIds(null)).toEqual([]);
    expect(parseReferenceIds("")).toEqual([]);
  });
  test("splits multiple <id> tokens, lowercased", () => {
    expect(parseReferenceIds("<a@x.com> <B@y.com>")).toEqual(["<a@x.com>", "<b@y.com>"]);
  });
});

describe("normaliseMessageId", () => {
  test("wraps in angle brackets and lowercases", () => {
    expect(normaliseMessageId("A@x.com")).toBe("<a@x.com>");
    expect(normaliseMessageId("<B@x.com>")).toBe("<b@x.com>");
  });
  test("returns null for empty input", () => {
    expect(normaliseMessageId(null)).toBeNull();
    expect(normaliseMessageId("")).toBeNull();
  });
});

describe("deriveThreadKey", () => {
  test("uses first References id when present", () => {
    expect(
      deriveThreadKey({
        messageId: "<own@x.com>",
        inReplyTo: "<parent@x.com>",
        references: "<root@x.com> <parent@x.com>",
      }),
    ).toBe("<root@x.com>");
  });
  test("falls back to inReplyTo when References is missing", () => {
    expect(
      deriveThreadKey({ messageId: "<own@x.com>", inReplyTo: "<parent@x.com>", references: null }),
    ).toBe("<parent@x.com>");
  });
  test("falls back to own messageId when no parent", () => {
    expect(deriveThreadKey({ messageId: "<own@x.com>", inReplyTo: null, references: null })).toBe("<own@x.com>");
  });
  test("synthesises an orphan key when everything is missing", () => {
    expect(deriveThreadKey({ messageId: null, inReplyTo: null, references: null })).toMatch(/^<orphan-/);
  });
});

describe("buildOutboundReferences", () => {
  test("appends parent messageId to existing chain", () => {
    const { inReplyTo, references } = buildOutboundReferences({
      messageId: "<parent@x.com>",
      inReplyTo: null,
      references: "<root@x.com>",
    });
    expect(inReplyTo).toBe("<parent@x.com>");
    expect(references).toBe("<root@x.com> <parent@x.com>");
  });
  test("dedupes when parent is already in chain", () => {
    const { references } = buildOutboundReferences({
      messageId: "<parent@x.com>",
      inReplyTo: null,
      references: "<root@x.com> <parent@x.com>",
    });
    expect(references).toBe("<root@x.com> <parent@x.com>");
  });
  test("returns null references when no parent at all", () => {
    const { inReplyTo, references } = buildOutboundReferences({ messageId: null, inReplyTo: null, references: null });
    expect(inReplyTo).toBeNull();
    expect(references).toBeNull();
  });
});
