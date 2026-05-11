// Cookie helpers for the auth session and CSRF double-submit token.
// `auth` is httpOnly and carries the JWT; `csrf` is readable by JS and
// must be echoed back as the X-CSRF-Token header on mutating requests.

const SEVEN_DAYS_SEC = 60 * 60 * 24 * 7;

function isProd(): boolean {
  return process.env.NODE_ENV === "production";
}

export const AUTH_COOKIE = "auth";
export const CSRF_COOKIE = "csrf";

function cookieAttrs(maxAgeSec: number, httpOnly: boolean): string {
  const parts = [
    `Path=/`,
    `Max-Age=${maxAgeSec}`,
    `SameSite=Strict`,
  ];
  if (httpOnly) parts.push("HttpOnly");
  if (isProd()) parts.push("Secure");
  return parts.join("; ");
}

export function setAuthCookieHeader(token: string): string {
  return `${AUTH_COOKIE}=${token}; ${cookieAttrs(SEVEN_DAYS_SEC, true)}`;
}

export function clearAuthCookieHeader(): string {
  return `${AUTH_COOKIE}=; ${cookieAttrs(0, true)}`;
}

export function setCsrfCookieHeader(token: string): string {
  // Not httpOnly — the SPA must read this and echo it as X-CSRF-Token.
  return `${CSRF_COOKIE}=${token}; ${cookieAttrs(SEVEN_DAYS_SEC, false)}`;
}

export function clearCsrfCookieHeader(): string {
  return `${CSRF_COOKIE}=; ${cookieAttrs(0, false)}`;
}

function parseCookies(header: string | null): Map<string, string> {
  const map = new Map<string, string>();
  if (!header) return map;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) map.set(k, v);
  }
  return map;
}

export function readAuthCookie(request: Request): string | null {
  return parseCookies(request.headers.get("cookie")).get(AUTH_COOKIE) ?? null;
}

export function readCsrfCookie(request: Request): string | null {
  return parseCookies(request.headers.get("cookie")).get(CSRF_COOKIE) ?? null;
}

export function generateCsrfToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
