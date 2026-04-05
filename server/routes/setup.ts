import { corsHeaders } from "@/lib/cors.ts";
import { db, generateId } from "@/db/index.ts";
import { createTempToken } from "@/lib/auth.ts";
import { setSetting } from "@/lib/settings.ts";
import { handleError } from "@/routes/utils.ts";
import { log } from "@/lib/logger.ts";

const setupLog = log.child({ module: "setup" });

export function isSetupComplete(): boolean {
  const row = db.query<{ count: number }, []>(
    "SELECT COUNT(*) as count FROM users"
  ).get();
  return (row?.count ?? 0) > 0;
}

export async function handleSetupStatus(_request: Request): Promise<Response> {
  return Response.json(
    { setupComplete: isSetupComplete() },
    { headers: corsHeaders }
  );
}

export async function handleSetupComplete(request: Request): Promise<Response> {
  try {
    const body = await request.json() as Record<string, string>;
    const { openrouterApiKey, openrouterModel, braveSearchApiKey } = body;

    if (!openrouterApiKey) {
      return Response.json(
        { error: "OpenRouter API key is required" },
        { status: 400, headers: corsHeaders }
      );
    }

    if (isSetupComplete()) {
      return Response.json(
        { error: "Setup already completed" },
        { status: 400, headers: corsHeaders }
      );
    }

    const { email, password } = body;

    if (!email || !password) {
      return Response.json(
        { error: "Email and password are required" },
        { status: 400, headers: corsHeaders }
      );
    }

    // Create admin user
    const userId = generateId();
    const passwordHash = await Bun.password.hash(password, "bcrypt");
    db.run(
      "INSERT INTO users (id, email, password_hash, is_admin) VALUES (?, ?, ?, 1)",
      [userId, email, passwordHash]
    );

    // Store settings
    setSetting("OPENROUTER_API_KEY", openrouterApiKey);
    if (openrouterModel) {
      setSetting("OPENROUTER_MODEL", openrouterModel);
    }
    if (braveSearchApiKey) {
      setSetting("BRAVE_SEARCH_API_KEY", braveSearchApiKey);
    }

    // Return temp token — full JWT is only issued after 2FA setup
    const tempToken = await createTempToken(userId);

    setupLog.info("setup completed, awaiting 2FA", { userId, email });

    return Response.json(
      { tempToken, requires2FASetup: true, user: { id: userId, email } },
      { status: 201, headers: corsHeaders }
    );
  } catch (error) {
    return handleError(error);
  }
}
