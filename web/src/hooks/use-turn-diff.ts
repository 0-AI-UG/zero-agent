/**
 * Hooks for per-turn git snapshot diff rendering.
 *
 * Backs the TurnDiffPanel / TurnDiffFileRow components with react-query,
 * matching the pattern used by use-files.ts and use-file-content.ts.
 *
 * Endpoints (server/routes/turn-snapshots.ts):
 *   GET  /api/turns/:snapshotId/diff           → TurnDiffFileEntry[]
 *   GET  /api/turns/:snapshotId/file?path=...  → raw bytes (octet-stream)
 *   POST /api/turns/:snapshotId/revert         → { paths: string[] }
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/api/client";
import { useAuthStore } from "@/stores/auth";

export interface TurnDiffFileEntry {
  path: string;
  status: "added" | "modified" | "deleted";
  oldSha?: string;
  newSha?: string;
}

const diffKey = (postSnapshotId: string) =>
  ["turn-diff", postSnapshotId] as const;
const fileKey = (postSnapshotId: string, path: string) =>
  ["turn-diff", postSnapshotId, "file", path] as const;

export function useTurnDiff(postSnapshotId: string | null) {
  const query = useQuery({
    queryKey: diffKey(postSnapshotId ?? "__none__"),
    queryFn: () =>
      apiFetch<TurnDiffFileEntry[]>(`/turns/${postSnapshotId}/diff`),
    enabled: !!postSnapshotId,
    staleTime: 5 * 60_000,
  });

  return {
    entries: (query.data ?? null) as TurnDiffFileEntry[] | null,
    isLoading: query.isLoading,
    error: query.error as Error | null,
  };
}

/**
 * Lazy file fetch. The file endpoint returns raw bytes; we attempt a strict
 * UTF-8 decode. If the bytes aren't valid UTF-8 we fall back to a `[binary]`
 * placeholder so the caller can always render a string.
 */
export function useTurnDiffFile(
  postSnapshotId: string | null,
  path: string | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: fileKey(postSnapshotId ?? "__none__", path ?? ""),
    queryFn: async () => {
      const { token } = useAuthStore.getState();
      const res = await fetch(
        `/api/turns/${postSnapshotId}/file?path=${encodeURIComponent(path ?? "")}`,
        {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Request failed: ${res.status}`);
      }
      const buf = await res.arrayBuffer();
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(buf);
      } catch {
        return "[binary]";
      }
    },
    enabled: enabled && !!postSnapshotId && !!path,
    staleTime: 5 * 60_000,
  });
}

export function useRevertTurnPaths(postSnapshotId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (paths: string[]) => {
      if (!postSnapshotId) throw new Error("No snapshot id");
      return apiFetch(`/turns/${postSnapshotId}/revert`, {
        method: "POST",
        body: JSON.stringify({ paths }),
      });
    },
    onSuccess: () => {
      if (!postSnapshotId) return;
      queryClient.invalidateQueries({ queryKey: diffKey(postSnapshotId) });
    },
  });
}
