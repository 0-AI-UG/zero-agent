#!/usr/bin/env node
/**
 * Dev runner: spawns the Node server + the web watch build in parallel.
 * Both processes inherit stdio. Ctrl-C kills both.
 */
import { spawn } from "node:child_process";

const procs = [
  spawn("bun", ["build.ts", "--watch"], {
    cwd: "web",
    stdio: "inherit",
  }),
  spawn("node", ["--import", "tsx/esm", "--env-file=.env", "server/index.ts"], {
    stdio: "inherit",
    env: { ...process.env },
  }),
];

let shuttingDown = false;
const shutdown = async (code = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const p of procs) if (!p.killed) p.kill("SIGTERM");
  const killTimer = setTimeout(() => {
    for (const p of procs) if (!p.killed) p.kill("SIGKILL");
  }, 5000);
  await Promise.all(
    procs.map((p) => (p.exitCode !== null ? Promise.resolve() : new Promise((r) => p.once("exit", r)))),
  );
  clearTimeout(killTimer);
  process.exit(code);
};

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

for (const p of procs) {
  p.on("exit", (code) => {
    if (code !== 0 && code !== null) shutdown(code);
  });
}
