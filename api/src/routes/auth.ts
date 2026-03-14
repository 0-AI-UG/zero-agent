import { corsHeaders } from "@/lib/cors.ts";
import { createToken } from "@/lib/auth.ts";
import { AuthError, ConflictError } from "@/lib/errors.ts";
import { validateBody, registerSchema, loginSchema } from "@/lib/validation.ts";
import { insertUser, getUserByEmail } from "@/db/queries/users.ts";
import { resolveByEmail } from "@/db/queries/invitations.ts";
import { insertNotification } from "@/db/queries/notifications.ts";
import { getProjectById } from "@/db/queries/projects.ts";
import { handleError } from "@/routes/utils.ts";
import { authRateLimiter } from "@/lib/rate-limit.ts";
import { log } from "@/lib/logger.ts";
import crypto from "node:crypto";

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

export async function handleRegister(request: Request): Promise<Response> {
  const rateLimitResponse = checkRateLimit(request);
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const body = await validateBody(request, registerSchema);
    authLog.info("register attempt", { email: body.email });

    const expectedToken = process.env.INVITE_TOKEN;
    if (!expectedToken) {
      authLog.error("INVITE_TOKEN not configured");
      throw new AuthError("Registration is currently disabled");
    }

    const tokenA = Buffer.from(body.inviteToken);
    const tokenB = Buffer.from(expectedToken);
    if (tokenA.length !== tokenB.length || !crypto.timingSafeEqual(tokenA, tokenB)) {
      authLog.warn("register failed - invalid invite token", { email: body.email });
      throw new AuthError("Invalid invite token");
    }

    const existing = getUserByEmail(body.email);
    if (existing) {
      authLog.warn("register conflict", { email: body.email });
      throw new ConflictError("Email already registered");
    }

    const passwordHash = await Bun.password.hash(body.password, "bcrypt");
    const user = insertUser(body.email, passwordHash);
    const token = await createToken({ userId: user.id, email: user.email });

    // Resolve any pending invitations for this email
    const resolved = resolveByEmail(body.email, user.id);
    for (const inv of resolved) {
      const project = getProjectById(inv.project_id);
      insertNotification(user.id, "invite", {
        invitationId: inv.id,
        projectId: inv.project_id,
        projectName: project?.name ?? "Unknown",
      });
    }

    authLog.info("register success", { userId: user.id, email: user.email });
    return Response.json(
      {
        token,
        user: { id: user.id, email: user.email },
      },
      { status: 201, headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
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

    const valid = await Bun.password.verify(body.password, user.password_hash);
    if (!valid) {
      authLog.warn("login failed - wrong password", { email: body.email });
      throw new AuthError("Invalid email or password");
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
