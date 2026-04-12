import bcrypt from "bcrypt";
import { TOTP, Secret } from "otpauth";
import QRCode from "qrcode";
import { corsHeaders } from "@/lib/cors.ts";
import { authenticateRequest, createToken, createTempToken, verifyTempToken } from "@/lib/auth.ts";
import { AuthError } from "@/lib/errors.ts";
import { getUserById } from "@/db/queries/users.ts";
import { getSetting } from "@/lib/settings.ts";
import {
  setTotpSecret,
  enableTotp,
  disableTotp,
  getTotpSecret,
  insertBackupCodes,
  getUnusedBackupCodes,
  markBackupCodeUsed,
  getUnusedBackupCodeCount,
} from "@/db/queries/totp.ts";
import { getPasskeyCount } from "@/db/queries/passkeys.ts";
import { handleError } from "@/routes/utils.ts";
import { authRateLimiter, recordAuthFailure } from "@/lib/rate-limit.ts";
import { log } from "@/lib/logger.ts";
import { nanoid } from "nanoid";

const totpLog = log.child({ module: "totp" });

export function createTOTP(secret: string, username: string): TOTP {
  return new TOTP({
    issuer: "ZeroAgent",
    label: username,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  });
}

function generateBackupCodes(count = 8): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    // 8-char alphanumeric codes, grouped as XXXX-XXXX for readability
    const raw = nanoid(8).toUpperCase().replace(/[^A-Z0-9]/g, "X");
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}`);
  }
  return codes;
}

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

/** POST /api/auth/totp/setup - start TOTP setup (authenticated) */
export async function handleTotpSetup(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const user = getUserById(userId);
    if (!user) throw new AuthError("Unauthorized");

    if (user.totp_enabled) {
      return Response.json(
        { error: "TOTP is already enabled" },
        { status: 400, headers: corsHeaders },
      );
    }

    const secret = new Secret({ size: 20 });
    const totp = new TOTP({
      issuer: "ZeroAgent",
      label: user.username,
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret,
    });

    const uri = totp.toString();
    setTotpSecret(userId, secret.base32);

    const qrCode = await QRCode.toDataURL(uri);

    totpLog.info("totp setup initiated", { userId });
    return Response.json(
      { secret: secret.base32, uri, qrCode },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

/** POST /api/auth/totp/confirm - confirm setup with a code (authenticated) */
export async function handleTotpConfirm(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const user = getUserById(userId);
    if (!user) throw new AuthError("Unauthorized");

    const body = await request.json() as { code?: string };
    if (!body.code || body.code.length !== 6) {
      return Response.json(
        { error: "A 6-digit code is required" },
        { status: 400, headers: corsHeaders },
      );
    }

    const secret = getTotpSecret(userId);
    if (!secret) {
      return Response.json(
        { error: "No TOTP setup in progress. Call /setup first." },
        { status: 400, headers: corsHeaders },
      );
    }

    const totp = createTOTP(secret, user.username);
    const delta = totp.validate({ token: body.code, window: 1 });
    if (delta === null) {
      return Response.json(
        { error: "Invalid code. Please try again." },
        { status: 400, headers: corsHeaders },
      );
    }

    // Generate backup codes
    const backupCodes = generateBackupCodes(8);
    const codeHashes = await Promise.all(
      backupCodes.map((code) => bcrypt.hash(code.replace("-", ""), 10)),
    );

    enableTotp(userId);
    insertBackupCodes(userId, codeHashes);

    totpLog.info("totp enabled", { userId });
    return Response.json(
      { enabled: true, backupCodes },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

/** POST /api/auth/totp/login - verify 2FA code during login (unauthenticated) */
export async function handleTotpLogin(request: Request): Promise<Response> {
  const rateLimitResponse = checkRateLimit(request);
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const body = await request.json() as { tempToken?: string; code?: string };
    if (!body.tempToken || !body.code) {
      return Response.json(
        { error: "tempToken and code are required" },
        { status: 400, headers: corsHeaders },
      );
    }

    const userId = await verifyTempToken(body.tempToken);
    const user = getUserById(userId);
    if (!user) throw new AuthError("Unauthorized");

    const secret = getTotpSecret(userId);
    if (!secret) throw new AuthError("TOTP not configured");

    const totp = createTOTP(secret, user.username);
    const delta = totp.validate({ token: body.code, window: 1 });

    if (delta !== null) {
      const token = await createToken({ userId: user.id, username: user.username });
      totpLog.info("totp login success", { userId });
      return Response.json(
        { token, user: { id: user.id, username: user.username } },
        { headers: corsHeaders },
      );
    }

    totpLog.warn("totp login failed - invalid code", { userId });
    recordAuthFailure(request);
    return Response.json(
      { error: "Invalid code" },
      { status: 400, headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

/** POST /api/auth/totp/setup-from-login - setup TOTP during login (unauthenticated, uses temp token) */
export async function handleTotpSetupFromLogin(request: Request): Promise<Response> {
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

    let userId: string;
    try {
      userId = await verifyTempToken(body.tempToken, "2fa");
    } catch {
      userId = await verifyTempToken(body.tempToken, "2fa-reenroll");
    }
    const user = getUserById(userId);
    if (!user) throw new AuthError("Unauthorized");

    if (user.totp_enabled) {
      return Response.json(
        { error: "TOTP is already enabled" },
        { status: 400, headers: corsHeaders },
      );
    }

    const secret = new Secret({ size: 20 });
    const totp = new TOTP({
      issuer: "ZeroAgent",
      label: user.username,
      algorithm: "SHA1",
      digits: 6,
      period: 30,
      secret,
    });

    const uri = totp.toString();
    setTotpSecret(userId, secret.base32);

    const qrCode = await QRCode.toDataURL(uri);

    totpLog.info("totp setup from login initiated", { userId });
    return Response.json(
      { secret: secret.base32, uri, qrCode },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

/** POST /api/auth/totp/confirm-from-login - confirm TOTP setup during login (unauthenticated, uses temp token) */
export async function handleTotpConfirmFromLogin(request: Request): Promise<Response> {
  const rateLimitResponse = checkRateLimit(request);
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const body = await request.json() as { tempToken?: string; code?: string };
    if (!body.tempToken || !body.code || body.code.length !== 6) {
      return Response.json(
        { error: "tempToken and a 6-digit code are required" },
        { status: 400, headers: corsHeaders },
      );
    }

    let userId: string;
    try {
      userId = await verifyTempToken(body.tempToken, "2fa");
    } catch {
      userId = await verifyTempToken(body.tempToken, "2fa-reenroll");
    }
    const user = getUserById(userId);
    if (!user) throw new AuthError("Unauthorized");

    const secret = getTotpSecret(userId);
    if (!secret) {
      return Response.json(
        { error: "No TOTP setup in progress" },
        { status: 400, headers: corsHeaders },
      );
    }

    const totp = createTOTP(secret, user.username);
    const delta = totp.validate({ token: body.code, window: 1 });
    if (delta === null) {
      return Response.json(
        { error: "Invalid code. Please try again." },
        { status: 400, headers: corsHeaders },
      );
    }

    // Generate backup codes
    const backupCodes = generateBackupCodes(8);
    const codeHashes = await Promise.all(
      backupCodes.map((code) => bcrypt.hash(code.replace("-", ""), 10)),
    );

    enableTotp(userId);
    insertBackupCodes(userId, codeHashes);

    // Issue real JWT since setup is complete
    const token = await createToken({ userId: user.id, username: user.username });

    totpLog.info("totp enabled from login", { userId });
    return Response.json(
      { token, user: { id: user.id, username: user.username }, backupCodes },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

/** POST /api/auth/totp/disable - disable TOTP (authenticated) */
export async function handleTotpDisable(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const user = getUserById(userId);
    if (!user) throw new AuthError("Unauthorized");

    // Check if 2FA is required for this user
    const required = user.is_admin === 1 || getSetting("REQUIRE_2FA") === "1";
    if (required && getPasskeyCount(userId) === 0) {
      return Response.json(
        { error: "Two-factor authentication is required and cannot be disabled without an alternative method (e.g. passkey)" },
        { status: 403, headers: corsHeaders },
      );
    }

    if (!user.totp_enabled) {
      return Response.json(
        { error: "TOTP is not enabled" },
        { status: 400, headers: corsHeaders },
      );
    }

    const body = await request.json() as { code?: string };
    if (!body.code) {
      return Response.json(
        { error: "A TOTP code is required to disable 2FA" },
        { status: 400, headers: corsHeaders },
      );
    }

    const secret = getTotpSecret(userId);
    if (!secret) throw new AuthError("TOTP not configured");

    const totp = createTOTP(secret, user.username);
    const delta = totp.validate({ token: body.code, window: 1 });
    if (delta === null) {
      return Response.json(
        { error: "Invalid code" },
        { status: 400, headers: corsHeaders },
      );
    }

    disableTotp(userId);
    totpLog.info("totp disabled", { userId });
    return Response.json({ disabled: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

/** POST /api/auth/totp/recover - consume a backup code to wipe 2FA and get a re-enroll token */
export async function handleTotpRecover(request: Request): Promise<Response> {
  const rateLimitResponse = checkRateLimit(request);
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const body = await request.json() as { tempToken?: string; code?: string };
    if (!body.tempToken || !body.code) {
      return Response.json(
        { error: "tempToken and code are required" },
        { status: 400, headers: corsHeaders },
      );
    }

    const userId = await verifyTempToken(body.tempToken, "2fa");
    const user = getUserById(userId);
    if (!user) throw new AuthError("Unauthorized");

    const normalizedCode = body.code.replace(/-/g, "");
    const unusedCodes = getUnusedBackupCodes(userId);
    for (const bc of unusedCodes) {
      const match = await bcrypt.compare(normalizedCode, bc.code_hash);
      if (match) {
        markBackupCodeUsed(bc.id);
        // Wipe current TOTP secret + all backup codes; user must re-enroll
        disableTotp(userId);
        const reenrollToken = await createTempToken(userId, "2fa-reenroll");
        totpLog.info("totp recovery via backup code", { userId, backupCodeId: bc.id });
        return Response.json(
          { tempToken: reenrollToken },
          { headers: corsHeaders },
        );
      }
    }

    totpLog.warn("totp recovery failed - invalid backup code", { userId });
    recordAuthFailure(request);
    return Response.json(
      { error: "Invalid recovery code" },
      { status: 400, headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

/** GET /api/auth/totp/status - check TOTP status (authenticated) */
export async function handleTotpStatus(request: Request): Promise<Response> {
  try {
    const { userId } = await authenticateRequest(request);
    const user = getUserById(userId);
    if (!user) throw new AuthError("Unauthorized");

    const enabled = user.totp_enabled === 1;
    const required = user.is_admin === 1 || getSetting("REQUIRE_2FA") === "1";
    const backupCodesRemaining = enabled ? getUnusedBackupCodeCount(userId) : 0;
    const passkeyCount = getPasskeyCount(userId);

    return Response.json(
      { enabled, required, backupCodesRemaining, passkeyCount },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}
