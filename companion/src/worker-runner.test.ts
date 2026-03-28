import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { runCodeInWorker } from "./worker-runner.ts";

let workspaceDir: string;

beforeEach(async () => {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "worker-test-"));
  await fs.mkdir(path.join(workspaceDir, ".tmp"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

async function writeFile(name: string, content: string) {
  await fs.writeFile(path.join(workspaceDir, name), content);
}

describe("runCodeInWorker", () => {
  test("captures console.log as stdout", async () => {
    await writeFile("main.ts", `console.log("hello world");`);
    const result = await runCodeInWorker(workspaceDir, 10_000, "main.ts");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello world");
    expect(result.stderr).toBe("");
  });

  test("captures console.error as stderr", async () => {
    await writeFile("main.ts", `console.error("something broke");`);
    const result = await runCodeInWorker(workspaceDir, 10_000, "main.ts");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("something broke");
  });

  test("captures multiple log lines", async () => {
    await writeFile("main.ts", `
      console.log("line 1");
      console.log("line 2");
      console.log("line 3");
    `);
    const result = await runCodeInWorker(workspaceDir, 10_000, "main.ts");
    expect(result.stdout).toContain("line 1");
    expect(result.stdout).toContain("line 2");
    expect(result.stdout).toContain("line 3");
  });

  test("reports exitCode 1 on thrown error", async () => {
    await writeFile("main.ts", `throw new Error("fail");`);
    const result = await runCodeInWorker(workspaceDir, 10_000, "main.ts");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("fail");
  });

  test("handles top-level await", async () => {
    await writeFile("main.ts", `
      const val = await Promise.resolve(42);
      console.log("got " + val);
    `);
    const result = await runCodeInWorker(workspaceDir, 10_000, "main.ts");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("got 42");
  });

  test("can import other files in workspace", async () => {
    await writeFile("lib.ts", `export const greeting = "hi from lib";`);
    await writeFile("main.ts", `
      import { greeting } from "./lib.ts";
      console.log(greeting);
    `);
    const result = await runCodeInWorker(workspaceDir, 10_000, "main.ts");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hi from lib");
  });

  test("can read files in workspace", async () => {
    await writeFile("data.txt", "file contents here");
    await writeFile("main.ts", `
      const text = await Bun.file("./data.txt").text();
      console.log(text);
    `);
    const result = await runCodeInWorker(workspaceDir, 10_000, "main.ts");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("file contents here");
  });

  test("can write files in workspace", async () => {
    await writeFile("main.ts", `
      await Bun.write("output.txt", "written by worker");
      console.log("done");
    `);
    const result = await runCodeInWorker(workspaceDir, 10_000, "main.ts");
    expect(result.exitCode).toBe(0);
    const written = await fs.readFile(path.join(workspaceDir, "output.txt"), "utf-8");
    expect(written).toBe("written by worker");
  });

  test("times out long-running code", async () => {
    await writeFile("main.ts", `await new Promise(r => setTimeout(r, 60_000));`);
    const result = await runCodeInWorker(workspaceDir, 500, "main.ts");
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain("timed out");
  });

  test("formats non-string console args as JSON", async () => {
    await writeFile("main.ts", `console.log({ a: 1 }, [2, 3]);`);
    const result = await runCodeInWorker(workspaceDir, 10_000, "main.ts");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('"a": 1');
    expect(result.stdout).toContain("[");
  });

  test("resolves entrypoint relative to workspace", async () => {
    await fs.mkdir(path.join(workspaceDir, "src"), { recursive: true });
    await writeFile("src/index.ts", `console.log("nested");`);
    const result = await runCodeInWorker(workspaceDir, 10_000, "src/index.ts");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("nested");
  });

  test("reports error for missing entrypoint", async () => {
    const result = await runCodeInWorker(workspaceDir, 10_000, "nonexistent.ts");
    expect(result.exitCode).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
  });
});
