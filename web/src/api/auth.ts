import { apiFetch } from "./client";

interface AuthSuccess {
  user: { id: string; username: string };
}

interface Auth2FARequired {
  requires2FA: true;
  tempToken: string;
}

interface Auth2FASetupRequired {
  requires2FASetup: true;
  tempToken: string;
}

export type LoginResponse = AuthSuccess | Auth2FARequired | Auth2FASetupRequired;

export async function loginApi(
  username: string,
  password: string,
): Promise<LoginResponse> {
  return apiFetch<LoginResponse>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

export async function passwordResetInit(username: string): Promise<{
  ok: true;
  tempToken?: string;
}> {
  return apiFetch("/auth/password-reset/init", {
    method: "POST",
    body: JSON.stringify({ username }),
  });
}

export async function passwordResetPasskeyOptions(
  tempToken: string,
): Promise<any> {
  return apiFetch("/auth/password-reset/passkey-options", {
    method: "POST",
    body: JSON.stringify({ tempToken }),
  });
}

export async function passwordResetPasskeyConfirm(
  tempToken: string,
  ceremonyId: string,
  response: any,
  newPassword: string,
): Promise<{ success: true }> {
  return apiFetch("/auth/password-reset/passkey-confirm", {
    method: "POST",
    body: JSON.stringify({ tempToken, ceremonyId, response, newPassword }),
  });
}
