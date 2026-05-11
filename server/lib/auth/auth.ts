import { jwtVerify, SignJWT } from "jose";
import { AuthError, ForbiddenError } from "@/lib/utils/errors.ts";
import { getUserById } from "@/db/queries/users.ts";
import { readAuthCookie } from "@/lib/http/cookies.ts";

export interface TokenPayload {
  userId: string;
  username: string;
}

// HS256 requires at least 32 bytes. Refuse to boot if unset/too short.
function loadJwtSecret(): Uint8Array {
  const raw = process.env.JWT_SECRET;
  if (!raw || raw.length < 32) {
    throw new Error(
      "JWT_SECRET must be set to a string of at least 32 characters. Refusing to boot.",
    );
  }
  return new TextEncoder().encode(raw);
}

const JWT_SECRET = loadJwtSecret();

/** Verify a raw JWT string and return the payload. Throws AuthError on failure. */
export async function verifyToken(token: string): Promise<TokenPayload> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    if ((payload as any).purpose) throw new AuthError("Unauthorized");
    const userId = (payload as any).userId as string;
    const tv = (payload as any).tv;
    const user = getUserById(userId);
    if (!user) throw new AuthError("Unauthorized");
    if (typeof tv !== "number" || tv !== user.token_version) {
      throw new AuthError("Unauthorized");
    }
    return { userId, username: (payload as any).username };
  } catch (err) {
    if (err instanceof AuthError) throw err;
    throw new AuthError("Unauthorized");
  }
}

export async function authenticateRequest(
  request: Request,
): Promise<TokenPayload> {
  // Prefer the auth cookie (browser); fall back to bearer (CLI / API clients).
  const cookieToken = readAuthCookie(request);
  if (cookieToken) {
    return verifyToken(cookieToken);
  }
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) {
    throw new AuthError("Unauthorized");
  }
  return verifyToken(header.slice(7));
}

export async function createToken(payload: TokenPayload): Promise<string> {
  const user = getUserById(payload.userId);
  if (!user) throw new AuthError("Unauthorized");
  return new SignJWT({
    userId: payload.userId,
    username: payload.username,
    tv: user.token_version,
  } as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(JWT_SECRET);
}

export type TempTokenPurpose = "password-reset" | "passkey-enroll";

const TEMP_TOKEN_EXPIRY: Record<TempTokenPurpose, string> = {
  "password-reset": "5m",
  "passkey-enroll": "10m",
};

// Single-use jti set for temp tokens. Cleared periodically.
const usedJtis = new Map<string, number>();
function cleanupJtis() {
  const now = Date.now();
  for (const [jti, exp] of usedJtis) {
    if (exp < now) usedJtis.delete(jti);
  }
}

export async function createTempToken(
  userId: string,
  purpose: TempTokenPurpose = "password-reset",
): Promise<string> {
  const jti = crypto.randomUUID();
  return new SignJWT({ userId, purpose, jti } as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(TEMP_TOKEN_EXPIRY[purpose])
    .sign(JWT_SECRET);
}

export async function verifyTempToken(
  token: string,
  expectedPurpose: TempTokenPurpose = "password-reset",
): Promise<string> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    if ((payload as any).purpose !== expectedPurpose) throw new AuthError("Invalid token");
    const jti = (payload as any).jti as string | undefined;
    if (!jti) throw new AuthError("Invalid token");
    cleanupJtis();
    if (usedJtis.has(jti)) throw new AuthError("Invalid or expired token");
    const exp = ((payload as any).exp as number) * 1000;
    usedJtis.set(jti, exp);
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
