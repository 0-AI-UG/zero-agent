import { corsHeaders } from "@/lib/cors.ts";
import { createToken } from "@/lib/auth.ts";
import { AuthError } from "@/lib/errors.ts";
import { validateBody, loginSchema } from "@/lib/validation.ts";
import { getUserByEmail } from "@/db/queries/users.ts";
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
