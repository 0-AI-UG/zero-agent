import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import { corsHeaders } from "@/lib/http/cors.ts";
import {
  authenticateRequest,
  createToken,
  verifyTempToken,
  type TempTokenPurpose,
} from "@/lib/auth/auth.ts";
import { AuthError } from "@/lib/utils/errors.ts";
import { getUserById } from "@/db/queries/users.ts";
import {
  getPasskeysByUserId,
  getPasskeyByCredentialId,
  getPasskeyCount,
  insertPasskey,
  updatePasskeyCounter,
  deletePasskey,
} from "@/db/queries/passkeys.ts";
import { handleError } from "@/routes/utils.ts";
import { authRateLimiter, recordAuthFailure, getClientIP } from "@/lib/http/rate-limit.ts";
import {
  setAuthCookieHeader,
  setCsrfCookieHeader,
  generateCsrfToken,
} from "@/lib/http/cookies.ts";
import { log } from "@/lib/utils/logger.ts";

const passkeyLog = log.child({ module: "passkey" });

// ── Challenge store (in-memory, 60s TTL, keyed by ceremony id) ──

interface ChallengeEntry {
  userId: string;
  challenge: string;
  purpose: "register" | "login";
  expires: number;
}

const challenges = new Map<string, ChallengeEntry>();

function cleanupChallenges() {
  const now = Date.now();
  for (const [id, e] of challenges) {
    if (e.expires < now) challenges.delete(id);
  }
}

function newCeremonyId(): string {
  return crypto.randomUUID();
}

function storeChallenge(
  ceremonyId: string,
  userId: string,
  challenge: string,
  purpose: "register" | "login",
): void {
  cleanupChallenges();
  challenges.set(ceremonyId, {
    userId,
    challenge,
    purpose,
    expires: Date.now() + 60_000,
  });
}

function takeChallenge(
  ceremonyId: string,
  userId: string,
  purpose: "register" | "login",
): string | null {
  const entry = challenges.get(ceremonyId);
  challenges.delete(ceremonyId);
  if (!entry) return null;
  if (entry.userId !== userId || entry.purpose !== purpose) return null;
  if (entry.expires < Date.now()) return null;
  return entry.challenge;
}

// ── RP config ──

function getRpId(): string {
  return process.env.RP_ID ?? "localhost";
}

function getRpName(): string {
  return process.env.RP_NAME ?? "ZeroAgent";
}

function getOrigin(request: Request): string {
  if (process.env.APP_URL) return process.env.APP_URL;
  const origin = request.headers.get("origin");
  if (origin) return origin;
  return `https://${getRpId()}`;
}

// ── Rate limiting ──

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

// ── Handlers ──

/** POST /api/auth/passkey/register-options — authenticated session */
export async function handlePasskeyRegisterOptions(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const user = getUserById(userId);
    if (!user) throw new AuthError("Unauthorized");

    const existingPasskeys = getPasskeysByUserId(userId);

    const options = await generateRegistrationOptions({
      rpName: getRpName(),
      rpID: getRpId(),
      userName: user.username,
      userDisplayName: user.username,
      attestationType: "none",
      excludeCredentials: existingPasskeys.map((p) => ({
        id: p.credential_id,
        transports: p.transports ? JSON.parse(p.transports) : undefined,
      })),
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "required",
      },
    });

    const ceremonyId = newCeremonyId();
    storeChallenge(ceremonyId, userId, options.challenge, "register");

    passkeyLog.info("passkey registration options generated", { userId });
    return Response.json({ ...options, ceremonyId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

/** POST /api/auth/passkey/register-verify — authenticated session */
export async function handlePasskeyRegisterVerify(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const user = getUserById(userId);
    if (!user) throw new AuthError("Unauthorized");

    const body = await request.json() as {
      ceremonyId?: string;
      response?: RegistrationResponseJSON;
      deviceName?: string;
    };
    if (!body.ceremonyId || !body.response) {
      return Response.json(
        { error: "ceremonyId and response are required" },
        { status: 400, headers: corsHeaders },
      );
    }

    const expectedChallenge = takeChallenge(body.ceremonyId, userId, "register");
    if (!expectedChallenge) {
      return Response.json(
        { error: "Challenge expired or not found. Please try again." },
        { status: 400, headers: corsHeaders },
      );
    }

    const verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge,
      expectedOrigin: getOrigin(request),
      expectedRPID: getRpId(),
      requireUserVerification: true,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return Response.json(
        { error: "Registration verification failed" },
        { status: 400, headers: corsHeaders },
      );
    }

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

    insertPasskey(
      userId,
      credential.id,
      Buffer.from(credential.publicKey).toString("base64url"),
      credential.counter,
      credential.transports ? JSON.stringify(credential.transports) : null,
      body.deviceName || "Passkey",
    );

    passkeyLog.info("passkey registered", {
      userId,
      credentialId: credential.id,
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
    });

    return Response.json({ success: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

/**
 * POST /api/auth/passkey/login-options — unauthenticated, uses tempToken
 * (either "password-reset" purpose during 2FA, or "passkey-enroll" — but
 * enrollment uses register-from-login, so login-options is for 2FA only).
 */
export async function handlePasskeyLoginOptions(request: Request): Promise<Response> {
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

    const userId = await verifyTempToken(body.tempToken, "password-reset", false);

    const passkeys = getPasskeysByUserId(userId);
    if (passkeys.length === 0) {
      return Response.json(
        { error: "No passkeys registered" },
        { status: 400, headers: corsHeaders },
      );
    }

    const options = await generateAuthenticationOptions({
      rpID: getRpId(),
      allowCredentials: passkeys.map((p) => ({
        id: p.credential_id,
        transports: p.transports
          ? (JSON.parse(p.transports) as AuthenticatorTransportFuture[])
          : undefined,
      })),
      userVerification: "required",
    });

    const ceremonyId = newCeremonyId();
    storeChallenge(ceremonyId, userId, options.challenge, "login");

    passkeyLog.info("passkey login options generated", { userId });
    return Response.json({ ...options, ceremonyId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

/** POST /api/auth/passkey/login-verify — issues a session cookie */
export async function handlePasskeyLoginVerify(request: Request): Promise<Response> {
  const rateLimitResponse = checkRateLimit(request);
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const body = await request.json() as {
      tempToken?: string;
      ceremonyId?: string;
      response?: AuthenticationResponseJSON;
    };
    if (!body.tempToken || !body.ceremonyId || !body.response) {
      return Response.json(
        { error: "tempToken, ceremonyId, and response are required" },
        { status: 400, headers: corsHeaders },
      );
    }

    const userId = await verifyTempToken(body.tempToken, "password-reset");
    const user = getUserById(userId);
    if (!user) throw new AuthError("Unauthorized");

    const expectedChallenge = takeChallenge(body.ceremonyId, userId, "login");
    if (!expectedChallenge) {
      return Response.json(
        { error: "Challenge expired or not found. Please try again." },
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

    const verification = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge,
      expectedOrigin: getOrigin(request),
      expectedRPID: getRpId(),
      requireUserVerification: true,
      credential: {
        id: passkey.credential_id,
        publicKey: Buffer.from(passkey.public_key, "base64url"),
        counter: passkey.counter,
        transports: passkey.transports
          ? (JSON.parse(passkey.transports) as AuthenticatorTransportFuture[])
          : undefined,
      },
    });

    if (!verification.verified) {
      passkeyLog.warn("passkey login failed - verification failed", { userId });
      recordAuthFailure(request);
      return Response.json(
        { error: "Passkey verification failed" },
        { status: 400, headers: corsHeaders },
      );
    }

    updatePasskeyCounter(passkey.credential_id, verification.authenticationInfo.newCounter);

    const token = await createToken({ userId: user.id, username: user.username });
    const csrf = generateCsrfToken();
    const headers = new Headers(corsHeaders);
    headers.append("Set-Cookie", setAuthCookieHeader(token));
    headers.append("Set-Cookie", setCsrfCookieHeader(csrf));
    headers.set("Content-Type", "application/json");
    passkeyLog.info("passkey login success", { userId });
    return new Response(
      JSON.stringify({
        user: { id: user.id, username: user.username },
        csrfToken: csrf,
        token,
      }),
      { headers },
    );
  } catch (error) {
    return handleError(error);
  }
}

/**
 * POST /api/auth/passkey/enroll-options — unauthenticated; uses a
 * "passkey-enroll" tempToken issued by login when the user has no passkey
 * yet but one is required. Lets the browser register a passkey before
 * the real session is granted.
 */
export async function handlePasskeyEnrollOptions(request: Request): Promise<Response> {
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

    const userId = await verifyTempToken(body.tempToken, "passkey-enroll" as TempTokenPurpose, false);
    const user = getUserById(userId);
    if (!user) throw new AuthError("Unauthorized");

    const existingPasskeys = getPasskeysByUserId(userId);
    const options = await generateRegistrationOptions({
      rpName: getRpName(),
      rpID: getRpId(),
      userName: user.username,
      userDisplayName: user.username,
      attestationType: "none",
      excludeCredentials: existingPasskeys.map((p) => ({
        id: p.credential_id,
        transports: p.transports ? JSON.parse(p.transports) : undefined,
      })),
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "required",
      },
    });

    const ceremonyId = newCeremonyId();
    storeChallenge(ceremonyId, userId, options.challenge, "register");
    return Response.json({ ...options, ceremonyId }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

/** POST /api/auth/passkey/enroll-verify — finishes login by registering a passkey */
export async function handlePasskeyEnrollVerify(request: Request): Promise<Response> {
  const rateLimitResponse = checkRateLimit(request);
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const body = await request.json() as {
      tempToken?: string;
      ceremonyId?: string;
      response?: RegistrationResponseJSON;
      deviceName?: string;
    };
    if (!body.tempToken || !body.ceremonyId || !body.response) {
      return Response.json(
        { error: "tempToken, ceremonyId, and response are required" },
        { status: 400, headers: corsHeaders },
      );
    }

    const userId = await verifyTempToken(body.tempToken, "passkey-enroll" as TempTokenPurpose);
    const user = getUserById(userId);
    if (!user) throw new AuthError("Unauthorized");

    const expectedChallenge = takeChallenge(body.ceremonyId, userId, "register");
    if (!expectedChallenge) {
      return Response.json(
        { error: "Challenge expired or not found. Please try again." },
        { status: 400, headers: corsHeaders },
      );
    }

    const verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge,
      expectedOrigin: getOrigin(request),
      expectedRPID: getRpId(),
      requireUserVerification: true,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return Response.json(
        { error: "Registration verification failed" },
        { status: 400, headers: corsHeaders },
      );
    }

    const { credential } = verification.registrationInfo;
    insertPasskey(
      userId,
      credential.id,
      Buffer.from(credential.publicKey).toString("base64url"),
      credential.counter,
      credential.transports ? JSON.stringify(credential.transports) : null,
      body.deviceName || "Passkey",
    );

    // Issue the real session.
    const token = await createToken({ userId: user.id, username: user.username });
    const csrf = generateCsrfToken();
    const headers = new Headers(corsHeaders);
    headers.append("Set-Cookie", setAuthCookieHeader(token));
    headers.append("Set-Cookie", setCsrfCookieHeader(csrf));
    headers.set("Content-Type", "application/json");
    passkeyLog.info("passkey enroll-from-login success", { userId });
    return new Response(
      JSON.stringify({
        user: { id: user.id, username: user.username },
        csrfToken: csrf,
        token,
      }),
      { headers },
    );
  } catch (error) {
    return handleError(error);
  }
}

/** GET /api/auth/passkey/list */
export async function handlePasskeyList(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);

    const passkeys = getPasskeysByUserId(userId).map((p) => ({
      id: p.id,
      deviceName: p.device_name,
      createdAt: p.created_at,
    }));

    return Response.json({ passkeys }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

/** DELETE /api/auth/passkey/:id */
export async function handlePasskeyDelete(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const user = getUserById(userId);
    if (!user) throw new AuthError("Unauthorized");

    const id = (request as any).params?.id;
    if (!id) {
      return Response.json(
        { error: "Passkey ID is required" },
        { status: 400, headers: corsHeaders },
      );
    }

    // Passkey is the only 2FA. Block deletion of the last passkey when
    // 2FA is required for the account.
    const requiresPasskey = user.is_admin === 1; // simple rule; setting can extend.
    const count = getPasskeyCount(userId);
    if (requiresPasskey && count <= 1) {
      return Response.json(
        { error: "Cannot delete your only passkey while two-factor authentication is required" },
        { status: 403, headers: corsHeaders },
      );
    }

    deletePasskey(id, userId);
    passkeyLog.info("passkey deleted", { userId, passkeyId: id });
    return Response.json({ deleted: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
