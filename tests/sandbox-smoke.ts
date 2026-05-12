/**
 * Smoke test for the project-sandbox extension's bash containment.
 *
 * Mirrors what the extension does at runtime:
 *   1. SandboxManager.initialize({ filesystem: {...} }) — no network field
 *   2. Run bash -c "$(SandboxManager.wrapWithSandbox cmd)"
 *
 * Checks that we get:
 *   - Loopback to a local HTTP server still works (the whole reason we
 *     omit `network` — `bwrap --unshare-net` would sever it).
 *   - Writes to a sibling project dir fail (cross-project isolation).
 *   - Writes inside the project dir succeed.
 *   - Reads of a sibling project's files fail.
 *
 * Run with: tsx tests/sandbox-smoke.ts
 *
 * Skips on platforms other than darwin/linux. On Linux you need bubblewrap
 * + socat + ripgrep installed; on macOS sandbox-exec is built in.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";

function log(...args: unknown[]) {
  console.log("[smoke]", ...args);
}

async function execBash(
  command: string,
  cwd: string,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const wrapped = await SandboxManager.wrapWithSandbox(command);
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", wrapped], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b) => (stdout += b.toString()));
    child.stderr.on("data", (b) => (stderr += b.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code, stdout, stderr }));
  });
}

type Check = { name: string; pass: boolean; detail?: string };

async function main() {
  const platform = process.platform;
  if (platform !== "darwin" && platform !== "linux") {
    log(`skipping: sandbox not supported on ${platform}`);
    return;
  }

  // Set up two sibling project dirs under a fake `data/projects` root.
  const root = mkdtempSync(path.join(tmpdir(), "sandbox-smoke-"));
  const projectsRoot = path.join(root, "projects");
  const projectA = path.join(projectsRoot, "A");
  const projectB = path.join(projectsRoot, "B");
  mkdirSync(projectA, { recursive: true });
  mkdirSync(projectB, { recursive: true });
  writeFileSync(path.join(projectB, "secret.txt"), "PROJECT_B_SECRET\n");

  // Spin up an HTTP server on 127.0.0.1 (stands in for ZERO_PROXY_URL).
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("LOOPBACK_OK");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  log(`loopback server at http://127.0.0.1:${port}`);

  type InitArgs = Parameters<typeof SandboxManager.initialize>[0];
  await SandboxManager.initialize({
    network: {} as InitArgs["network"],
    filesystem: {
      denyRead: ["~/.ssh", "~/.aws", "~/.gnupg", projectsRoot],
      allowRead: [projectA],
      allowWrite: [projectA, "/tmp"],
      denyWrite: [".env", ".env.*", "*.pem", "*.key"],
    },
  });
  log("sandbox initialized (filesystem-only)");

  const checks: Check[] = [];

  // 1) Project-local write — must succeed.
  {
    const target = path.join(projectA, "hello.txt");
    const r = await execBash(`echo hi > ${JSON.stringify(target)}`, projectA);
    const wrote = existsSync(target) && readFileSync(target, "utf8") === "hi\n";
    checks.push({
      name: "project-local write succeeds",
      pass: r.exitCode === 0 && wrote,
      detail: `exit=${r.exitCode} wrote=${wrote} stderr=${r.stderr.trim()}`,
    });
  }

  // 2) Cross-project write — must fail.
  {
    const target = path.join(projectB, "pwned.txt");
    const r = await execBash(`echo pwn > ${JSON.stringify(target)}`, projectA);
    const present = existsSync(target);
    checks.push({
      name: "cross-project write blocked",
      pass: r.exitCode !== 0 && !present,
      detail: `exit=${r.exitCode} fileCreated=${present} stderr=${r.stderr.trim().slice(0, 200)}`,
    });
  }

  // 3) Cross-project read — must fail.
  {
    const target = path.join(projectB, "secret.txt");
    const r = await execBash(`cat ${JSON.stringify(target)}`, projectA);
    const leaked = r.stdout.includes("PROJECT_B_SECRET");
    checks.push({
      name: "cross-project read blocked",
      pass: r.exitCode !== 0 && !leaked,
      detail: `exit=${r.exitCode} leaked=${leaked} stderr=${r.stderr.trim().slice(0, 200)}`,
    });
  }

  // 4) Loopback fetch — must succeed (the whole point of skipping netns).
  {
    const r = await execBash(
      `curl -s --max-time 3 http://127.0.0.1:${port}/`,
      projectA,
    );
    const ok = r.stdout.trim() === "LOOPBACK_OK";
    checks.push({
      name: "loopback fetch reaches host 127.0.0.1",
      pass: r.exitCode === 0 && ok,
      detail: `exit=${r.exitCode} body=${r.stdout.trim().slice(0, 80)} stderr=${r.stderr.trim().slice(0, 200)}`,
    });
  }

  // 5) Container-global write (/usr/local/bin) — must fail.
  {
    const r = await execBash(
      `echo x > /usr/local/bin/__sandbox_smoke_should_fail__`,
      projectA,
    );
    const present = existsSync("/usr/local/bin/__sandbox_smoke_should_fail__");
    if (present) {
      try {
        rmSync("/usr/local/bin/__sandbox_smoke_should_fail__");
      } catch {}
    }
    checks.push({
      name: "container-global write blocked",
      pass: r.exitCode !== 0 && !present,
      detail: `exit=${r.exitCode} fileCreated=${present}`,
    });
  }

  await SandboxManager.reset();
  server.close();
  rmSync(root, { recursive: true, force: true });

  let failed = 0;
  for (const c of checks) {
    const tag = c.pass ? "PASS" : "FAIL";
    if (!c.pass) failed++;
    log(`${tag}  ${c.name}  —  ${c.detail ?? ""}`);
  }
  if (failed > 0) {
    log(`${failed}/${checks.length} checks failed`);
    process.exit(1);
  }
  log(`all ${checks.length} checks passed`);
}

main().catch((err) => {
  console.error("[smoke] crashed:", err);
  process.exit(1);
});
