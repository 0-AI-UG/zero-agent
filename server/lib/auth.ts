import { jwtVerify, SignJWT } from "jose";
import { AuthError, ForbiddenError } from "@/lib/errors.ts";
import { getUserById } from "@/db/queries/users.ts";

export const DESKTOP_MODE = process.env.DESKTOP_MODE === "1";

export interface TokenPayload {
  userId: string;
  email: string;
}

const DESKTOP_USER: TokenPayload = { userId: "desktop-user", email: "desktop@local" };

// HS256 requires at least 256 bits (32 bytes). Hash the secret to guarantee length.
const rawSecret = new TextEncoder().encode(
  process.env.JWT_SECRET ?? `zero-agent-${process.env.DB_PATH ?? "./data/app.db"}`
);
const JWT_SECRET = new Uint8Array(
  await crypto.subtle.digest("SHA-256", rawSecret),
);

export async function authenticateRequest(
  request: Request,
): Promise<TokenPayload> {
  if (DESKTOP_MODE) return DESKTOP_USER;
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) {
    throw new AuthError("Unauthorized");
  }
  const token = header.slice(7);
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    if ((payload as any).purpose) throw new AuthError("Unauthorized");
    return payload as unknown as TokenPayload;
  } catch {
    throw new AuthError("Unauthorized");
  }
}

export async function createToken(payload: TokenPayload): Promise<string> {
  return new SignJWT(payload as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(JWT_SECRET);
}

export async function createTempToken(userId: string): Promise<string> {
  return new SignJWT({ userId, purpose: "2fa" } as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(JWT_SECRET);
}

export async function verifyTempToken(token: string): Promise<string> {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    if ((payload as any).purpose !== "2fa") throw new AuthError("Invalid token");
    return (payload as any).userId;
  } catch (err) {
    if (err instanceof AuthError) throw err;
    throw new AuthError("Invalid or expired token");
  }
}

export async function createAppToken(userId: string, email: string): Promise<string> {
  return new SignJWT({ userId, email, purpose: "app" } as unknown as Record<string, unknown>)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(JWT_SECRET);
}

export async function verifyAppToken(token: string): Promise<TokenPayload> {
  const { payload } = await jwtVerify(token, JWT_SECRET);
  if ((payload as any).purpose !== "app") throw new AuthError("Invalid token");
  return { userId: (payload as any).userId, email: (payload as any).email };
}

export async function requireAdmin(request: Request): Promise<TokenPayload> {
  if (DESKTOP_MODE) return DESKTOP_USER;
  const payload = await authenticateRequest(request);
  const user = getUserById(payload.userId);
  if (!user?.is_admin) {
    throw new ForbiddenError("Admin access required");
  }
  return payload;
}
