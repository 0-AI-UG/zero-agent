/** Shared-secret authentication for the runner API. */

const API_KEY = process.env.RUNNER_API_KEY ?? "";

export function validateAuth(request: Request): boolean {
  if (!API_KEY) return true; // No key configured = open (dev mode)
  const header = request.headers.get("Authorization");
  if (!header) return false;
  const token = header.startsWith("Bearer ") ? header.slice(7) : header;
  return token === API_KEY;
}

export function unauthorized(): Response {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}
