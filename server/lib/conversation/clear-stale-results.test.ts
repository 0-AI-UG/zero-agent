import { test, expect, describe } from "vitest";
import { clearStaleToolResults } from "./clear-stale-results.ts";
import type { Message, DynamicToolUIPart } from "@/lib/messages/types.ts";

let callSeq = 0;
function nextCallId(prefix = "call"): string {
  callSeq += 1;
  return `${prefix}-${callSeq}`;
}

function makeAssistantWithToolResult(
  toolName: string,
  callId: string,
  output: unknown,
  args: unknown = {},
): Message {
  const part: DynamicToolUIPart = {
    type: "dynamic-tool",
    toolName,
    toolCallId: callId,
    state: "output-available",
    input: args,
    output,
  };
  return {
    id: `m-${callId}`,
    role: "assistant",
    parts: [part],
  };
}

function makeAssistantMsg(text = "ok"): Message {
  return {
    id: `a-${Math.random().toString(36).slice(2, 8)}`,
    role: "assistant",
    parts: [{ type: "text", text }],
  };
}

function makeUserMsg(text = "hello"): Message {
  return {
    id: `u-${Math.random().toString(36).slice(2, 8)}`,
    role: "user",
    parts: [{ type: "text", text }],
  };
}

function getToolOutput(msg: Message | undefined): unknown {
  const p = msg?.parts?.[0];
  if (p && p.type === "dynamic-tool" && p.state === "output-available") return p.output;
  return undefined;
}

describe("clearStaleToolResults", () => {
  test("preserves tool results within maxAge", () => {
    const callId = nextCallId();
    const messages: Message[] = [
      makeUserMsg(),
      makeAssistantWithToolResult("fetchUrl", callId, { url: "https://example.com", title: "Example" }),
      makeAssistantMsg(), // age 1 - fetchUrl maxAge 2, should keep
    ];

    const result = clearStaleToolResults(messages);
    expect(result).toBe(messages);
  });

  test("replaces tool results beyond maxAge", () => {
    const callId = nextCallId();
    const messages: Message[] = [
      makeUserMsg(),
      makeAssistantWithToolResult("fetchUrl", callId, { url: "https://example.com", title: "Example" }),
      makeAssistantMsg(),
      makeUserMsg(),
      makeAssistantMsg(),
      makeUserMsg(),
      makeAssistantMsg(),
    ];

    const result = clearStaleToolResults(messages);
    expect(result).not.toBe(messages);

    const output = getToolOutput(result[1]);
    expect(output).toEqual({
      type: "text",
      value: "[stale result elided]",
    });
  });

  test("only keeps the most recent browser snapshot", () => {
    const c1 = nextCallId("b");
    const c2 = nextCallId("b");
    const c3 = nextCallId("b");
    const messages: Message[] = [
      makeUserMsg(),
      makeAssistantWithToolResult("browser", c1, { url: "https://page1.com", content: "tree1" }),
      makeAssistantWithToolResult("browser", c2, { url: "https://page2.com", content: "tree2" }),
      makeAssistantWithToolResult("browser", c3, { url: "https://page3.com", content: "tree3" }),
    ];

    const result = clearStaleToolResults(messages);
    expect(getToolOutput(result[1])).toEqual({
      type: "text",
      value: "[stale result elided]",
    });
    expect(getToolOutput(result[2])).toEqual({
      type: "text",
      value: "[stale result elided]",
    });
    expect(getToolOutput(result[3])).toEqual({ url: "https://page3.com", content: "tree3" });
  });

  test("passes through messages with no tool results", () => {
    const messages: Message[] = [
      makeUserMsg(),
      makeAssistantMsg(),
      makeUserMsg(),
      makeAssistantMsg(),
    ];
    const result = clearStaleToolResults(messages);
    expect(result).toBe(messages);
  });

  test("preserves unknown tool names", () => {
    const callId = nextCallId();
    const messages: Message[] = [
      makeAssistantWithToolResult("unknownTool", callId, { data: "something" }),
      makeAssistantMsg(),
      makeAssistantMsg(),
      makeAssistantMsg(),
    ];
    const result = clearStaleToolResults(messages);
    expect(result).toBe(messages);
  });
});
