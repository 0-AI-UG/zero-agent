import { useEffect, useState } from "react";
import { useAuthStore } from "@/stores/auth";

/**
 * Fetch `/api/projects/:projectId/blobs/:hash` with the session Bearer token
 * and return a local blob: URL suitable for `<img src>`. Revokes on unmount
 * or on hash/projectId change. Hash is content-addressed, so the returned
 * object-URL is safe to cache — keyed off (projectId, hash) since the server
 * enforces project-scoped access.
 */
export function useBlobUrl(
  hash: string | null | undefined,
  projectId: string | null | undefined,
): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!hash || !projectId) {
      setUrl(null);
      return;
    }
    let revoked = false;
    let objectUrl: string | null = null;
    const token = useAuthStore.getState().token;
    fetch(`/api/projects/${projectId}/blobs/${hash}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    })
      .then((r) => (r.ok ? r.blob() : null))
      .then((blob) => {
        if (revoked || !blob) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {});
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setUrl(null);
    };
  }, [hash, projectId]);
  return url;
}
