import { useAuthStore } from "@/stores/auth";

const API_BASE = "/api";

function isTokenExpired(token: string): boolean {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return false; // Non-JWT token (e.g. desktop mode)
    const payload = JSON.parse(atob(parts[1]!));
    // Expire 30s early to avoid race conditions
    return typeof payload.exp === "number" && payload.exp * 1000 < Date.now() + 30_000;
  } catch {
    return false;
  }
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const { token, logout } = useAuthStore.getState();

  if (token && isTokenExpired(token)) {
    logout();
    window.location.href = "/login";
    throw new Error("Session expired");
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));

    if (res.status === 401 && token) {
      logout();
      window.location.href = "/login";
    }

    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }

  return res.json();
}
