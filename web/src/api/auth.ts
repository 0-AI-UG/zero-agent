import { apiFetch } from "./client";

interface AuthSuccess {
  token: string;
  user: { id: string; username: string };
}

interface Auth2FARequired {
  requires2FA: true;
  tempToken: string;
  methods?: {
    totp: boolean;
    passkey: boolean;
  };
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
  tempToken: string;
  methods: { totp: boolean; passkey: boolean };
}> {
  return apiFetch("/auth/password-reset/init", {
    method: "POST",
    body: JSON.stringify({ username }),
  });
}

export async function passwordResetConfirm(
  tempToken: string,
  code: string,
  newPassword: string,
): Promise<{ success: true }> {
  return apiFetch("/auth/password-reset/confirm", {
    method: "POST",
    body: JSON.stringify({ tempToken, code, newPassword }),
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
  response: any,
  newPassword: string,
): Promise<{ success: true }> {
  return apiFetch("/auth/password-reset/passkey-confirm", {
    method: "POST",
    body: JSON.stringify({ tempToken, response, newPassword }),
  });
}

export async function registerApi(
  username: string,
  password: string,
  inviteToken: string,
): Promise<AuthSuccess> {
  return apiFetch<AuthSuccess>("/auth/register", {
    method: "POST",
    body: JSON.stringify({ username, password, inviteToken }),
  });
}
