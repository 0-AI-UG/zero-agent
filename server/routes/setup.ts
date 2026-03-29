import { corsHeaders } from "@/lib/cors.ts";
import { db, generateId } from "@/db/index.ts";
import { createToken } from "@/lib/auth.ts";
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
    if (isSetupComplete()) {
      return Response.json(
        { error: "Setup already completed" },
        { status: 400, headers: corsHeaders }
      );
    }

    const body = await request.json();
    const { email, password, openrouterApiKey, openrouterModel, braveSearchApiKey } = body;

    if (!email || !password) {
      return Response.json(
        { error: "Email and password are required" },
        { status: 400, headers: corsHeaders }
      );
    }

    if (!openrouterApiKey) {
      return Response.json(
        { error: "OpenRouter API key is required" },
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

    // Create JWT token
    const token = await createToken({ userId, email });

    setupLog.info("setup completed", { userId, email });

    return Response.json(
      { token, user: { id: userId, email } },
      { status: 201, headers: corsHeaders }
    );
  } catch (error) {
    return handleError(error);
  }
}
