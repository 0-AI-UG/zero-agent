import { apiFetch } from "./client";

interface AuthSuccess {
  token: string;
  user: { id: string; email: string };
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
  email: string,
  password: string,
): Promise<LoginResponse> {
  return apiFetch<LoginResponse>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export async function registerApi(
  email: string,
  password: string,
  inviteToken: string,
): Promise<AuthSuccess> {
  return apiFetch<AuthSuccess>("/auth/register", {
    method: "POST",
    body: JSON.stringify({ email, password, inviteToken }),
  });
}
