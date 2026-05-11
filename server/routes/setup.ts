import bcrypt from "bcrypt";
import { corsHeaders } from "@/lib/http/cors.ts";
import { db, generateId } from "@/db/index.ts";
import { createTempToken, createToken } from "@/lib/auth/auth.ts";
import {
  setAuthCookieHeader,
  setCsrfCookieHeader,
  generateCsrfToken,
} from "@/lib/http/cookies.ts";
import { setSetting } from "@/lib/settings.ts";
import { handleError } from "@/routes/utils.ts";
import { usernameSchema, passwordSchema } from "@/lib/auth/validation.ts";
import { log } from "@/lib/utils/logger.ts";

const setupLog = log.child({ module: "setup" });

const IS_PROD = process.env.NODE_ENV === "production";

export function isSetupComplete(): boolean {
  const row = db.prepare(
    "SELECT COUNT(*) as count FROM users",
  ).get() as { count: number };
  return row.count > 0;
}

export async function handleSetupStatus(_request: Request): Promise<Response> {
  return Response.json(
    { setupComplete: isSetupComplete() },
    { headers: corsHeaders },
  );
}

export async function handleSetupComplete(request: Request): Promise<Response> {
  try {
    const body = await request.json() as Record<string, string>;
    const { openrouterApiKey, openrouterModel, braveSearchApiKey } = body;

    if (!openrouterApiKey) {
      return Response.json(
        { error: "OpenRouter API key is required" },
        { status: 400, headers: corsHeaders },
      );
    }

    const username = usernameSchema.parse(body.username);
    const password = passwordSchema.parse(body.password);
    const passwordHash = await bcrypt.hash(password, 12);
    const userId = generateId();

    // Atomic check + insert prevents the TOCTOU race that would otherwise let
    // a second concurrent request also become admin.
    const transaction = db.transaction(() => {
      const row = db.prepare("SELECT COUNT(*) as count FROM users").get() as { count: number };
      if (row.count > 0) {
        throw new Error("Setup already completed");
      }
      db.prepare(
        "INSERT INTO users (id, username, password_hash, is_admin) VALUES (?, ?, ?, 1)",
      ).run(userId, username, passwordHash);
    });
    try {
      transaction();
    } catch (e) {
      if (e instanceof Error && e.message === "Setup already completed") {
        return Response.json(
          { error: "Setup already completed" },
          { status: 400, headers: corsHeaders },
        );
      }
      throw e;
    }

    setSetting("OPENROUTER_API_KEY", openrouterApiKey);
    if (openrouterModel) setSetting("OPENROUTER_MODEL", openrouterModel);
    if (braveSearchApiKey) setSetting("BRAVE_SEARCH_API_KEY", braveSearchApiKey);

    if (!IS_PROD) {
      // Dev: skip the passkey enrollment ceremony, just issue a session.
      const token = await createToken({ userId, username });
      const csrf = generateCsrfToken();
      const headers = new Headers(corsHeaders);
      headers.append("Set-Cookie", setAuthCookieHeader(token));
      headers.append("Set-Cookie", setCsrfCookieHeader(csrf));
      headers.set("Content-Type", "application/json");
      setupLog.info("setup completed (dev mode)", { userId, username });
      return new Response(
        JSON.stringify({
          token,
          csrfToken: csrf,
          user: { id: userId, username },
        }),
        { status: 201, headers },
      );
    }

    // Production: require passkey enrollment before granting a session.
    const tempToken = await createTempToken(userId, "passkey-enroll");
    setupLog.info("setup completed, awaiting passkey enrollment", { userId, username });
    return Response.json(
      {
        tempToken,
        requires2FASetup: true,
        user: { id: userId, username },
      },
      { status: 201, headers: corsHeaders },
    );
  } catch (error) {
    return handleError(error);
  }
}
