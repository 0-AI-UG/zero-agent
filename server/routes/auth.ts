import bcrypt from "bcrypt";
import { corsHeaders } from "@/lib/cors.ts";
import { authenticateRequest, createToken, createTempToken, verifyTempToken, isTotpRequired } from "@/lib/auth.ts";
import { AuthError } from "@/lib/errors.ts";
import { validateBody, loginSchema, passwordSchema } from "@/lib/validation.ts";
import { getUserByEmail, getUserById, updateUserCompanionSharing, updateUserPassword } from "@/db/queries/users.ts";
import { getTotpSecret } from "@/db/queries/totp.ts";
import { createTOTP } from "@/routes/totp.ts";
import { handleError } from "@/routes/utils.ts";
import { authRateLimiter } from "@/lib/rate-limit.ts";
import { log } from "@/lib/logger.ts";
const authLog = log.child({ module: "auth" });

function getClientIP(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}

function checkRateLimit(request: Request): Response | null {
  const ip = getClientIP(request);
  const { allowed, retryAfterSeconds } = authRateLimiter.check(ip);
  if (!allowed) {
    return Response.json(
      { error: "Too many attempts. Please try again later." },
      {
        status: 429,
        headers: {
          ...corsHeaders,
          "Retry-After": String(retryAfterSeconds),
        },
      },
    );
  }
  return null;
}

export async function handleLogin(request: Request): Promise<Response> {
  const rateLimitResponse = checkRateLimit(request);
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const body = await validateBody(request, loginSchema);
    authLog.info("login attempt", { email: body.email });

    const user = getUserByEmail(body.email);
    if (!user) {
      authLog.warn("login failed - unknown email", { email: body.email });
      throw new AuthError("Invalid email or password");
    }

    const valid = await bcrypt.compare(body.password, user.password_hash);
    if (!valid) {
      authLog.warn("login failed - wrong password", { email: body.email });
      throw new AuthError("Invalid email or password");
    }

    if (user.totp_enabled) {
      const tempToken = await createTempToken(user.id);
      authLog.info("login requires 2FA", { userId: user.id, email: user.email });
      return Response.json(
        { requires2FA: true, tempToken },
        { headers: corsHeaders },
      );
    }

    const isDev = process.env.NODE_ENV !== "production";
    if (!isDev && isTotpRequired(user)) {
      const tempToken = await createTempToken(user.id);
      authLog.info("login requires 2FA setup", { userId: user.id, email: user.email });
      return Response.json(
        { requires2FASetup: true, tempToken },
        { headers: corsHeaders },
      );
    }

    const token = await createToken({ userId: user.id, email: user.email });

    authLog.info("login success", { userId: user.id, email: user.email });
    return Response.json(
      {
        token,
        user: { id: user.id, email: user.email },
      },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handleMe(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const user = getUserById(userId);
    if (!user) throw new AuthError("Unauthorized");
    return Response.json(
      {
        user: {
          id: user.id,
          email: user.email,
          isAdmin: user.is_admin === 1,
          canCreateProjects: user.can_create_projects !== 0,
          companionSharing: user.companion_sharing === 1,
          totpEnabled: user.totp_enabled === 1,
          totpRequired: isTotpRequired(user),
        },
      },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

export async function handlePasswordResetInit(request: Request): Promise<Response> {
  const rateLimitResponse = checkRateLimit(request);
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const body = await request.json() as { email?: string };
    if (!body.email) {
      return Response.json(
        { error: "Email is required" },
        { status: 400, headers: corsHeaders },
      );
    }

    const user = getUserByEmail(body.email);
    if (!user || user.totp_enabled !== 1) {
      authLog.warn("password reset unavailable", { email: body.email });
      return Response.json(
        { error: "Password reset unavailable for this account" },
        { status: 400, headers: corsHeaders },
      );
    }

    const tempToken = await createTempToken(user.id, "password-reset");
    authLog.info("password reset initiated", { userId: user.id });
    return Response.json({ tempToken }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handlePasswordResetConfirm(request: Request): Promise<Response> {
  const rateLimitResponse = checkRateLimit(request);
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const body = await request.json() as { tempToken?: string; code?: string; newPassword?: string };
    if (!body.tempToken || !body.code || !body.newPassword) {
      return Response.json(
        { error: "tempToken, code, and newPassword are required" },
        { status: 400, headers: corsHeaders },
      );
    }

    const passwordResult = passwordSchema.safeParse(body.newPassword);
    if (!passwordResult.success) {
      return Response.json(
        { error: passwordResult.error.issues.map((i) => i.message).join("; ") },
        { status: 400, headers: corsHeaders },
      );
    }

    const userId = await verifyTempToken(body.tempToken, "password-reset");
    const user = getUserById(userId);
    if (!user || user.totp_enabled !== 1) throw new AuthError("Invalid token");

    const secret = getTotpSecret(userId);
    if (!secret) throw new AuthError("TOTP not configured");

    const totp = createTOTP(secret, user.email);
    const delta = totp.validate({ token: body.code, window: 1 });
    if (delta === null) {
      authLog.warn("password reset failed - invalid totp", { userId });
      return Response.json(
        { error: "Invalid code" },
        { status: 400, headers: corsHeaders },
      );
    }

    const hash = await bcrypt.hash(body.newPassword, 10);
    updateUserPassword(userId, hash);
    authLog.info("password reset success", { userId });
    return Response.json({ success: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleUpdateMe(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const body = await request.json() as { companionSharing?: boolean; currentPassword?: string; newPassword?: string };

    if (body.companionSharing !== undefined) {
      updateUserCompanionSharing(userId, body.companionSharing);
    }

    if (body.newPassword !== undefined) {
      if (!body.currentPassword) {
        return Response.json(
          { error: "Current password is required" },
          { status: 400, headers: corsHeaders },
        );
      }
      const user = getUserById(userId);
      if (!user) throw new AuthError("Unauthorized");
      const valid = await bcrypt.compare(body.currentPassword, user.password_hash);
      if (!valid) {
        return Response.json(
          { error: "Current password is incorrect" },
          { status: 400, headers: corsHeaders },
        );
      }
      if (body.newPassword.length < 8) {
        return Response.json(
          { error: "New password must be at least 8 characters" },
          { status: 400, headers: corsHeaders },
        );
      }
      const { db } = await import("@/db/index.ts");
      const hash = await bcrypt.hash(body.newPassword, 10);
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, userId);
    }

    const user = getUserById(userId);
    if (!user) throw new AuthError("Unauthorized");
    return Response.json(
      {
        user: {
          id: user.id,
          email: user.email,
          isAdmin: user.is_admin === 1,
          canCreateProjects: user.can_create_projects !== 0,
          companionSharing: user.companion_sharing === 1,
          totpEnabled: user.totp_enabled === 1,
          totpRequired: isTotpRequired(user),
        },
      },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}
