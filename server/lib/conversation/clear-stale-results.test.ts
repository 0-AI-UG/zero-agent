import { test, expect, describe } from "vitest";
import { clearStaleToolResults } from "./clear-stale-results.ts";
import type { Message, ToolCallPart } from "@/lib/messages/types.ts";

let callSeq = 0;
function nextCallId(prefix = "call"): string {
  callSeq += 1;
  return `${prefix}-${callSeq}`;
}

function makeAssistantWithToolCall(toolName: string, callId: string, args: unknown = {}): Message {
  return {
    id: `m-${callId}`,
    role: "assistant",
    parts: [
      {
        type: "tool-call",
        callId,
        name: toolName,
        arguments: args,
        state: "output-available",
      } as ToolCallPart,
    ],
  };
}

function makeToolMsg(output: unknown, callId: string): Message {
  return {
    id: `t-${callId}`,
    role: "tool",
    parts: [
      {
        type: "tool-output",
        callId,
        output,
      },
    ],
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

function getOutput(msg: Message | undefined): unknown {
  const p = msg?.parts?.[0];
  if (p && p.type === "tool-output") return p.output;
  return undefined;
}

describe("clearStaleToolResults", () => {
  test("preserves tool results within maxAge", () => {
    const callId = nextCallId();
    const messages: Message[] = [
      makeUserMsg(),
      makeAssistantWithToolCall("fetchUrl", callId),
      makeToolMsg({ url: "https://example.com", title: "Example" }, callId),
      makeAssistantMsg(), // age 1 - fetchUrl maxAge 2, should keep
    ];

    const result = clearStaleToolResults(messages);
    expect(result).toBe(messages);
  });

  test("replaces tool results beyond maxAge", () => {
    const callId = nextCallId();
    const messages: Message[] = [
      makeUserMsg(),
      makeAssistantWithToolCall("fetchUrl", callId),
      makeToolMsg({ url: "https://example.com", title: "Example" }, callId),
      makeAssistantMsg(),
      makeUserMsg(),
      makeAssistantMsg(),
      makeUserMsg(),
      makeAssistantMsg(),
    ];

    const result = clearStaleToolResults(messages);
    expect(result).not.toBe(messages);

    const output = getOutput(result[2]);
    expect(output).toEqual({
      type: "text",
      value: "[fetched https://example.com - Example]",
    });
  });

  test("only keeps the most recent browser snapshot", () => {
    const c1 = nextCallId("b");
    const c2 = nextCallId("b");
    const c3 = nextCallId("b");
    const messages: Message[] = [
      makeUserMsg(),
      makeAssistantWithToolCall("browser", c1),
      makeToolMsg({ url: "https://page1.com", content: "tree1" }, c1),
      makeAssistantWithToolCall("browser", c2),
      makeToolMsg({ url: "https://page2.com", content: "tree2" }, c2),
      makeAssistantWithToolCall("browser", c3),
      makeToolMsg({ url: "https://page3.com", content: "tree3" }, c3),
    ];

    const result = clearStaleToolResults(messages);
    expect(getOutput(result[2])).toEqual({
      type: "text",
      value: "[snapshot: https://page1.com]",
    });
    expect(getOutput(result[4])).toEqual({
      type: "text",
      value: "[snapshot: https://page2.com]",
    });
    expect(getOutput(result[6])).toEqual({ url: "https://page3.com", content: "tree3" });
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
      makeAssistantWithToolCall("unknownTool", callId),
      makeToolMsg({ data: "something" }, callId),
      makeAssistantMsg(),
      makeAssistantMsg(),
      makeAssistantMsg(),
    ];
    const result = clearStaleToolResults(messages);
    expect(result).toBe(messages);
  });
});
