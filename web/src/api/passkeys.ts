import { apiFetch } from "./client";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/browser";

const API_BASE = "/api";

// ── Authenticated endpoints ──

export async function passkeyRegisterOptions(): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return apiFetch("/auth/passkey/register-options", { method: "POST" });
}

export async function passkeyRegisterVerify(
  response: RegistrationResponseJSON,
  deviceName?: string,
): Promise<{ success: true }> {
  return apiFetch("/auth/passkey/register-verify", {
    method: "POST",
    body: JSON.stringify({ response, deviceName }),
  });
}

export async function passkeyList(): Promise<{
  passkeys: { id: string; deviceName: string; createdAt: string }[];
}> {
  return apiFetch("/auth/passkey/list");
}

export async function passkeyDelete(id: string): Promise<{ deleted: true }> {
  return apiFetch(`/auth/passkey/${id}`, { method: "DELETE" });
}

// ── Unauthenticated endpoints (during login) ──

export async function passkeyLoginOptions(
  tempToken: string,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const res = await fetch(`${API_BASE}/auth/passkey/login-options`, {
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

export async function passkeyLoginVerify(
  tempToken: string,
  response: AuthenticationResponseJSON,
): Promise<{ token: string; user: { id: string; username: string } }> {
  const res = await fetch(`${API_BASE}/auth/passkey/login-verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tempToken, response }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  return res.json();
}
