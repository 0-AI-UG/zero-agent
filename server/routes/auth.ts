import bcrypt from "bcrypt";
import { corsHeaders } from "@/lib/cors.ts";
import { authenticateRequest, createToken, createTempToken, verifyTempToken, isTotpRequired } from "@/lib/auth.ts";
import { AuthError } from "@/lib/errors.ts";
import { validateBody, loginSchema, passwordSchema } from "@/lib/validation.ts";
import { getUserByUsername, getUserById, updateUserCompanionSharing, updateUserPassword } from "@/db/queries/users.ts";
import { getPasskeyCount, getPasskeysByUserId, getPasskeyByCredentialId, updatePasskeyCounter } from "@/db/queries/passkeys.ts";
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
    authLog.info("login attempt", { username: body.username });

    const user = getUserByUsername(body.username);
    if (!user) {
      authLog.warn("login failed - unknown username", { username: body.username });
      throw new AuthError("Invalid username or password");
    }

    const valid = await bcrypt.compare(body.password, user.password_hash);
    if (!valid) {
      authLog.warn("login failed - wrong password", { username: body.username });
      throw new AuthError("Invalid username or password");
    }

    const passkeyCount = getPasskeyCount(user.id);
    if (user.totp_enabled || passkeyCount > 0) {
      const tempToken = await createTempToken(user.id);
      authLog.info("login requires 2FA", { userId: user.id, username: user.username });
      return Response.json(
        {
          requires2FA: true,
          tempToken,
          methods: {
            totp: user.totp_enabled === 1,
            passkey: passkeyCount > 0,
          },
        },
        { headers: corsHeaders },
      );
    }

    const isDev = process.env.NODE_ENV !== "production";
    if (!isDev && isTotpRequired(user)) {
      const tempToken = await createTempToken(user.id);
      authLog.info("login requires 2FA setup", { userId: user.id, username: user.username });
      return Response.json(
        { requires2FASetup: true, tempToken },
        { headers: corsHeaders },
      );
    }

    const token = await createToken({ userId: user.id, username: user.username });

    authLog.info("login success", { userId: user.id, username: user.username });
    return Response.json(
      {
        token,
        user: { id: user.id, username: user.username },
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
          username: user.username,
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
    const body = await request.json() as { username?: string };
    if (!body.username) {
      return Response.json(
        { error: "Username is required" },
        { status: 400, headers: corsHeaders },
      );
    }

    const user = getUserByUsername(body.username);
    const passkeyCount = user ? getPasskeyCount(user.id) : 0;
    if (!user || (user.totp_enabled !== 1 && passkeyCount === 0)) {
      authLog.warn("password reset unavailable", { username: body.username });
      return Response.json(
        { error: "Password reset unavailable for this account" },
        { status: 400, headers: corsHeaders },
      );
    }

    const tempToken = await createTempToken(user.id, "password-reset");
    authLog.info("password reset initiated", { userId: user.id });
    return Response.json({
      tempToken,
      methods: {
        totp: user.totp_enabled === 1,
        passkey: passkeyCount > 0,
      },
    }, { headers: corsHeaders });
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

    const totp = createTOTP(secret, user.username);
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
    authLog.info("password reset success via totp", { userId });
    return Response.json({ success: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handlePasswordResetPasskeyOptions(request: Request): Promise<Response> {
  const rateLimitResponse = checkRateLimit(request);
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const body = await request.json() as { tempToken?: string };
    if (!body.tempToken) {
      return Response.json(
        { error: "tempToken is required" },
        { status: 400, headers: corsHeaders },
      );
    }

    const userId = await verifyTempToken(body.tempToken, "password-reset");
    const passkeys = getPasskeysByUserId(userId);
    if (passkeys.length === 0) {
      return Response.json(
        { error: "No passkeys registered" },
        { status: 400, headers: corsHeaders },
      );
    }

    const { generateAuthenticationOptions } = await import("@simplewebauthn/server");
    const options = await generateAuthenticationOptions({
      rpID: process.env.RP_ID ?? "localhost",
      allowCredentials: passkeys.map((p) => ({
        id: p.credential_id,
        transports: p.transports ? JSON.parse(p.transports) : undefined,
      })),
      userVerification: "preferred",
    });

    // Store challenge for verification
    passwordResetChallenges.set(userId, { challenge: options.challenge, expires: Date.now() + 60_000 });

    return Response.json(options, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// In-memory challenge store for password reset passkey verification
const passwordResetChallenges = new Map<string, { challenge: string; expires: number }>();

export async function handlePasswordResetPasskeyConfirm(request: Request): Promise<Response> {
  const rateLimitResponse = checkRateLimit(request);
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const body = await request.json() as { tempToken?: string; response?: any; newPassword?: string };
    if (!body.tempToken || !body.response || !body.newPassword) {
      return Response.json(
        { error: "tempToken, response, and newPassword are required" },
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
    if (!user) throw new AuthError("Invalid token");

    const entry = passwordResetChallenges.get(userId);
    passwordResetChallenges.delete(userId);
    if (!entry || entry.expires < Date.now()) {
      return Response.json(
        { error: "Challenge expired. Please try again." },
        { status: 400, headers: corsHeaders },
      );
    }

    const passkey = getPasskeyByCredentialId(body.response.id);
    if (!passkey || passkey.user_id !== userId) {
      return Response.json(
        { error: "Passkey not found" },
        { status: 400, headers: corsHeaders },
      );
    }

    const { verifyAuthenticationResponse } = await import("@simplewebauthn/server");
    const verification = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge: entry.challenge,
      expectedOrigin: process.env.APP_URL ?? request.headers.get("origin") ?? `https://${process.env.RP_ID ?? "localhost"}`,
      expectedRPID: process.env.RP_ID ?? "localhost",
      credential: {
        id: passkey.credential_id,
        publicKey: Buffer.from(passkey.public_key, "base64url"),
        counter: passkey.counter,
        transports: passkey.transports ? JSON.parse(passkey.transports) : undefined,
      },
    });

    if (!verification.verified) {
      authLog.warn("password reset failed - passkey verification failed", { userId });
      return Response.json(
        { error: "Passkey verification failed" },
        { status: 400, headers: corsHeaders },
      );
    }

    updatePasskeyCounter(passkey.credential_id, verification.authenticationInfo.newCounter);

    const hash = await bcrypt.hash(body.newPassword, 10);
    updateUserPassword(userId, hash);
    authLog.info("password reset success via passkey", { userId });
    return Response.json({ success: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleUpdateMe(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const body = await request.json() as { companionSharing?: boolean };

    if (body.companionSharing !== undefined) {
      updateUserCompanionSharing(userId, body.companionSharing);
    }

    const user = getUserById(userId);
    if (!user) throw new AuthError("Unauthorized");
    return Response.json(
      {
        user: {
          id: user.id,
          username: user.username,
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
