import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";
import type { FileItem } from "@/hooks/use-files";

export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const UPLOAD_CONCURRENCY = 3;

export interface UploadEntry {
  file: File;
  // Path relative to the target folder, e.g. "sub/dir/name.txt" or just "name.txt".
  relativePath: string;
}

function sanitizeFolderName(name: string): string {
  return name.trim().replace(/[^a-zA-Z0-9._\- ]/g, "");
}

function joinPath(base: string, segment: string): string {
  const b = base.endsWith("/") ? base : `${base}/`;
  return `${b}${segment}/`;
}

async function ensureFolder(
  projectId: string,
  path: string,
  name: string,
  cache: Set<string>,
): Promise<void> {
  if (cache.has(path)) return;
  try {
    await apiFetch(`/projects/${projectId}/folders`, {
      method: "POST",
      body: JSON.stringify({ path, name }),
    });
  } catch (err) {
    // Folder may already exist; the server returns 400 "Folder already exists".
    const msg = (err as Error)?.message ?? "";
    if (!/already exists/i.test(msg)) {
      // Unknown error — rethrow so caller can report.
      throw err;
    }
  }
  cache.add(path);
}

async function ensureFolderChain(
  projectId: string,
  basePath: string,
  segments: string[],
  cache: Set<string>,
): Promise<string> {
  let current = basePath;
  for (const rawSeg of segments) {
    const seg = sanitizeFolderName(rawSeg);
    if (!seg) continue;
    current = joinPath(current, seg);
    await ensureFolder(projectId, current, seg, cache);
  }
  return current;
}

async function uploadOne(
  projectId: string,
  file: File,
  folderPath: string,
): Promise<FileItem> {
  const res = await apiFetch<{ url: string; s3Key: string; file: FileItem }>(
    `/projects/${projectId}/files/upload`,
    {
      method: "POST",
      body: JSON.stringify({
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        folderPath,
        sizeBytes: file.size,
      }),
    },
  );

  const uploadRes = await fetch(res.url, {
    method: "PUT",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });

  if (!uploadRes.ok) {
    await apiFetch(`/projects/${projectId}/files/${res.file.id}`, {
      method: "DELETE",
    }).catch(() => {});
    throw new Error("S3 upload failed");
  }

  return res.file;
}

export function useUploadFiles(projectId: string) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState(0);
  const activeRef = useRef(0);

  const upload = useCallback(
    async (entries: UploadEntry[], basePath: string) => {
      if (entries.length === 0) return;

      const tooLarge = entries.filter((e) => e.file.size > MAX_FILE_SIZE);
      const valid = entries.filter((e) => e.file.size <= MAX_FILE_SIZE);

      if (tooLarge.length > 0) {
        toast.error(
          tooLarge.length === 1
            ? `"${tooLarge[0]!.file.name}" exceeds 50 MB and was skipped.`
            : `${tooLarge.length} files exceed 50 MB and were skipped.`,
        );
      }
      if (valid.length === 0) return;

      activeRef.current += valid.length;
      setPending(activeRef.current);

      const folderCache = new Set<string>();
      let succeeded = 0;
      let failed = 0;

      const runOne = async (entry: UploadEntry) => {
        try {
          const parts = entry.relativePath.split("/").filter(Boolean);
          const segments = parts.slice(0, -1);
          const targetPath = await ensureFolderChain(
            projectId,
            basePath,
            segments,
            folderCache,
          );
          await uploadOne(projectId, entry.file, targetPath);
          succeeded++;
        } catch {
          failed++;
        } finally {
          activeRef.current -= 1;
          setPending(activeRef.current);
        }
      };

      // Simple concurrency-limited queue.
      const queue = [...valid];
      const workers: Promise<void>[] = [];
      const worker = async () => {
        while (queue.length > 0) {
          const next = queue.shift();
          if (!next) break;
          await runOne(next);
        }
      };
      for (let i = 0; i < Math.min(UPLOAD_CONCURRENCY, valid.length); i++) {
        workers.push(worker());
      }
      await Promise.all(workers);

      queryClient.invalidateQueries({
        queryKey: queryKeys.files.byProject(projectId),
      });

      if (failed === 0) {
        toast.success(
          succeeded === 1
            ? "File uploaded."
            : `Uploaded ${succeeded} files.`,
        );
      } else if (succeeded === 0) {
        toast.error("Upload failed.");
      } else {
        toast.error(`Uploaded ${succeeded}, failed ${failed}.`);
      }
    },
    [projectId, queryClient],
  );

  return { upload, isUploading: pending > 0, pending };
}

// --- Helpers for extracting UploadEntry[] from pickers and drops ---

export function entriesFromFileList(files: FileList | File[]): UploadEntry[] {
  const arr: UploadEntry[] = [];
  const list = Array.from(files as ArrayLike<File>);
  for (const f of list) {
    // <input webkitdirectory> sets webkitRelativePath; plain <input multiple> does not.
    const rel =
      (f as File & { webkitRelativePath?: string }).webkitRelativePath ||
      f.name;
    arr.push({ file: f, relativePath: rel });
  }
  return arr;
}

interface FileSystemEntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (cb: (f: File) => void, err?: (e: unknown) => void) => void;
  createReader?: () => {
    readEntries: (
      cb: (entries: FileSystemEntryLike[]) => void,
      err?: (e: unknown) => void,
    ) => void;
  };
}

async function readAllEntries(
  reader: NonNullable<ReturnType<NonNullable<FileSystemEntryLike["createReader"]>>>,
): Promise<FileSystemEntryLike[]> {
  const out: FileSystemEntryLike[] = [];
  while (true) {
    const batch = await new Promise<FileSystemEntryLike[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (batch.length === 0) break;
    out.push(...batch);
  }
  return out;
}

async function walkEntry(
  entry: FileSystemEntryLike,
  prefix: string,
  out: UploadEntry[],
): Promise<void> {
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((resolve, reject) => {
      entry.file!(resolve, reject);
    });
    out.push({ file, relativePath: prefix ? `${prefix}/${entry.name}` : entry.name });
    return;
  }
  if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader();
    const children = await readAllEntries(reader);
    const nextPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
    for (const child of children) {
      await walkEntry(child, nextPrefix, out);
    }
  }
}

export async function entriesFromDataTransfer(
  dt: DataTransfer,
): Promise<UploadEntry[]> {
  const items = dt.items;
  const out: UploadEntry[] = [];

  // Prefer the entries API (supports folders).
  if (items && items.length > 0 && typeof (items[0] as DataTransferItem & { webkitGetAsEntry?: unknown }).webkitGetAsEntry === "function") {
    const entries: FileSystemEntryLike[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      if (it.kind !== "file") continue;
      const entry = (it as DataTransferItem & {
        webkitGetAsEntry: () => FileSystemEntryLike | null;
      }).webkitGetAsEntry();
      if (entry) entries.push(entry);
    }
    for (const e of entries) {
      await walkEntry(e, "", out);
    }
    if (out.length > 0) return out;
  }

  // Fallback to flat FileList.
  if (dt.files && dt.files.length > 0) {
    return entriesFromFileList(dt.files);
  }
  return out;
}
