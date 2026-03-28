import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { WorkspaceManager, type ExecutionBackend } from "./workspace.ts";
import type { Logger } from "./logger.ts";

const silentLogger: Logger = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  banner: () => {},
};

// Serves files from a local temp dir via file:// URLs (simulates S3 presigned URLs)
let fixtureDir: string;

async function createFixture(name: string, content: string): Promise<string> {
  const filePath = path.join(fixtureDir, name);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
  return `file://${filePath}`;
}

function createBackend(): ExecutionBackend & { commands: Array<{ dir: string; command: string }> } {
  const commands: Array<{ dir: string; command: string }> = [];
  return {
    commands,
    async initWorkspace() {},
    async runCommand(_id, dir, command, _timeout) {
      commands.push({ dir, command });
      return { stdout: "ok", stderr: "", exitCode: 0 };
    },
    async destroyWorkspace() {},
  };
}

let manager: WorkspaceManager;
let backend: ReturnType<typeof createBackend>;

beforeEach(async () => {
  fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-fixture-"));
  backend = createBackend();
  manager = new WorkspaceManager({ logger: silentLogger, backend });
});

afterEach(async () => {
  manager.stop();
  await fs.rm(fixtureDir, { recursive: true, force: true });
});

describe("WorkspaceManager", () => {
  test("createWorkspace downloads manifest files", async () => {
    const url = await createFixture("hello.txt", "hello world");
    await manager.createWorkspace("ws-1", { "hello.txt": url });

    // Run a command to confirm workspace exists
    const result = await manager.runCommand("ws-1", "echo test");
    expect(result.exitCode).toBe(0);
    expect(backend.commands).toHaveLength(1);

    // Verify file was downloaded
    const dir = backend.commands[0].dir;
    const content = await fs.readFile(path.join(dir, "hello.txt"), "utf-8");
    expect(content).toBe("hello world");
  });

  test("createWorkspace handles multiple files", async () => {
    const url1 = await createFixture("a.txt", "aaa");
    const url2 = await createFixture("b.txt", "bbb");
    await manager.createWorkspace("ws-2", { "a.txt": url1, "b.txt": url2 });

    const result = await manager.runCommand("ws-2", "echo test");
    const dir = backend.commands[0].dir;
    expect(await fs.readFile(path.join(dir, "a.txt"), "utf-8")).toBe("aaa");
    expect(await fs.readFile(path.join(dir, "b.txt"), "utf-8")).toBe("bbb");
  });

  test("createWorkspace blocks path traversal", async () => {
    const url = await createFixture("evil.txt", "pwned");
    await manager.createWorkspace("ws-3", { "../../../etc/passwd": url });

    const result = await manager.runCommand("ws-3", "echo test");
    const dir = backend.commands[0].dir;
    // The traversal file should not exist anywhere
    const files = await fs.readdir(dir);
    expect(files).not.toContain("evil.txt");
  });

  test("syncWorkspace updates files", async () => {
    const url1 = await createFixture("data.txt", "version 1");
    await manager.createWorkspace("ws-4", { "data.txt": url1 });

    const url2 = await createFixture("data-v2.txt", "version 2");
    await manager.syncWorkspace("ws-4", { "data.txt": url2 });

    const result = await manager.runCommand("ws-4", "echo test");
    const dir = backend.commands[0].dir;
    const content = await fs.readFile(path.join(dir, "data.txt"), "utf-8");
    expect(content).toBe("version 2");
  });

  test("syncWorkspace throws for unknown workspace", async () => {
    expect(manager.syncWorkspace("nonexistent", {})).rejects.toThrow("not found");
  });

  test("runCommand throws for unknown workspace", async () => {
    expect(manager.runCommand("nonexistent", "echo")).rejects.toThrow("not found");
  });

  test("runCommand detects new files created by backend", async () => {
    // Create a backend that writes a file during execution
    const writingBackend: ExecutionBackend = {
      async initWorkspace() {},
      async runCommand(_id, dir, _command, _timeout) {
        await fs.writeFile(path.join(dir, "output.txt"), "generated");
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      async destroyWorkspace() {},
    };
    const mgr = new WorkspaceManager({ logger: silentLogger, backend: writingBackend });

    try {
      await mgr.createWorkspace("ws-5", {});
      const result = await mgr.runCommand("ws-5", "generate");
      expect(result.changedFiles).toBeDefined();
      expect(result.changedFiles!.length).toBe(1);
      expect(result.changedFiles![0].path).toBe("output.txt");
      // Content should be base64-encoded
      expect(Buffer.from(result.changedFiles![0].data, "base64").toString()).toBe("generated");
    } finally {
      mgr.stop();
    }
  });

  test("runCommand detects deleted files", async () => {
    const url = await createFixture("temp.txt", "will be deleted");
    // Create a backend that deletes a file during execution
    const deletingBackend: ExecutionBackend = {
      async initWorkspace() {},
      async runCommand(_id, dir, _command, _timeout) {
        await fs.unlink(path.join(dir, "temp.txt"));
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      async destroyWorkspace() {},
    };
    const mgr = new WorkspaceManager({ logger: silentLogger, backend: deletingBackend });

    try {
      await mgr.createWorkspace("ws-6", { "temp.txt": url });
      const result = await mgr.runCommand("ws-6", "delete");
      expect(result.deletedFiles).toBeDefined();
      expect(result.deletedFiles).toContain("temp.txt");
    } finally {
      mgr.stop();
    }
  });

  test("destroyWorkspace removes directory", async () => {
    const url = await createFixture("file.txt", "data");
    await manager.createWorkspace("ws-7", { "file.txt": url });

    const result = await manager.runCommand("ws-7", "echo");
    const dir = backend.commands[0].dir;

    await manager.destroyWorkspace("ws-7");
    const exists = await fs.stat(dir).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });

  test("destroyWorkspace is idempotent", async () => {
    await manager.destroyWorkspace("nonexistent");
    // Should not throw
  });

  test("runCommand installs deps when package.json exists", async () => {
    const pkgUrl = await createFixture("pkg.json", JSON.stringify({
      dependencies: { "is-number": "^7.0.0" }
    }));
    await manager.createWorkspace("ws-8", { "package.json": pkgUrl });

    const result = await manager.runCommand("ws-8", "echo");
    const dir = backend.commands[0].dir;
    // node_modules should have been created by bun install
    const nmExists = await fs.stat(path.join(dir, "node_modules")).then(() => true).catch(() => false);
    expect(nmExists).toBe(true);
  });

  test("runCommand reinstalls when package.json changes", async () => {
    const pkgUrl1 = await createFixture("pkg1.json", JSON.stringify({
      dependencies: { "is-number": "^7.0.0" }
    }));
    await manager.createWorkspace("ws-9", { "package.json": pkgUrl1 });
    await manager.runCommand("ws-9", "first run");

    const dir = backend.commands[0].dir;

    // Update package.json to add a new dependency
    const pkgUrl2 = await createFixture("pkg2.json", JSON.stringify({
      dependencies: { "is-number": "^7.0.0", "is-odd": "^3.0.1" }
    }));
    await manager.syncWorkspace("ws-9", { "package.json": pkgUrl2 });
    await manager.runCommand("ws-9", "second run");

    // is-odd should now be installed
    const isOddExists = await fs.stat(path.join(dir, "node_modules", "is-odd")).then(() => true).catch(() => false);
    expect(isOddExists).toBe(true);
  });

  test("runCommand skips install when package.json unchanged", async () => {
    const pkgUrl = await createFixture("pkg.json", JSON.stringify({
      dependencies: { "is-number": "^7.0.0" }
    }));
    await manager.createWorkspace("ws-10", { "package.json": pkgUrl });

    // First run — installs
    await manager.runCommand("ws-10", "first");
    const dir = backend.commands[0].dir;
    const nmStat1 = await fs.stat(path.join(dir, "node_modules"));

    // Small delay so mtime would differ if reinstalled
    await new Promise(r => setTimeout(r, 50));

    // Sync with same content
    await manager.syncWorkspace("ws-10", { "package.json": pkgUrl });
    await manager.runCommand("ws-10", "second");

    // node_modules mtime should be unchanged (no reinstall)
    const nmStat2 = await fs.stat(path.join(dir, "node_modules"));
    expect(nmStat2.mtimeMs).toBe(nmStat1.mtimeMs);
  });

  test("createWorkspace with nested directory structure", async () => {
    const url = await createFixture("nested.txt", "deep file");
    await manager.createWorkspace("ws-11", { "src/lib/nested.txt": url });

    const result = await manager.runCommand("ws-11", "echo");
    const dir = backend.commands[0].dir;
    const content = await fs.readFile(path.join(dir, "src", "lib", "nested.txt"), "utf-8");
    expect(content).toBe("deep file");
  });
});
