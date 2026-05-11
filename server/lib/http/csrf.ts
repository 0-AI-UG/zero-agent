import { corsHeaders } from "@/lib/http/cors.ts";
import { readCsrfCookie } from "@/lib/http/cookies.ts";

// CSRF middleware: for state-changing methods on /api/*, require the
// X-CSRF-Token header to match the csrf cookie (double-submit pattern).
// Bearer-token clients (CLI, server-to-server) bypass — they don't have
// a cookie and their requests aren't browser-driven.

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Routes that genuinely cannot have a CSRF token yet (no session) and are
// otherwise safe by other means (origin checks, rate limits, etc.).
const EXEMPT_PREFIXES = [
  "/api/auth/login",
  "/api/auth/password-reset/", // username + passkey ceremony is the auth
  "/api/auth/passkey/login-",  // unauthenticated login ceremony
  "/api/setup/",
  "/api/user-invitations/",
  "/api/telegram/webhook",
  "/v1/proxy/",                // pi CLI proxy uses its own per-turn token
];

export function isCsrfExempt(path: string): boolean {
  return EXEMPT_PREFIXES.some((p) => path.startsWith(p));
}

export function checkCsrf(request: Request, path: string): Response | null {
  if (!MUTATING.has(request.method)) return null;
  // No cookie at all → caller is using bearer auth (CLI). CSRF doesn't apply.
  const cookie = request.headers.get("cookie") ?? "";
  if (!cookie.includes("auth=")) return null;
  if (isCsrfExempt(path)) return null;
  const cookieToken = readCsrfCookie(request);
  const headerToken = request.headers.get("x-csrf-token");
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return Response.json(
      { error: "CSRF token missing or invalid" },
      { status: 403, headers: corsHeaders },
    );
  }
  return null;
}
