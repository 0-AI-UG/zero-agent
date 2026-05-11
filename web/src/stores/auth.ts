import { create } from "zustand";

interface User {
  id: string;
  username: string;
}

interface AuthState {
  user: User | null;
  // Bearer token kept ONLY for WebSocket auth and raw fetch flows that can't
  // rely on cookies (file uploads with multipart, etc.). Most API calls go
  // through cookies + CSRF — see api/client.ts.
  token: string | null;
  isAuthenticated: boolean;
  ready: boolean;
  setSession: (user: User, token: string | null) => void;
  clearSession: () => void;
  setReady: () => void;
}

const TOKEN_KEY = "zeroAgentToken";

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  token: typeof localStorage !== "undefined" ? localStorage.getItem(TOKEN_KEY) : null,
  isAuthenticated: false,
  ready: false,

  setSession: (user, token) => {
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
    }
    set({ user, token, isAuthenticated: true, ready: true });
  },
  clearSession: () => {
    localStorage.removeItem(TOKEN_KEY);
    set({ user: null, token: null, isAuthenticated: false, ready: true });
  },
  setReady: () => set({ ready: true }),
}));

export async function logoutApi(): Promise<void> {
  const csrf = readCsrfCookie();
  await fetch("/api/auth/logout", {
    method: "POST",
    credentials: "include",
    headers: csrf ? { "X-CSRF-Token": csrf } : {},
  }).catch(() => {});
  useAuthStore.getState().clearSession();
}

export function readCsrfCookie(): string | null {
  if (typeof document === "undefined") return null;
  const parts = document.cookie.split(";");
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    if (k === "csrf") return part.slice(idx + 1).trim();
  }
  return null;
}
