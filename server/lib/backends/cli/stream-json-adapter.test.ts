import { describe, expect, test } from "vitest";
import type { Part, ToolCallPart, ToolOutputPart, TextPart, ReasoningPart } from "@/lib/messages/types.ts";
import { claudeEventToParts, codexEventToParts } from "./stream-json-adapter.ts";

describe("claudeEventToParts", () => {
  test("assistant text block → text part", () => {
    const r = claudeEventToParts({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello!" }] },
    });
    expect(r.parts).toEqual([{ type: "text", text: "Hello!" } satisfies TextPart]);
  });

  test("assistant thinking block → reasoning part (with signature)", () => {
    const r = claudeEventToParts({
      type: "assistant",
      message: {
        content: [{ type: "thinking", thinking: "Let me think...", signature: "sig-1" }],
      },
    });
    expect(r.parts).toEqual([
      { type: "reasoning", text: "Let me think...", signature: "sig-1" } satisfies ReasoningPart,
    ]);
  });

  test("assistant tool_use → tool-call in input-available state", () => {
    const r = claudeEventToParts({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: "call_abc",
          name: "Read",
          input: { file_path: "/project/src/app.ts" },
        }],
      },
    });
    expect(r.parts).toEqual([
      {
        type: "tool-call",
        callId: "call_abc",
        name: "Read",
        arguments: { file_path: "/project/src/app.ts" },
        state: "input-available",
      } satisfies ToolCallPart,
    ]);
  });

  test("assistant tool_use missing id or name is dropped", () => {
    const r = claudeEventToParts({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Read", input: {} },
          { type: "tool_use", id: "x", input: {} },
        ],
      },
    });
    expect(r.parts).toEqual([]);
  });

  test("assistant message with mixed block types preserves order", () => {
    const r = claudeEventToParts({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Looking..." },
          { type: "tool_use", id: "c1", name: "Bash", input: { command: "ls" } },
          { type: "text", text: "Found it." },
        ],
      },
    });
    expect(r.parts.map((p) => p.type)).toEqual(["text", "tool-call", "text"]);
  });

  test("user tool_result → tool-output part", () => {
    const r = claudeEventToParts({
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "call_abc",
          content: "file contents",
        }],
      },
    });
    expect(r.parts).toEqual([
      {
        type: "tool-output",
        callId: "call_abc",
        output: "file contents",
        errorText: undefined,
      } satisfies ToolOutputPart,
    ]);
  });

  test("user tool_result with is_error sets errorText", () => {
    const r = claudeEventToParts({
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "call_err",
          content: "ENOENT: file not found",
          is_error: true,
        }],
      },
    });
    expect(r.parts[0]).toMatchObject({
      type: "tool-output",
      callId: "call_err",
      errorText: "ENOENT: file not found",
    });
  });

  test("user tool_result with array content stringifies error", () => {
    const r = claudeEventToParts({
      type: "user",
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "call_err",
          content: [{ type: "text", text: "part-a" }, { type: "text", text: "part-b" }],
          is_error: true,
        }],
      },
    });
    expect(r.parts[0]).toMatchObject({ errorText: "part-apart-b" });
  });

  test("result event with success → usage only", () => {
    const r = claudeEventToParts({
      type: "result",
      subtype: "success",
      result: "ok",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
      },
    });
    expect(r.parts).toEqual([]);
    expect(r.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      reasoningTokens: 0,
      cachedInputTokens: 15,
    });
    expect(r.errorText).toBeUndefined();
  });

  test("result event with error subtype surfaces errorText", () => {
    const r = claudeEventToParts({
      type: "result",
      subtype: "error_during_execution",
      result: "something broke",
      usage: {},
    });
    expect(r.errorText).toBe("something broke");
  });

  test("result event with missing usage fields defaults to 0", () => {
    const r = claudeEventToParts({ type: "result", subtype: "success", usage: {} });
    expect(r.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cachedInputTokens: 0,
    });
  });

  test("unknown top-level event type is a no-op (forward-compat)", () => {
    const r = claudeEventToParts({ type: "some_new_event_type_2030", data: { x: 1 } });
    expect(r.parts).toEqual([]);
    expect(r.usage).toBeUndefined();
    expect(r.errorText).toBeUndefined();
  });

  test("malformed / non-object events return empty", () => {
    expect(claudeEventToParts(null).parts).toEqual([]);
    expect(claudeEventToParts("string").parts).toEqual([]);
    expect(claudeEventToParts(42).parts).toEqual([]);
    expect(claudeEventToParts(undefined).parts).toEqual([]);
  });

  test("system init event is ignored (no parts)", () => {
    expect(claudeEventToParts({ type: "system", subtype: "init", cwd: "/project" }).parts).toEqual([]);
  });
});

describe("codexEventToParts", () => {
  test("thread.started → threadId only", () => {
    const r = codexEventToParts({ type: "thread.started", thread_id: "thr_123" });
    expect(r.parts).toEqual([]);
    expect(r.threadId).toBe("thr_123");
  });

  test("thread.started without thread_id", () => {
    const r = codexEventToParts({ type: "thread.started" });
    expect(r.threadId).toBeUndefined();
  });

  test("item.completed agent_message → text part", () => {
    const r = codexEventToParts({
      type: "item.completed",
      item: { id: "m1", type: "agent_message", text: "Done." },
    });
    expect(r.parts).toEqual([{ type: "text", text: "Done." }]);
  });

  test("item.completed reasoning → reasoning part", () => {
    const r = codexEventToParts({
      type: "item.completed",
      item: { id: "r1", type: "reasoning", text: "I considered..." },
    });
    expect(r.parts[0]).toEqual({ type: "reasoning", text: "I considered..." });
  });

  test("item.started command_execution → Bash tool-call input-available", () => {
    const r = codexEventToParts({
      type: "item.started",
      item: { id: "c1", type: "command_execution", command: "ls -la", status: "running" },
    });
    expect(r.parts).toEqual([
      {
        type: "tool-call",
        callId: "c1",
        name: "Bash",
        arguments: { command: "ls -la" },
        state: "input-available",
      } satisfies ToolCallPart,
    ]);
  });

  test("item.completed command_execution success → tool-call + tool-output", () => {
    const r = codexEventToParts({
      type: "item.completed",
      item: {
        id: "c1",
        type: "command_execution",
        command: "ls",
        status: "completed",
        aggregated_output: "a.ts b.ts",
        exit_code: 0,
      },
    });
    expect(r.parts).toHaveLength(2);
    expect((r.parts[0] as ToolCallPart).state).toBe("output-available");
    expect(r.parts[1]).toMatchObject({
      type: "tool-output",
      callId: "c1",
      output: "a.ts b.ts",
      errorText: undefined,
    });
  });

  test("item.completed command_execution failed → errorText set", () => {
    const r = codexEventToParts({
      type: "item.completed",
      item: {
        id: "c1",
        type: "command_execution",
        command: "false",
        status: "failed",
        aggregated_output: "",
        exit_code: 1,
      },
    });
    expect((r.parts[0] as ToolCallPart).state).toBe("output-error");
    expect((r.parts[1] as ToolOutputPart).errorText).toMatch(/failed/);
    expect((r.parts[1] as ToolOutputPart).errorText).toMatch(/exit=1/);
  });

  test("item file_change → Edit tool-call", () => {
    const changes = [{ path: "a.ts", kind: "edit" }];
    const r = codexEventToParts({
      type: "item.completed",
      item: { id: "f1", type: "file_change", status: "completed", changes },
    });
    expect(r.parts[0]).toMatchObject({ type: "tool-call", name: "Edit", callId: "f1" });
    expect((r.parts[1] as ToolOutputPart).output).toEqual(changes);
  });

  test("item mcp_tool_call → namespaced tool-call + output", () => {
    const r = codexEventToParts({
      type: "item.completed",
      item: {
        id: "m1",
        type: "mcp_tool_call",
        server: "gh",
        tool: "create_issue",
        status: "completed",
        arguments: { title: "hi" },
        result: { content: "issue-1" },
      },
    });
    expect((r.parts[0] as ToolCallPart).name).toBe("gh.create_issue");
    expect((r.parts[1] as ToolOutputPart).output).toBe("issue-1");
  });

  test("item web_search emits query-only tool-call", () => {
    const r = codexEventToParts({
      type: "item.completed",
      item: { id: "w1", type: "web_search", query: "claude code" },
    });
    expect((r.parts[0] as ToolCallPart).name).toBe("WebSearch");
    expect((r.parts[0] as ToolCallPart).arguments).toEqual({ query: "claude code" });
  });

  test("item todo_list emits TodoWrite pair in output-available", () => {
    const items = [{ text: "first", done: false }, { text: "second", done: true }];
    const r = codexEventToParts({
      type: "item.completed",
      item: { id: "t1", type: "todo_list", items },
    });
    expect(r.parts).toHaveLength(2);
    expect((r.parts[0] as ToolCallPart).name).toBe("TodoWrite");
    expect((r.parts[0] as ToolCallPart).state).toBe("output-available");
    expect((r.parts[1] as ToolOutputPart).output).toEqual(items);
  });

  test("item error → warning text part", () => {
    const r = codexEventToParts({
      type: "item.completed",
      item: { id: "e1", type: "error", message: "something broke" },
    });
    expect((r.parts[0] as TextPart).text).toMatch(/something broke/);
  });

  test("turn.completed carries usage", () => {
    const r = codexEventToParts({
      type: "turn.completed",
      usage: { input_tokens: 42, cached_input_tokens: 7, output_tokens: 13 },
    });
    expect(r.usage).toEqual({
      inputTokens: 42,
      outputTokens: 13,
      reasoningTokens: 0,
      cachedInputTokens: 7,
    });
  });

  test("turn.failed surfaces errorText", () => {
    const r = codexEventToParts({ type: "turn.failed", error: { message: "model refused" } });
    expect(r.errorText).toBe("model refused");
  });

  test("top-level error event surfaces errorText", () => {
    const r = codexEventToParts({ type: "error", message: "fatal" });
    expect(r.errorText).toBe("fatal");
  });

  test("unknown item types are a no-op (forward-compat)", () => {
    const r = codexEventToParts({
      type: "item.completed",
      item: { id: "x", type: "some_future_item_type", data: {} },
    });
    expect(r.parts).toEqual([]);
  });

  test("unknown top-level event type is a no-op (forward-compat)", () => {
    const r = codexEventToParts({ type: "brand.new.event.2030" });
    expect(r.parts).toEqual([]);
    expect(r.usage).toBeUndefined();
    expect(r.errorText).toBeUndefined();
  });

  test("malformed / non-object events return empty", () => {
    expect(codexEventToParts(null).parts).toEqual([]);
    expect(codexEventToParts("string").parts).toEqual([]);
    expect(codexEventToParts(42).parts).toEqual([]);
  });

  test("item.started without item field returns empty", () => {
    expect(codexEventToParts({ type: "item.started" }).parts).toEqual([]);
  });

  test("item.updated command_execution mid-stream is input-available (not completed)", () => {
    const r = codexEventToParts({
      type: "item.updated",
      item: { id: "c1", type: "command_execution", command: "sleep 5", status: "running" },
    });
    expect((r.parts[0] as ToolCallPart).state).toBe("input-available");
    expect(r.parts).toHaveLength(1);
  });
});

describe("stream-json-adapter regression: Part shape compatibility", () => {
  // Renderer code depends on (callId, state) being present on every tool-call
  // Part. These assertions guard against drift if event shapes change.
  test("every claude tool-call has callId + name + state", () => {
    const r = claudeEventToParts({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "c1", name: "Read", input: {} }],
      },
    });
    const tc = r.parts[0] as ToolCallPart;
    expect(tc).toMatchObject({ type: "tool-call", callId: expect.any(String), name: expect.any(String), state: expect.any(String) });
  });

  test("every codex tool-call has callId + name + state", () => {
    const events = [
      { type: "item.started", item: { id: "c1", type: "command_execution", command: "x", status: "running" } },
      { type: "item.completed", item: { id: "f1", type: "file_change", status: "completed", changes: [] } },
      { type: "item.completed", item: { id: "w1", type: "web_search", query: "q" } },
    ];
    for (const ev of events) {
      const r = codexEventToParts(ev);
      const tc = r.parts.find((p: Part) => p.type === "tool-call") as ToolCallPart | undefined;
      expect(tc).toBeDefined();
      expect(tc!.callId).toBeTruthy();
      expect(tc!.name).toBeTruthy();
      expect(tc!.state).toBeTruthy();
    }
  });
});
