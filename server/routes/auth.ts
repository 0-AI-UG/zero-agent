import bcrypt from "bcrypt";
import { corsHeaders } from "@/lib/http/cors.ts";
import {
  authenticateRequest,
  createToken,
  createTempToken,
  verifyTempToken,
} from "@/lib/auth/auth.ts";
import { AuthError } from "@/lib/utils/errors.ts";
import { validateBody, loginSchema, passwordSchema } from "@/lib/auth/validation.ts";
import {
  getUserByUsername,
  getUserById,
  updateUserCompanionSharing,
  updateUserPassword,
  bumpTokenVersion,
} from "@/db/queries/users.ts";
import {
  getPasskeyCount,
  getPasskeysByUserId,
  getPasskeyByCredentialId,
  updatePasskeyCounter,
} from "@/db/queries/passkeys.ts";
import { handleError } from "@/routes/utils.ts";
import { authRateLimiter, recordAuthFailure, getClientIP } from "@/lib/http/rate-limit.ts";
import {
  setAuthCookieHeader,
  clearAuthCookieHeader,
  setCsrfCookieHeader,
  clearCsrfCookieHeader,
  generateCsrfToken,
} from "@/lib/http/cookies.ts";
import { getSetting } from "@/lib/settings.ts";
import { log } from "@/lib/utils/logger.ts";

const authLog = log.child({ module: "auth" });

// Precomputed dummy hash to flatten timing oracle on unknown-username login.
const DUMMY_HASH = bcrypt.hashSync("__dummy_password__", 10);

// Passkey is required either for admins or when REQUIRE_2FA is set.
function passkeyRequired(user: { is_admin?: number }): boolean {
  if (user.is_admin === 1) return true;
  return getSetting("REQUIRE_2FA") === "1";
}

function checkRateLimit(request: Request): Response | null {
  const ip = getClientIP(request);
  const { allowed, retryAfterSeconds } = authRateLimiter.check(ip);
  if (!allowed) {
    return Response.json(
      { error: "Too many attempts. Please try again later." },
      {
        status: 429,
        headers: { ...corsHeaders, "Retry-After": String(retryAfterSeconds) },
      },
    );
  }
  return null;
}

async function issueSessionResponse(
  userId: string,
  username: string,
): Promise<Response> {
  const token = await createToken({ userId, username });
  const csrf = generateCsrfToken();
  const headers = new Headers(corsHeaders);
  headers.append("Set-Cookie", setAuthCookieHeader(token));
  headers.append("Set-Cookie", setCsrfCookieHeader(csrf));
  headers.set("Content-Type", "application/json");
  return new Response(
    JSON.stringify({
      user: { id: userId, username },
      csrfToken: csrf,
      // Bearer token returned for non-browser clients (CLI). Browsers should
      // rely on the cookie and ignore this field.
      token,
    }),
    { headers },
  );
}

export async function handleLogin(request: Request): Promise<Response> {
  const rateLimitResponse = checkRateLimit(request);
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const body = await validateBody(request, loginSchema);
    authLog.info("login attempt", { username: body.username });

    const user = getUserByUsername(body.username);
    // Always run bcrypt to flatten the timing oracle between unknown user
    // and wrong password.
    const candidateHash = user?.password_hash ?? DUMMY_HASH;
    const valid = await bcrypt.compare(body.password, candidateHash);
    if (!user || !valid) {
      authLog.warn("login failed", { username: body.username });
      recordAuthFailure(request);
      throw new AuthError("Invalid username or password");
    }

    const passkeyCount = getPasskeyCount(user.id);
    if (passkeyCount > 0) {
      const tempToken = await createTempToken(user.id, "password-reset");
      authLog.info("login requires passkey", { userId: user.id });
      return Response.json(
        { requires2FA: true, tempToken },
        { headers: corsHeaders },
      );
    }

    if (passkeyRequired(user)) {
      const tempToken = await createTempToken(user.id, "passkey-enroll");
      authLog.info("login requires passkey enrollment", { userId: user.id });
      return Response.json(
        { requires2FASetup: true, tempToken },
        { headers: corsHeaders },
      );
    }

    authLog.info("login success", { userId: user.id });
    return issueSessionResponse(user.id, user.username);
  } catch (error) {
    return handleError(error);
  }
}

export async function handleLogout(request: Request): Promise<Response> {
  try {
    // Best-effort: if the request carries a valid session, bump token_version
    // to invalidate every JWT issued for that user.
    try {
      const { userId } = await authenticateRequest(request);
      bumpTokenVersion(userId);
      authLog.info("logout", { userId });
    } catch {
      // Unauthenticated logout still clears the cookie.
    }
    const headers = new Headers(corsHeaders);
    headers.append("Set-Cookie", clearAuthCookieHeader());
    headers.append("Set-Cookie", clearCsrfCookieHeader());
    headers.set("Content-Type", "application/json");
    return new Response(JSON.stringify({ success: true }), { headers });
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
          passkeyRequired: passkeyRequired(user),
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
    // Always return the same shape — never disclose account existence or
    // whether the account has a passkey. Only mint a token if reset is
    // actually possible.
    if (!user || passkeyCount === 0) {
      authLog.warn("password reset init (unavailable)", { username: body.username });
      return Response.json({ ok: true }, { headers: corsHeaders });
    }

    const tempToken = await createTempToken(user.id, "password-reset");
    authLog.info("password reset initiated", { userId: user.id });
    return Response.json({ ok: true, tempToken }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// In-memory challenge store keyed by ceremony id. Persists for 60s only.
const passwordResetChallenges = new Map<
  string,
  { userId: string; challenge: string; expires: number }
>();

function cleanupChallenges() {
  const now = Date.now();
  for (const [id, e] of passwordResetChallenges) {
    if (e.expires < now) passwordResetChallenges.delete(id);
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
      userVerification: "required",
    });

    cleanupChallenges();
    const ceremonyId = crypto.randomUUID();
    passwordResetChallenges.set(ceremonyId, {
      userId,
      challenge: options.challenge,
      expires: Date.now() + 60_000,
    });

    return Response.json({ ...options, ceremonyId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handlePasswordResetPasskeyConfirm(request: Request): Promise<Response> {
  const rateLimitResponse = checkRateLimit(request);
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const body = await request.json() as {
      tempToken?: string;
      ceremonyId?: string;
      response?: any;
      newPassword?: string;
    };
    if (!body.tempToken || !body.ceremonyId || !body.response || !body.newPassword) {
      return Response.json(
        { error: "tempToken, ceremonyId, response, and newPassword are required" },
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

    const entry = passwordResetChallenges.get(body.ceremonyId);
    passwordResetChallenges.delete(body.ceremonyId);
    if (!entry || entry.userId !== userId || entry.expires < Date.now()) {
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
      requireUserVerification: true,
      credential: {
        id: passkey.credential_id,
        publicKey: Buffer.from(passkey.public_key, "base64url"),
        counter: passkey.counter,
        transports: passkey.transports ? JSON.parse(passkey.transports) : undefined,
      },
    });

    if (!verification.verified) {
      authLog.warn("password reset failed - passkey verification failed", { userId });
      recordAuthFailure(request);
      return Response.json(
        { error: "Passkey verification failed" },
        { status: 400, headers: corsHeaders },
      );
    }

    updatePasskeyCounter(passkey.credential_id, verification.authenticationInfo.newCounter);

    const hash = await bcrypt.hash(body.newPassword, 12);
    // updateUserPassword bumps token_version, invalidating every existing JWT.
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
          passkeyRequired: passkeyRequired(user),
        },
      },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}
