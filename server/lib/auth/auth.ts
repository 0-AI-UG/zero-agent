import { jwtVerify, SignJWT } from "jose";
import { AuthError, ForbiddenError } from "@/lib/errors.ts";
import { getUserById } from "@/db/queries/users.ts";
import { getSetting } from "@/lib/settings.ts";

export function isTotpRequired(user: { is_admin?: number }): boolean {
  if (user.is_admin === 1) return true;
  return getSetting("REQUIRE_2FA") === "1";
}

export interface TokenPayload {
  userId: string;
  username: string;
}

// HS256 requires at least 256 bits (32 bytes). Hash the secret to guarantee length.
const rawSecret = new TextEncoder().encode(
  process.env.JWT_SECRET ?? `zero-agent-${process.env.DB_PATH ?? "./data/app.db"}`
);
const JWT_SECRET = new Uint8Array(
  await crypto.subtle.digest("SHA-256", rawSecret),
);

/** Verify a raw JWT string and return the payload. Throws AuthError on failure. */
export async function verifyToken(token: string): Promise<TokenPayload> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    if ((payload as any).purpose) throw new AuthError("Unauthorized");
    return payload as unknown as TokenPayload;
  } catch {
    throw new AuthError("Unauthorized");
  }
}

export async function authenticateRequest(
  request: Request,
): Promise<TokenPayload> {
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) {
    throw new AuthError("Unauthorized");
  }
  return verifyToken(header.slice(7));
}

export async function createToken(payload: TokenPayload): Promise<string> {
  return new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(JWT_SECRET);
}

export type TempTokenPurpose = "2fa" | "password-reset" | "2fa-reenroll";

const TEMP_TOKEN_EXPIRY: Record<TempTokenPurpose, string> = {
  "2fa": "5m",
  "password-reset": "5m",
  "2fa-reenroll": "10m",
};

export async function createTempToken(
  userId: string,
  purpose: TempTokenPurpose = "2fa",
): Promise<string> {
  return new SignJWT({ userId, purpose } as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(TEMP_TOKEN_EXPIRY[purpose])
    .sign(JWT_SECRET);
}

export async function verifyTempToken(
  token: string,
  expectedPurpose: TempTokenPurpose = "2fa",
): Promise<string> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    if ((payload as any).purpose !== expectedPurpose) throw new AuthError("Invalid token");
    return (payload as any).userId;
  } catch (err) {
    if (err instanceof AuthError) throw err;
    throw new AuthError("Invalid or expired token");
  }
}

export async function createAppToken(userId: string, username: string): Promise<string> {
  return new SignJWT({ userId, username, purpose: "app" } as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(JWT_SECRET);
}

export async function verifyAppToken(token: string): Promise<TokenPayload> {
  const { payload } = await jwtVerify(token, JWT_SECRET);
  if ((payload as any).purpose !== "app") throw new AuthError("Invalid token");
  return { userId: (payload as any).userId, username: (payload as any).username };
}

export async function createShareToken(slug: string, expiresIn: string): Promise<string> {
  return new SignJWT({ slug, purpose: "share" } as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(JWT_SECRET);
}

export async function verifyShareToken(token: string, slug: string): Promise<void> {
  const { payload } = await jwtVerify(token, JWT_SECRET);
  if ((payload as any).purpose !== "share") throw new AuthError("Invalid token");
  if ((payload as any).slug !== slug) throw new AuthError("Token does not match app");
}

export async function requireAdmin(request: Request): Promise<TokenPayload> {
  const payload = await authenticateRequest(request);
  const user = getUserById(payload.userId);
  if (!user?.is_admin) {
    throw new ForbiddenError("Admin access required");
  }
  return payload;
}
