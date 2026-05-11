// CORS configuration.
//
// In production, `CORS_ORIGIN` MUST be set to the exact origin allowed
// (e.g. https://app.example.com). Refuse to boot otherwise.
//
// In dev (NODE_ENV !== "production"), fall back to `*` for convenience.
// Note: with credentials/cookies in use, browsers will not actually send
// cookies cross-origin when the server replies `*`, so this fallback is
// safe in dev but useless in production.

const IS_PROD = process.env.NODE_ENV === "production";

function resolveOrigin(): string {
  const v = process.env.CORS_ORIGIN;
  if (v && v.length > 0) return v;
  if (IS_PROD) {
    throw new Error(
      "CORS_ORIGIN must be set in production (e.g. https://app.example.com). Refusing to boot.",
    );
  }
  return "*";
}

const CORS_ORIGIN = resolveOrigin();

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": CORS_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-CSRF-Token",
  // Credentials are required for cookie-based auth. `*` + credentials is
  // ignored by browsers, so this is a no-op in dev with `*`.
  ...(CORS_ORIGIN === "*" ? {} : { "Access-Control-Allow-Credentials": "true" }),
};
