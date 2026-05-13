import { test, expect, describe } from "vitest";
import { splitAddress, newMessageIdLocalPart } from "./addressing.ts";

describe("splitAddress", () => {
  test("splits valid addresses", () => {
    expect(splitAddress("a@b.com")).toEqual({ localPart: "a", domain: "b.com" });
    expect(splitAddress("  Foo+Tag@Bar.COM ")).toEqual({ localPart: "foo+tag", domain: "bar.com" });
  });
  test("rejects malformed addresses", () => {
    expect(splitAddress("nope")).toBeNull();
    expect(splitAddress("@b.com")).toBeNull();
    expect(splitAddress("a@")).toBeNull();
  });
});

describe("newMessageIdLocalPart", () => {
  test("returns url-safe id of expected length", () => {
    const id = newMessageIdLocalPart();
    expect(id).toMatch(/^[A-Za-z0-9_-]{24}$/);
  });
  test("two ids do not collide", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(newMessageIdLocalPart());
    expect(seen.size).toBe(100);
  });
});
