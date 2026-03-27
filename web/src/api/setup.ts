const API_BASE = "/api";

export interface SetupStatus {
  setupComplete: boolean;
}

export async function getSetupStatus(): Promise<SetupStatus> {
  const res = await fetch(`${API_BASE}/setup/status`);
  return res.json();
}

export interface SetupCompleteRequest {
  email: string;
  password: string;
  openrouterApiKey: string;
  openrouterModel?: string;
}

export interface SetupCompleteResponse {
  token: string;
  user: { id: string; email: string };
}

export async function completeSetup(data: SetupCompleteRequest): Promise<SetupCompleteResponse> {
  const res = await fetch(`${API_BASE}/setup/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? "Setup failed");
  }
  return res.json();
}
