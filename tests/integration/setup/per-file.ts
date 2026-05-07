// Runs once per test file, BEFORE any test-file imports execute. We use it to
// point the DB and S3-lite singletons at the temp paths that globalSetup
// created — both modules open their backing files at import time, so the env
// has to exist before the first `import "@/db/index.ts"` chain.
//
// globalSetup writes ZERO_INT_DB_PATH / ZERO_INT_S3_DB_PATH / ZERO_INT_S3_BUCKET
// into a sidecar JSON because vitest's `provide()` values aren't available at
// setupFiles time (they're injected via the inject() API inside tests).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const sidecar = join(tmpdir(), "zero-int-current.json");

let cfg: { dbPath: string; s3DbPath: string; s3Bucket: string } | null = null;
try {
  cfg = JSON.parse(readFileSync(sidecar, "utf8"));
} catch {
  // First run before globalSetup — vitest still loads setupFiles for collection.
  // We'll get a real one on the next pass.
}

if (cfg) {
  process.env.DB_PATH = cfg.dbPath;
  process.env.S3_DB_PATH = cfg.s3DbPath;
  process.env.S3_BUCKET = cfg.s3Bucket;
}
