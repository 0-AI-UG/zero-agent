/**
 * Regression guard: mirror-receiver must emit `file.updated` / `file.deleted`
 * after persisting DB state. Without these events the WS bridge never
 * broadcasts `file.changed`, and the file explorer query is never invalidated
 * — the symptom was "agent-written files don't appear in the UI".
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/db/queries/files.ts", () => ({
  insertFile: vi.fn(() => ({ id: "file-1" })),
  deleteFile: vi.fn(() => undefined),
  getFileByPath: vi.fn(() => ({ id: "file-1", project_id: "proj-1" })),
}));

vi.mock("@/db/queries/projects.ts", () => ({
  getProjectById: vi.fn(() => ({ id: "proj-1" })),
}));

vi.mock("@/db/queries/search.ts", () => ({
  indexFileContent: vi.fn(() => undefined),
  removeFileIndex: vi.fn(() => undefined),
}));

vi.mock("@/lib/search/vectors.ts", () => ({
  embedAndStore: vi.fn(async () => undefined),
  deleteVectorsBySource: vi.fn(() => undefined),
}));

vi.mock("./manifest-cache.ts", () => ({
  invalidateManifestCache: vi.fn(() => undefined),
  sha256Hex: vi.fn(() => "deadbeef"),
}));

vi.mock("./lifecycle.ts", () => ({
  getLocalBackend: () => ({
    readFiles: vi.fn(async (_name: string, paths: string[]) =>
      paths.map((p) => ({
        path: p,
        data: Buffer.from("hello").toString("base64"),
        sizeBytes: 5,
      })),
    ),
  }),
}));

import { events } from "@/lib/scheduling/events.ts";
import {
  processEvent,
  markDirty,
  isDirty,
  clearDirty,
  clearDirtyIfUnchangedSince,
  getDirtyMeta,
} from "./mirror-receiver.ts";

describe("mirror-receiver event emission", () => {
  const unsubs: Array<() => void> = [];

  beforeEach(() => {
    while (unsubs.length > 0) unsubs.pop()!();
  });

  test("upsert emits file.updated with derived folder + filename", async () => {
    const seen: unknown[] = [];
    unsubs.push(events.on("file.updated", (p) => { seen.push(p); }));

    await processEvent("proj-1", "cont-1", {
      kind: "upsert",
      path: "src/foo.ts",
      size: 5,
      mtime: 0,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      projectId: "proj-1",
      path: "/src/",
      filename: "foo.ts",
    });
  });

  test("upsert at workspace root emits folderPath '/'", async () => {
    const seen: unknown[] = [];
    unsubs.push(events.on("file.updated", (p) => { seen.push(p); }));

    await processEvent("proj-1", "cont-1", {
      kind: "upsert",
      path: "README.md",
      size: 5,
      mtime: 0,
    });

    expect(seen[0]).toMatchObject({
      projectId: "proj-1",
      path: "/",
      filename: "README.md",
    });
  });

  test("clearDirtyIfUnchangedSince clears when no write arrived during flush", () => {
    const pid = "proj-flush-clean";
    clearDirty(pid);
    markDirty(pid);
    expect(isDirty(pid)).toBe(true);

    // Simulate flush that starts strictly after the write.
    const flushStart = Date.now() + 1_000;
    clearDirtyIfUnchangedSince(pid, flushStart);

    expect(isDirty(pid)).toBe(false);
    expect(getDirtyMeta(pid)).toBeNull();
  });

  test("concurrent markDirty bursts never lose the last-write timestamp", async () => {
    const pid = "proj-parallel-markdirty";
    clearDirty(pid);

    // 200 concurrent marks interleaved with microtask yields — stresses the
    // state machine under parallel pressure.
    await Promise.all(
      Array.from({ length: 200 }, async (_v, i) => {
        if (i % 3 === 0) await Promise.resolve();
        markDirty(pid);
      }),
    );

    expect(isDirty(pid)).toBe(true);
    const meta = getDirtyMeta(pid);
    expect(meta).not.toBeNull();

    // A flush that claims to have started before any of the bursts must NOT
    // clear dirty — last-write must postdate it.
    clearDirtyIfUnchangedSince(pid, meta!.firstDirtyAt - 1);
    expect(isDirty(pid)).toBe(true);

    // A flush that claims to have started far in the future DOES clear.
    clearDirtyIfUnchangedSince(pid, Date.now() + 10_000);
    expect(isDirty(pid)).toBe(false);
  });

  test("parallel processEvent calls for different projects don't cross-contaminate dirty state", async () => {
    const pidA = "proj-parallel-A";
    const pidB = "proj-parallel-B";
    clearDirty(pidA);
    clearDirty(pidB);

    await Promise.all([
      processEvent(pidA, "cont-A", { kind: "upsert", path: "a.txt", size: 5, mtime: 0 }),
      processEvent(pidB, "cont-B", { kind: "upsert", path: "b.txt", size: 5, mtime: 0 }),
      processEvent(pidA, "cont-A", { kind: "upsert", path: "a2.txt", size: 5, mtime: 0 }),
      processEvent(pidB, "cont-B", { kind: "delete", path: "b.txt" }),
    ]);

    expect(isDirty(pidA)).toBe(true);
    expect(isDirty(pidB)).toBe(true);

    // Clearing A must not touch B.
    clearDirty(pidA);
    expect(isDirty(pidA)).toBe(false);
    expect(isDirty(pidB)).toBe(true);

    clearDirty(pidB);
  });

  test("clearDirtyIfUnchangedSince preserves dirty when write arrives mid-flush", async () => {
    const pid = "proj-flush-race";
    clearDirty(pid);

    // Pretend the flush started "in the past" relative to the write we're about to make.
    const flushStart = Date.now() - 10;
    // Let wall clock advance so the next markDirty's `now` is > flushStart.
    await new Promise((r) => setTimeout(r, 5));
    markDirty(pid);

    clearDirtyIfUnchangedSince(pid, flushStart);

    expect(isDirty(pid)).toBe(true);
    expect(getDirtyMeta(pid)).not.toBeNull();

    clearDirty(pid); // cleanup
  });

  test("delete emits file.deleted with derived folder + filename", async () => {
    const seen: unknown[] = [];
    unsubs.push(events.on("file.deleted", (p) => { seen.push(p); }));

    await processEvent("proj-1", "cont-1", {
      kind: "delete",
      path: "src/old.ts",
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      projectId: "proj-1",
      path: "/src/",
      filename: "old.ts",
    });
  });
});
