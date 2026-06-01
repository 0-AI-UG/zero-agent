import { authenticateRequest } from "@/lib/auth/auth.ts";
import { corsHeaders } from "@/lib/http/cors.ts";
import { handleError, verifyProjectAccess, requireHumanSession } from "@/routes/utils.ts";
import { ValidationError, NotFoundError } from "@/lib/utils/errors.ts";
import { RateLimiter, getClientIP } from "@/lib/http/rate-limit.ts";
import {
  createDeviceAuthRequest,
  getDeviceAuthByDeviceCode,
  getDeviceAuthByUserCode,
  approveDeviceAuthRequest,
  denyDeviceAuthRequest,
  deleteDeviceAuthRequest,
  isDeviceAuthExpired,
} from "@/db/queries/device-auth.ts";
import { createCompanionToken } from "@/db/queries/companion-tokens.ts";
import { getProjectById } from "@/db/queries/projects.ts";

/**
 * Device-authorization flow for `zero login` (RFC 8628 style).
 *
 *   start  → CLI, unauthenticated. Creates a pending request, hands back the
 *            secret device_code (CLI polls with it) and the 6-digit user_code
 *            the human types into the web app.
 *   poll   → CLI, unauthenticated. Trades the device_code for status, and once
 *            approved, the minted companion token (exactly once).
 *   info   → web, session-auth. Describes a request by user_code for the
 *            approval page.
 *   approve/deny → web, session-auth. The logged-in user picks a project and
 *            mints (or refuses) the token.
 *
 * The device_code is the capability the CLI holds; the user_code is only 6
 * digits, so the session routes are rate-limited per user to keep that space
 * unguessable within the 10-minute expiry.
 */

const POLL_INTERVAL_SECONDS = 5;

// Generous on the CLI poll (one device_code, every ~5s) and start-by-IP; tight
// on the human-typed lookups to defeat user_code enumeration.
const startLimiter = new RateLimiter(30, 15 * 60 * 1000);
const pollLimiter = new RateLimiter(120, 60 * 1000);
const lookupLimiter = new RateLimiter(30, 15 * 60 * 1000);
// Burned only on a *missed* user_code. A legitimate approver hits the right
// code on the first try and never trips this; an enumerator guessing the
// 6-digit space is cut off after a handful of misses, regardless of how many
// accounts they spread the per-user `lookupLimiter` budget across.
const failedLookupLimiter = new RateLimiter(8, 15 * 60 * 1000);

function tooMany(retryAfterSeconds: number): Response {
  return Response.json(
    { error: "Too many requests. Please slow down." },
    { status: 429, headers: { ...corsHeaders, "Retry-After": String(retryAfterSeconds) } },
  );
}

// Public origin to send the user to, honouring reverse-proxy headers (mirrors
// routes/install.ts).
function publicOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host;
  const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(/:$/, "");
  return `${proto}://${host}`;
}

/** POST /api/companion/device/start — begin a device login (unauthenticated). */
export async function handleDeviceStart(request: Request): Promise<Response> {
  try {
    const ip = getClientIP(request);
    const limit = startLimiter.check(ip);
    if (!limit.allowed) return tooMany(limit.retryAfterSeconds);
    startLimiter.record(ip);

    const body = (await request.json().catch(() => ({}))) as { deviceName?: string };
    const deviceName = typeof body.deviceName === "string" ? body.deviceName.slice(0, 64) : null;

    const row = createDeviceAuthRequest(deviceName);
    const origin = publicOrigin(request);
    return Response.json(
      {
        deviceCode: row.device_code,
        userCode: row.user_code,
        verificationUri: `${origin}/device`,
        verificationUriComplete: `${origin}/device?code=${row.user_code}`,
        interval: POLL_INTERVAL_SECONDS,
        expiresInSeconds: Math.max(
          0,
          Math.round((new Date(`${row.expires_at}Z`).getTime() - Date.now()) / 1000),
        ),
      },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

/** POST /api/companion/device/poll — exchange a device_code for status/token. */
export async function handleDevicePoll(request: Request): Promise<Response> {
  try {
    const body = (await request.json().catch(() => ({}))) as { deviceCode?: string };
    const deviceCode = body.deviceCode;
    if (!deviceCode) throw new ValidationError("deviceCode is required");

    const limit = pollLimiter.check(deviceCode);
    if (!limit.allowed) return tooMany(limit.retryAfterSeconds);
    pollLimiter.record(deviceCode);

    const row = getDeviceAuthByDeviceCode(deviceCode);
    // Unknown or expired requests look the same to the CLI: nothing to wait on.
    if (!row || isDeviceAuthExpired(row)) {
      return Response.json({ status: "expired" }, { headers: corsHeaders });
    }
    if (row.status === "denied") {
      return Response.json({ status: "denied" }, { headers: corsHeaders });
    }
    if (row.status === "pending") {
      return Response.json({ status: "pending" }, { headers: corsHeaders });
    }

    // Approved: hand back the stashed token exactly once, then consume the row
    // (which also erases the only copy of the raw secret).
    if (!row.minted_token || !row.project_id) {
      deleteDeviceAuthRequest(row.id);
      return Response.json({ status: "expired" }, { headers: corsHeaders });
    }
    const project = getProjectById(row.project_id);
    const token = row.minted_token;
    deleteDeviceAuthRequest(row.id);
    return Response.json(
      {
        status: "approved",
        token,
        projectId: row.project_id,
        projectName: project?.name ?? null,
        baseUrl: publicOrigin(request),
      },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

/** GET /api/companion/device/info?userCode=… — describe a request (session-auth). */
export async function handleDeviceInfo(request: Request): Promise<Response> {
  try {
    const payload = await authenticateRequest(request);
    requireHumanSession(payload);

    const limit = lookupLimiter.check(payload.userId);
    if (!limit.allowed) return tooMany(limit.retryAfterSeconds);
    lookupLimiter.record(payload.userId);
    const miss = failedLookupLimiter.check(payload.userId);
    if (!miss.allowed) return tooMany(miss.retryAfterSeconds);

    const userCode = new URL(request.url).searchParams.get("userCode")?.trim();
    if (!userCode) throw new ValidationError("userCode is required");

    const row = getDeviceAuthByUserCode(userCode);
    if (!row || isDeviceAuthExpired(row) || row.status !== "pending") {
      failedLookupLimiter.record(payload.userId);
      throw new NotFoundError("No pending login for that code");
    }
    return Response.json(
      { deviceName: row.device_name, status: row.status },
      { headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}

/** POST /api/companion/device/approve — mint a token for the chosen project. */
export async function handleDeviceApprove(request: Request): Promise<Response> {
  try {
    const payload = await authenticateRequest(request);
    requireHumanSession(payload);

    const limit = lookupLimiter.check(payload.userId);
    if (!limit.allowed) return tooMany(limit.retryAfterSeconds);
    lookupLimiter.record(payload.userId);
    const miss = failedLookupLimiter.check(payload.userId);
    if (!miss.allowed) return tooMany(miss.retryAfterSeconds);

    const body = (await request.json().catch(() => ({}))) as {
      userCode?: string;
      projectId?: string;
    };
    const userCode = body.userCode?.trim();
    const projectId = body.projectId?.trim();
    if (!userCode || !projectId) {
      throw new ValidationError("userCode and projectId are required");
    }

    const row = getDeviceAuthByUserCode(userCode);
    if (!row || isDeviceAuthExpired(row) || row.status !== "pending") {
      failedLookupLimiter.record(payload.userId);
      throw new NotFoundError("No pending login for that code");
    }
    const project = verifyProjectAccess(projectId, payload.userId);

    const token = createCompanionToken(payload.userId, projectId, row.device_name ?? "companion");
    approveDeviceAuthRequest(row.id, payload.userId, projectId, token.id, token.token);

    return Response.json({ ok: true, projectName: project.name }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

/** POST /api/companion/device/deny — refuse a pending login (session-auth). */
export async function handleDeviceDeny(request: Request): Promise<Response> {
  try {
    const payload = await authenticateRequest(request);
    requireHumanSession(payload);

    const limit = lookupLimiter.check(payload.userId);
    if (!limit.allowed) return tooMany(limit.retryAfterSeconds);
    lookupLimiter.record(payload.userId);
    const miss = failedLookupLimiter.check(payload.userId);
    if (!miss.allowed) return tooMany(miss.retryAfterSeconds);

    const body = (await request.json().catch(() => ({}))) as { userCode?: string };
    const userCode = body.userCode?.trim();
    if (!userCode) throw new ValidationError("userCode is required");

    const row = getDeviceAuthByUserCode(userCode);
    if (row && row.status === "pending") denyDeviceAuthRequest(row.id);
    else failedLookupLimiter.record(payload.userId);
    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
