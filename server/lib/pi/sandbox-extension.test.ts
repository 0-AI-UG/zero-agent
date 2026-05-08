import { describe, expect, test } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { checkToolCall } from "./sandbox-extension.ts";
import { buildPiSandboxPolicy } from "./sandbox-policy.ts";

const PROJECT_DIR = "/var/zero/projects/p1";
const SOCKET_DIR = "/tmp/zero-pi-sockets/run-1";
const policy = buildPiSandboxPolicy({
  projectDir: PROJECT_DIR,
  socketDir: SOCKET_DIR,
});
const opts = { policy, projectDir: PROJECT_DIR };

describe("checkToolCall", () => {
  test("read of a project file is allowed", () => {
    expect(
      checkToolCall(
        { toolName: "read", input: { path: "hello.txt" } },
        opts,
      ),
    ).toEqual({ block: false });
  });

  test("read of ~/.ssh/id_rsa is blocked", () => {
    const r = checkToolCall(
      { toolName: "read", input: { path: "~/.ssh/id_rsa" } },
      opts,
    );
    expect(r.block).toBe(true);
    expect(r.reason).toMatch(/denied read prefix/);
  });

  test("read of ~/.aws via absolute path is blocked", () => {
    const r = checkToolCall(
      {
        toolName: "grep",
        input: { pattern: "x", path: join(homedir(), ".aws") },
      },
      opts,
    );
    expect(r.block).toBe(true);
  });

  test("ls/find with no path default to project dir → allowed", () => {
    expect(checkToolCall({ toolName: "ls", input: {} }, opts).block).toBe(
      false,
    );
    expect(
      checkToolCall(
        { toolName: "find", input: { pattern: "*.ts" } },
        opts,
      ).block,
    ).toBe(false);
  });

  test("write outside the project is blocked", () => {
    const r = checkToolCall(
      { toolName: "write", input: { path: "/etc/hosts", content: "x" } },
      opts,
    );
    expect(r.block).toBe(true);
    expect(r.reason).toMatch(/allowWrite/);
  });

  test("write of .env inside project is blocked by denyWrite", () => {
    const r = checkToolCall(
      { toolName: "write", input: { path: ".env", content: "x" } },
      opts,
    );
    expect(r.block).toBe(true);
    expect(r.reason).toMatch(/denyWrite/);
  });

  test("write of a normal project file is allowed", () => {
    expect(
      checkToolCall(
        {
          toolName: "write",
          input: { path: "src/index.ts", content: "x" },
        },
        opts,
      ).block,
    ).toBe(false);
  });

  test("edit on a path that escapes the project via .. is blocked", () => {
    const r = checkToolCall(
      {
        toolName: "edit",
        input: { path: "../../etc/hosts", edits: [] },
      },
      opts,
    );
    expect(r.block).toBe(true);
  });

  test("custom tools fall through (not gated)", () => {
    expect(
      checkToolCall(
        { toolName: "browser_screenshot", input: { path: "anything" } },
        opts,
      ).block,
    ).toBe(false);
  });
});
