import { jwtVerify, SignJWT } from "jose";
import { AuthError } from "@/lib/errors.ts";
import { getUserById } from "@/db/queries/users.ts";

export interface TokenPayload {
  userId: string;
  email: string;
}

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
  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) {
    throw new AuthError("Unauthorized");
  }
  const token = header.slice(7);
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
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

export async function requireAdmin(request: Request): Promise<TokenPayload> {
  const payload = await authenticateRequest(request);
  const user = getUserById(payload.userId);
  if (!user?.is_admin) {
    throw new AuthError("Admin access required");
  }
  return payload;
}
