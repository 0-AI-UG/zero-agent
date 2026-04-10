import { apiFetch } from "./client";

const API_BASE = "/api";

export async function totpSetup(): Promise<{ secret: string; uri: string; qrCode: string }> {
  return apiFetch("/auth/totp/setup", { method: "POST" });
}

export async function totpConfirm(code: string): Promise<{ enabled: true; backupCodes: string[] }> {
  return apiFetch("/auth/totp/confirm", {
    method: "POST",
    body: JSON.stringify({ code }),
  });
}

export async function totpLogin(
  tempToken: string,
  code: string,
): Promise<{ token: string; user: { id: string; username: string } }> {
  // No auth header — user isn't authenticated yet
  const res = await fetch(`${API_BASE}/auth/totp/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tempToken, code }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json();
}

export async function totpRecover(
  tempToken: string,
  code: string,
): Promise<{ tempToken: string }> {
  const res = await fetch(`${API_BASE}/auth/totp/recover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tempToken, code }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json();
}

export async function totpDisable(code: string): Promise<{ disabled: true }> {
  return apiFetch("/auth/totp/disable", {
    method: "POST",
    body: JSON.stringify({ code }),
  });
}

export async function totpStatus(): Promise<{ enabled: boolean; required: boolean; backupCodesRemaining: number }> {
  return apiFetch("/auth/totp/status");
}

export async function totpSetupFromLogin(
  tempToken: string,
): Promise<{ secret: string; uri: string; qrCode: string }> {
  const res = await fetch(`${API_BASE}/auth/totp/setup-from-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tempToken }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json();
}

export async function totpConfirmFromLogin(
  tempToken: string,
  code: string,
): Promise<{ token: string; user: { id: string; username: string }; backupCodes: string[] }> {
  const res = await fetch(`${API_BASE}/auth/totp/confirm-from-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tempToken, code }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json();
}
