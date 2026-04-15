import { describe, expect, test } from "vitest";
import {
  checkpointEntriesToMessages,
  legacyUiMessageToMessage,
} from "./converters.ts";

describe("legacyUiMessageToMessage", () => {
  test("converts legacy AI SDK tool parts into canonical tool-call/output parts", () => {
    const message = legacyUiMessageToMessage({
      id: "assistant-1",
      role: "assistant",
      parts: [
        { type: "text", text: "Running command" },
        {
          type: "tool-bash",
          toolCallId: "call-1",
          state: "output-available",
          input: { command: "pwd" },
          output: { stdout: "/tmp" },
        },
      ],
    });

    expect(message).toEqual({
      id: "assistant-1",
      role: "assistant",
      parts: [
        { type: "text", text: "Running command" },
        {
          type: "tool-call",
          callId: "call-1",
          name: "bash",
          arguments: { command: "pwd" },
          state: "output-available",
          output: { stdout: "/tmp" },
          errorText: undefined,
        },
        {
          type: "tool-output",
          callId: "call-1",
          output: { stdout: "/tmp" },
          errorText: undefined,
        },
      ],
      metadata: undefined,
    });
  });
});

describe("checkpointEntriesToMessages", () => {
  test("normalizes mixed checkpoint entry shapes into canonical messages", () => {
    const messages = checkpointEntriesToMessages([
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "Hello" }],
      },
      {
        role: "assistant",
        content: {
          type: "message",
          content: "Hi there",
        },
      },
      {
        role: "assistant",
        content: {
          id: "legacy-1",
          role: "assistant",
          parts: [{ type: "text", text: "Legacy row" }],
        },
      },
    ]);

    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual({
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "Hello" }],
    });
    expect(messages[1]?.role).toBe("assistant");
    expect(messages[1]?.parts).toEqual([{ type: "text", text: "Hi there" }]);
    expect(messages[2]).toEqual({
      id: "legacy-1",
      role: "assistant",
      parts: [{ type: "text", text: "Legacy row" }],
      metadata: undefined,
    });
  });
});
