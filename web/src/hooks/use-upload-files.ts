import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiFetch } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";
import type { FileItem } from "@/hooks/use-files";

export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const UPLOAD_CONCURRENCY = 3;

function sanitizeFolderName(name: string): string {
  return name.trim().replace(/[^a-zA-Z0-9._\- ]/g, "");
}

function joinPath(base: string, segment: string): string {
  const b = base.endsWith("/") ? base : `${base}/`;
  return `${b}${segment}/`;
}

// Get a relative path for a File:
// - react-dropzone / file-selector sets `.path` on files from a dropped folder, e.g. "/dir/sub/a.txt"
// - The HTML5 <input webkitdirectory> sets `.webkitRelativePath`, e.g. "dir/sub/a.txt"
// - Plain <input multiple> or a flat drop has neither — use the file name.
function relativePathOf(file: File): string {
  const dz = (file as File & { path?: string }).path;
  if (dz) return dz.replace(/^\/+/, "");
  const wk = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  if (wk) return wk;
  return file.name;
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
    const msg = (err as Error)?.message ?? "";
    if (!/already exists/i.test(msg)) {
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
    async (files: File[], basePath: string) => {
      if (files.length === 0) return;

      const tooLarge = files.filter((f) => f.size > MAX_FILE_SIZE);
      const valid = files.filter((f) => f.size <= MAX_FILE_SIZE);

      if (tooLarge.length > 0) {
        toast.error(
          tooLarge.length === 1
            ? `"${tooLarge[0]!.name}" exceeds 50 MB and was skipped.`
            : `${tooLarge.length} files exceed 50 MB and were skipped.`,
        );
      }
      if (valid.length === 0) return;

      activeRef.current += valid.length;
      setPending(activeRef.current);

      const folderCache = new Set<string>();
      let succeeded = 0;
      let failed = 0;

      const runOne = async (file: File) => {
        try {
          const rel = relativePathOf(file);
          const parts = rel.split("/").filter(Boolean);
          const segments = parts.slice(0, -1);
          const targetPath = await ensureFolderChain(
            projectId,
            basePath,
            segments,
            folderCache,
          );
          await uploadOne(projectId, file, targetPath);
          succeeded++;
        } catch {
          failed++;
        } finally {
          activeRef.current -= 1;
          setPending(activeRef.current);
        }
      };

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
          succeeded === 1 ? "File uploaded." : `Uploaded ${succeeded} files.`,
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
