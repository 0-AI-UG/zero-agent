import bcrypt from "bcrypt";
import { corsHeaders } from "@/lib/http/cors.ts";
import { db, generateId } from "@/db/index.ts";
import { createTempToken, createToken } from "@/lib/auth/auth.ts";
import { setSetting } from "@/lib/settings.ts";
import { handleError } from "@/routes/utils.ts";
import { usernameSchema, passwordSchema } from "@/lib/auth/validation.ts";
import { log } from "@/lib/utils/logger.ts";

const setupLog = log.child({ module: "setup" });

export function isSetupComplete(): boolean {
  const row = db.prepare(
    "SELECT COUNT(*) as count FROM users"
  ).get() as { count: number };
  return row.count > 0;
}

export async function handleSetupStatus(_request: Request): Promise<Response> {
  return Response.json(
    { setupComplete: isSetupComplete() },
    { headers: corsHeaders }
  );
}

export async function handleSetupComplete(request: Request): Promise<Response> {
  try {
    if (isSetupComplete()) {
      return Response.json(
        { error: "Setup already completed" },
        { status: 400, headers: corsHeaders }
      );
    }

    const body = await request.json() as Record<string, string>;
    const { openrouterApiKey, openrouterModel, braveSearchApiKey } = body;

    if (!openrouterApiKey) {
      return Response.json(
        { error: "OpenRouter API key is required" },
        { status: 400, headers: corsHeaders }
      );
    }

    const username = usernameSchema.parse(body.username);
    const password = passwordSchema.parse(body.password);

    // Create admin user
    const userId = generateId();
    const passwordHash = await bcrypt.hash(password, 10);
    db.prepare(
      "INSERT INTO users (id, username, password_hash, is_admin) VALUES (?, ?, ?, 1)"
    ).run(userId, username, passwordHash);

    // Store settings
    setSetting("OPENROUTER_API_KEY", openrouterApiKey);
    if (openrouterModel) setSetting("OPENROUTER_MODEL", openrouterModel);
    if (braveSearchApiKey) setSetting("BRAVE_SEARCH_API_KEY", braveSearchApiKey);

    const isDev = process.env.NODE_ENV !== "production";
    if (isDev) {
      const token = await createToken({ userId, username });
      setupLog.info("setup completed (dev mode, skipping 2FA)", { userId, username });
      return Response.json(
        { token, user: { id: userId, username } },
        { status: 201, headers: corsHeaders }
      );
    }

    // Return temp token - full JWT is only issued after 2FA setup
    const tempToken = await createTempToken(userId);

    setupLog.info("setup completed, awaiting 2FA", { userId, username });

    return Response.json(
      { tempToken, requires2FASetup: true, user: { id: userId, username } },
      { status: 201, headers: corsHeaders }
    );
  } catch (error) {
    return handleError(error);
  }
}
