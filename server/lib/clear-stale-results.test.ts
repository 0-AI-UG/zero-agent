import { test, expect, describe } from "bun:test";
import { clearStaleToolResults } from "./clear-stale-results.ts";
import type { ModelMessage } from "@ai-sdk/provider-utils";

function makeToolMsg(toolName: string, output: unknown, toolCallId = "call-1"): ModelMessage {
  return {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolName,
        toolCallId,
        output: { type: "json", value: output },
      },
    ],
  } as unknown as ModelMessage;
}

function makeAssistantMsg(text = "ok"): ModelMessage {
  return { role: "assistant", content: text } as unknown as ModelMessage;
}

function makeUserMsg(text = "hello"): ModelMessage {
  return { role: "user", content: text } as unknown as ModelMessage;
}

function getOutput(msg: ModelMessage | undefined): unknown {
  if (!msg) return undefined;
  const parts = msg.content as Array<{ output?: unknown }>;
  return parts?.[0]?.output;
}

describe("clearStaleToolResults", () => {
  test("preserves tool results within maxAge", () => {
    const messages: ModelMessage[] = [
      makeUserMsg(),
      makeAssistantMsg(),
      makeToolMsg("fetchUrl", { url: "https://example.com", title: "Example" }),
      makeAssistantMsg(), // age 1 for fetchUrl — maxAge is 2, so it should be kept
    ];

    const result = clearStaleToolResults(messages);
    // fetchUrl has maxAge=2, current age=1, should be preserved
    expect(result).toBe(messages); // same reference = no changes
  });

  test("replaces tool results beyond maxAge", () => {
    const messages: ModelMessage[] = [
      makeUserMsg(),
      makeToolMsg("fetchUrl", { url: "https://example.com", title: "Example" }),
      makeAssistantMsg(), // age count starts
      makeUserMsg(),
      makeAssistantMsg(),
      makeUserMsg(),
      makeAssistantMsg(), // 3 assistant turns — fetchUrl maxAge is 2
    ];

    const result = clearStaleToolResults(messages);
    expect(result).not.toBe(messages);

    const output = getOutput(result[1]);
    expect(output).toEqual({
      type: "text",
      value: "[fetched https://example.com — Example]",
    });
  });

  test("only keeps the most recent browser snapshot", () => {
    const messages: ModelMessage[] = [
      makeUserMsg(),
      makeToolMsg("browser", { url: "https://page1.com", content: "tree1" }, "c1"),
      makeAssistantMsg(),
      makeToolMsg("browser", { url: "https://page2.com", content: "tree2" }, "c2"),
      makeAssistantMsg(),
      makeToolMsg("browser", { url: "https://page3.com", content: "tree3" }, "c3"),
    ];

    const result = clearStaleToolResults(messages);
    // First two snapshots should be replaced, third kept
    const out1 = getOutput(result[1]);
    expect(out1).toEqual({ type: "text", value: "[snapshot: https://page1.com]" });

    const out2 = getOutput(result[3]);
    expect(out2).toEqual({ type: "text", value: "[snapshot: https://page2.com]" });

    // Latest should be preserved
    const out3 = getOutput(result[5]);
    expect(out3).toEqual({ type: "json", value: { url: "https://page3.com", content: "tree3" } });
  });

  test("passes through messages with no tool results", () => {
    const messages: ModelMessage[] = [
      makeUserMsg(),
      makeAssistantMsg(),
      makeUserMsg(),
      makeAssistantMsg(),
    ];

    const result = clearStaleToolResults(messages);
    expect(result).toBe(messages); // same reference
  });

  test("handles all results being stale", () => {
    const messages: ModelMessage[] = [
      makeToolMsg("listFiles", { currentPath: "/", files: [1, 2], folders: [] }),
      makeAssistantMsg(),
      makeToolMsg("fetchUrl", { url: "https://example.com", title: "Example" }),
      makeAssistantMsg(),
      makeUserMsg(),
      makeAssistantMsg(),
      makeUserMsg(),
      makeAssistantMsg(),
    ];

    const result = clearStaleToolResults(messages);
    expect(result).not.toBe(messages);

    const out1 = getOutput(result[0]);
    expect(out1).toEqual({ type: "text", value: "[listed 2 files in /]" });

    const out2 = getOutput(result[2]);
    expect(out2).toEqual({ type: "text", value: "[fetched https://example.com — Example]" });
  });

  test("handles mixed tool types correctly", () => {
    const messages: ModelMessage[] = [
      makeToolMsg("fetchUrl", { url: "https://a.com", title: "A" }),
      makeToolMsg("readFile", { path: "test.md", content: "hello world" }),
      makeAssistantMsg(),
      makeAssistantMsg(),
      makeAssistantMsg(), // age 3 for both — fetchUrl maxAge 2, readFile maxAge 2
    ];

    const result = clearStaleToolResults(messages);
    expect(getOutput(result[0])).toEqual({ type: "text", value: "[fetched https://a.com — A]" });
    expect(getOutput(result[1])).toEqual({ type: "text", value: "[read test.md (11 chars)]" });
  });

  test("preserves unknown tool names", () => {
    const messages: ModelMessage[] = [
      makeToolMsg("unknownTool", { data: "something" }),
      makeAssistantMsg(),
      makeAssistantMsg(),
      makeAssistantMsg(),
    ];

    const result = clearStaleToolResults(messages);
    // Unknown tools have no rule, so they're kept as-is
    expect(result).toBe(messages);
  });
});
