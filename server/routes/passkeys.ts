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
import { authenticateRequest, createToken, verifyTempToken } from "@/lib/auth/auth.ts";
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
import { authRateLimiter, recordAuthFailure } from "@/lib/http/rate-limit.ts";
import { log } from "@/lib/utils/logger.ts";
import { isTotpRequired } from "@/lib/auth/auth.ts";

const passkeyLog = log.child({ module: "passkey" });

// ── Challenge store (in-memory, 60s TTL) ──

const challenges = new Map<string, { challenge: string; expires: number }>();

function storeChallenge(userId: string, challenge: string): void {
  challenges.set(userId, { challenge, expires: Date.now() + 60_000 });
}

function getAndDeleteChallenge(userId: string): string | null {
  const entry = challenges.get(userId);
  challenges.delete(userId);
  if (!entry || entry.expires < Date.now()) return null;
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
        headers: { ...corsHeaders, "Retry-After": String(retryAfterSeconds) },
      },
    );
  }
  return null;
}

// ── Handlers ──

/** POST /api/auth/passkey/register-options - generate registration options (authenticated) */
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
        userVerification: "preferred",
      },
    });

    storeChallenge(userId, options.challenge);

    passkeyLog.info("passkey registration options generated", { userId });
    return Response.json(options, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

/** POST /api/auth/passkey/register-verify - verify registration response (authenticated) */
export async function handlePasskeyRegisterVerify(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const user = getUserById(userId);
    if (!user) throw new AuthError("Unauthorized");

    const body = await request.json() as {
      response?: RegistrationResponseJSON;
      deviceName?: string;
    };
    if (!body.response) {
      return Response.json(
        { error: "Registration response is required" },
        { status: 400, headers: corsHeaders },
      );
    }

    const expectedChallenge = getAndDeleteChallenge(userId);
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

/** POST /api/auth/passkey/login-options - generate authentication options (unauthenticated, uses tempToken) */
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

    const userId = await verifyTempToken(body.tempToken);

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
      userVerification: "preferred",
    });

    storeChallenge(userId, options.challenge);

    passkeyLog.info("passkey login options generated", { userId });
    return Response.json(options, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

/** POST /api/auth/passkey/login-verify - verify authentication response (unauthenticated, uses tempToken) */
export async function handlePasskeyLoginVerify(request: Request): Promise<Response> {
  const rateLimitResponse = checkRateLimit(request);
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const body = await request.json() as {
      tempToken?: string;
      response?: AuthenticationResponseJSON;
    };
    if (!body.tempToken || !body.response) {
      return Response.json(
        { error: "tempToken and response are required" },
        { status: 400, headers: corsHeaders },
      );
    }

    const userId = await verifyTempToken(body.tempToken);
    const user = getUserById(userId);
    if (!user) throw new AuthError("Unauthorized");

    const expectedChallenge = getAndDeleteChallenge(userId);
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
    passkeyLog.info("passkey login success", { userId });
    return Response.json(
      { token, user: { id: user.id, username: user.username } },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

/** GET /api/auth/passkey/list - list user's passkeys (authenticated) */
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

/** DELETE /api/auth/passkey/:id - delete a passkey (authenticated) */
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

    const required = isTotpRequired(user);
    if (required) {
      const count = getPasskeyCount(userId);
      if (count <= 1 && !user.totp_enabled) {
        return Response.json(
          { error: "Cannot delete your only passkey while two-factor authentication is required and no authenticator app is configured" },
          { status: 403, headers: corsHeaders },
        );
      }
    }

    deletePasskey(id, userId);
    passkeyLog.info("passkey deleted", { userId, passkeyId: id });
    return Response.json({ deleted: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
