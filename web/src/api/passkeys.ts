import { apiFetch } from "./client";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/browser";

// ── Authenticated endpoints ──

export async function passkeyRegisterOptions(): Promise<
  PublicKeyCredentialCreationOptionsJSON & { ceremonyId: string }
> {
  return apiFetch("/auth/passkey/register-options", { method: "POST" });
}

export async function passkeyRegisterVerify(
  ceremonyId: string,
  response: RegistrationResponseJSON,
  deviceName?: string,
): Promise<{ success: true }> {
  return apiFetch("/auth/passkey/register-verify", {
    method: "POST",
    body: JSON.stringify({ ceremonyId, response, deviceName }),
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
): Promise<PublicKeyCredentialRequestOptionsJSON & { ceremonyId: string }> {
  return apiFetch("/auth/passkey/login-options", {
    method: "POST",
    body: JSON.stringify({ tempToken }),
  });
}

export async function passkeyLoginVerify(
  tempToken: string,
  ceremonyId: string,
  response: AuthenticationResponseJSON,
): Promise<{ user: { id: string; username: string } }> {
  return apiFetch("/auth/passkey/login-verify", {
    method: "POST",
    body: JSON.stringify({ tempToken, ceremonyId, response }),
  });
}

// ── Passkey enrollment during login (when account requires 2FA but has none) ──

export async function passkeyEnrollOptions(
  tempToken: string,
): Promise<PublicKeyCredentialCreationOptionsJSON & { ceremonyId: string }> {
  return apiFetch("/auth/passkey/enroll-options", {
    method: "POST",
    body: JSON.stringify({ tempToken }),
  });
}

export async function passkeyEnrollVerify(
  tempToken: string,
  ceremonyId: string,
  response: RegistrationResponseJSON,
  deviceName?: string,
): Promise<{ user: { id: string; username: string } }> {
  return apiFetch("/auth/passkey/enroll-verify", {
    method: "POST",
    body: JSON.stringify({ tempToken, ceremonyId, response, deviceName }),
  });
}
