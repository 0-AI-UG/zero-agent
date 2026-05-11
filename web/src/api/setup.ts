const API_BASE = "/api";

export interface SetupStatus {
  setupComplete: boolean;
}

export async function getSetupStatus(): Promise<SetupStatus> {
  const res = await fetch(`${API_BASE}/setup/status`);
  return res.json();
}

export interface SetupCompleteRequest {
  username: string;
  password: string;
  openrouterApiKey: string;
  openrouterModel?: string;
  braveSearchApiKey?: string;
}

export type SetupCompleteResponse =
  | { tempToken: string; requires2FASetup: true; user: { id: string; username: string } }
  | { token: string; user: { id: string; username: string } };

export async function completeSetup(data: SetupCompleteRequest, setupToken?: string): Promise<SetupCompleteResponse> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (setupToken) headers["X-Setup-Token"] = setupToken;
  const res = await fetch(`${API_BASE}/setup/complete`, {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "Setup failed");
  }
  return res.json();
}
