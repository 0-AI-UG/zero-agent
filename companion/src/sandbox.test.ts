import { test, expect, afterEach } from "bun:test";
import { SandboxManager, detectImports, resolvePackages } from "./sandbox.ts";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";

const SANDBOX_ROOT = path.join(os.homedir(), ".companion", "sandboxes");

let manager: SandboxManager;

afterEach(() => {
  manager?.stop();
});

test("createSandbox creates directory and detects python", async () => {
  manager = new SandboxManager();
  const { pythonVersion } = await manager.createSandbox("test-1");

  // Directory should exist
  const stat = await fs.stat(path.join(SANDBOX_ROOT, "test-1", "files"));
  expect(stat.isDirectory()).toBe(true);

  // Python version should be detected (or null if not installed)
  if (pythonVersion) {
    expect(pythonVersion).toMatch(/^\d+\.\d+/);
  }

  await manager.destroySandbox("test-1");
});

test("runScript executes python and captures output", async () => {
  manager = new SandboxManager();
  await manager.createSandbox("test-2");

  const result = await manager.runScript("test-2", 'print("hello world")');
  expect(result.stdout.trim()).toBe("hello world");
  expect(result.exitCode).toBe(0);

  await manager.destroySandbox("test-2");
});

test("runScript reports non-zero exit code on error", async () => {
  manager = new SandboxManager();
  await manager.createSandbox("test-4");

  const result = await manager.runScript("test-4", "raise ValueError('oops')");
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("ValueError");

  await manager.destroySandbox("test-4");
});

test("runScript times out and kills process", async () => {
  manager = new SandboxManager();
  await manager.createSandbox("test-5");

  const result = await manager.runScript(
    "test-5",
    "import time; time.sleep(30)",
    undefined,
    1000, // 1 second timeout
  );
  expect(result.exitCode).toBe(-1);

  await manager.destroySandbox("test-5");
});

test("runScript auto-detects packages from imports", async () => {
  manager = new SandboxManager();
  await manager.createSandbox("test-6");

  // Use a lightweight package (six) to verify auto-detection works end-to-end
  const result = await manager.runScript(
    "test-6",
    "import six\nprint(six.__version__)",
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toMatch(/^\d+\.\d+/);

  await manager.destroySandbox("test-6");
});

test("runScript with explicit packages param", async () => {
  manager = new SandboxManager();
  await manager.createSandbox("test-7");

  // Use explicit packages to install six (not imported by standard name)
  const result = await manager.runScript(
    "test-7",
    "import six\nprint(six.__version__)",
    ["six"],
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toMatch(/^\d+\.\d+/);

  await manager.destroySandbox("test-7");
});

test("destroySandbox removes directory", async () => {
  manager = new SandboxManager();
  await manager.createSandbox("test-8");

  const dir = path.join(SANDBOX_ROOT, "test-8");
  expect((await fs.stat(dir)).isDirectory()).toBe(true);

  await manager.destroySandbox("test-8");

  await expect(fs.stat(dir)).rejects.toThrow();
});

test("runScript on non-existent sandbox throws", async () => {
  manager = new SandboxManager();
  await expect(manager.runScript("nope", "print(1)")).rejects.toThrow("not found");
});

// ── Snapshot-diff tests ──

test("runScript detects new files written by script", async () => {
  manager = new SandboxManager();
  await manager.createSandbox("test-snap-1");

  const result = await manager.runScript(
    "test-snap-1",
    `
with open("output.txt", "w") as f:
    f.write("hello from python")
print("done")
`,
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe("done");
  expect(result.changedFiles).toBeDefined();
  expect(result.changedFiles!.length).toBe(1);
  expect(result.changedFiles![0].path).toBe("output.txt");
  expect(result.changedFiles![0].sizeBytes).toBeGreaterThan(0);

  // Verify base64 content decodes correctly
  const decoded = Buffer.from(result.changedFiles![0].data, "base64").toString("utf-8");
  expect(decoded).toBe("hello from python");

  await manager.destroySandbox("test-snap-1");
});

test("runScript detects files in subdirectories", async () => {
  manager = new SandboxManager();
  await manager.createSandbox("test-snap-2");

  const result = await manager.runScript(
    "test-snap-2",
    `
import os
os.makedirs("reports", exist_ok=True)
with open("reports/chart.csv", "w") as f:
    f.write("x,y\\n1,2\\n3,4")
`,
  );
  expect(result.exitCode).toBe(0);
  expect(result.changedFiles).toBeDefined();
  expect(result.changedFiles!.length).toBe(1);
  expect(result.changedFiles![0].path).toBe("reports/chart.csv");

  await manager.destroySandbox("test-snap-2");
});

test("runScript returns no changedFiles when script writes nothing", async () => {
  manager = new SandboxManager();
  await manager.createSandbox("test-snap-3");

  const result = await manager.runScript(
    "test-snap-3",
    'print("no files written")',
  );
  expect(result.exitCode).toBe(0);
  expect(result.changedFiles).toBeUndefined();
  expect(result.skippedFiles).toBeUndefined();

  await manager.destroySandbox("test-snap-3");
});

// Unit tests for import detection and package resolution

test("detectImports finds import and from-import statements", () => {
  const script = `
import os
import json
import requests
from bs4 import BeautifulSoup
from pathlib import Path
import pandas as pd
from sklearn.model_selection import train_test_split
  `;
  const imports = detectImports(script);
  expect(imports).toContain("os");
  expect(imports).toContain("json");
  expect(imports).toContain("requests");
  expect(imports).toContain("bs4");
  expect(imports).toContain("pathlib");
  expect(imports).toContain("pandas");
  expect(imports).toContain("sklearn");
});

test("resolvePackages skips stdlib and maps aliases", () => {
  const imports = ["os", "json", "requests", "bs4", "sklearn", "pandas", "PIL"];
  const packages = resolvePackages(imports);
  expect(packages).not.toContain("os");
  expect(packages).not.toContain("json");
  expect(packages).toContain("requests");
  expect(packages).toContain("beautifulsoup4");
  expect(packages).toContain("scikit-learn");
  expect(packages).toContain("pandas");
  expect(packages).toContain("pillow");
});

test("resolvePackages merges explicit packages", () => {
  const imports = ["os", "requests"];
  const packages = resolvePackages(imports, ["numpy", "requests"]);
  expect(packages).toContain("numpy");
  expect(packages).toContain("requests");
  expect(packages).not.toContain("os");
});

// ── Output truncation tests ──

test("runScript truncates stdout exceeding 1MB", async () => {
  manager = new SandboxManager();
  await manager.createSandbox("test-truncate");

  // Print ~1.5MB of output
  const result = await manager.runScript(
    "test-truncate",
    "import sys; sys.stdout.write('A' * (1024 * 1024 + 100000))",
    undefined,
    30_000,
  );
  expect(result.stdout).toContain("[output truncated at 1MB]");
  // Should be capped around 1MB + truncation message
  expect(result.stdout.length).toBeLessThan(1_048_576 + 100);

  await manager.destroySandbox("test-truncate");
}, 30_000);
