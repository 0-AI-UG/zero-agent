import { useAuthStore, readCsrfCookie } from "@/stores/auth";

const API_BASE = "/api";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string>) ?? {}),
  };

  if (MUTATING.has(method)) {
    const csrf = readCsrfCookie();
    if (csrf) headers["X-CSRF-Token"] = csrf;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: "include",
    headers,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));

    if (res.status === 401) {
      useAuthStore.getState().clearSession();
      if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
        window.location.href = "/login";
      }
    }

    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }

  return res.json();
}
