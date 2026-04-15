import { useEffect, useState } from "react";
import { useAuthStore } from "@/stores/auth";

/**
 * Fetch a `/api/blobs/:hash` URL with the session Bearer token and return a
 * local blob: URL suitable for `<img src>`. Revokes on unmount + hash change.
 * Hash is content-addressed, so the returned object-URL is safe to cache —
 * no memoization key needed beyond `hash` itself.
 */
export function useBlobUrl(hash: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!hash) {
      setUrl(null);
      return;
    }
    let revoked = false;
    let objectUrl: string | null = null;
    const token = useAuthStore.getState().token;
    fetch(`/api/blobs/${hash}`, {
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
  }, [hash]);
  return url;
}
