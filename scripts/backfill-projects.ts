/**
 * One-time backfill from the legacy runner-container project layout to
 * Pi's host-filesystem layout.
 *
 * Pre-Pi: each project's files lived inside its own session container's
 * writable layer (mirrored into `data/workspaces/<projectId>/` on the host).
 * Post-Pi: project files live at `/var/zero/projects/<projectId>/` and Pi
 * writes per-chat session JSONLs into `<projectDir>/.pi-sessions/<chatId>.jsonl`.
 *
 * Behavior:
 *   - For every row in the `projects` table, ensure the target dir exists.
 *   - If `data/workspaces/<projectId>/` exists in the legacy mirror,
 *     copy its contents into the new dir (skipping anything already there).
 *   - Initialize the `.pi-sessions/` and `.git-snapshots/` subpaths so the
 *     watcher / snapshot service skip them.
 *
 * The legacy mirror dir is not deleted — operators can verify the migration
 * and remove it themselves. Re-running the script is idempotent.
 *
 * Usage: npx tsx scripts/backfill-projects.ts [--dry-run] [--src=<path>]
 *
 * `messages` table is dropped at boot by `server/db/index.ts`; there is no
 * conversation history to migrate. New chats start fresh under Pi.
 */
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { db } from "../server/db/index.ts";
import { projectDirFor } from "../server/lib/pi/run-turn.ts";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const srcArg = [...args].find((a) => a.startsWith("--src="));
const SRC_ROOT = srcArg
  ? srcArg.slice("--src=".length)
  : path.resolve("data/workspaces");

interface ProjectRow {
  id: string;
  name: string;
}

async function copyTreeIfMissing(src: string, dst: string): Promise<number> {
  if (!existsSync(src)) return 0;
  let copied = 0;
  const entries = await fs.readdir(src, { withFileTypes: true });
  await fs.mkdir(dst, { recursive: true });
  for (const entry of entries) {
    if (entry.name === ".pi-sessions" || entry.name === ".git-snapshots") continue;
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (existsSync(to)) continue;
    if (dryRun) {
      console.log(`  would copy ${from} → ${to}`);
      copied++;
      continue;
    }
    if (entry.isDirectory()) {
      await fs.cp(from, to, { recursive: true });
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      await fs.copyFile(from, to);
    }
    copied++;
  }
  return copied;
}

async function main() {
  const rows = db.prepare("SELECT id, name FROM projects").all() as ProjectRow[];
  console.log(
    `[backfill] ${rows.length} project(s); src=${SRC_ROOT}; ${dryRun ? "DRY RUN" : "LIVE"}`,
  );

  for (const project of rows) {
    const dst = projectDirFor(project.id);
    const legacy = path.join(SRC_ROOT, project.id);
    if (!dryRun) await fs.mkdir(dst, { recursive: true });

    const moved = await copyTreeIfMissing(legacy, dst);
    console.log(
      `[backfill] ${project.id} (${project.name}) — ${moved} entr${moved === 1 ? "y" : "ies"} from legacy mirror`,
    );

    if (!dryRun) {
      await fs.mkdir(path.join(dst, ".pi-sessions"), { recursive: true });
    }
  }

  console.log("[backfill] done");
}

main().catch((err) => {
  console.error("[backfill] failed", err);
  process.exit(1);
});
