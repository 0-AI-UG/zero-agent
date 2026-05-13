/**
 * Admin endpoints for the email feature gate.
 *
 * With per-project mailboxes, the admin surface collapses to a single
 * boolean: "is the email integration allowed?" The actual mailbox config
 * lives per project.
 */
import { corsHeaders } from "@/lib/http/cors.ts";
import { requireAdmin } from "@/lib/auth/auth.ts";
import { getSetting, setSetting } from "@/lib/settings.ts";
import { handleError } from "@/routes/utils.ts";
import { isFeatureEnabled, startAllMailboxes, stopAllMailboxes } from "@/lib/email-global/mailbox.ts";

export async function handleEmailFeatureStatus(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    return Response.json({ enabled: isFeatureEnabled() }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleEmailFeatureToggle(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    const body = (await request.json()) as { enabled?: boolean };
    if (typeof body.enabled !== "boolean") {
      return Response.json({ error: "enabled (boolean) is required" }, { status: 400, headers: corsHeaders });
    }
    setSetting("email_enabled", body.enabled ? "1" : "0");
    if (body.enabled) await startAllMailboxes();
    else await stopAllMailboxes();
    return Response.json({ enabled: isFeatureEnabled() }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

// Legacy aliases kept so older client builds don't 404 mid-deploy.
export const handleEmailStatus = handleEmailFeatureStatus;
export async function handleEmailVerify(_: Request): Promise<Response> {
  return Response.json({ error: "Moved to /api/projects/:id/email/verify" }, { status: 410, headers: corsHeaders });
}
export async function handleEmailRestart(_: Request): Promise<Response> {
  return Response.json({ error: "Moved to /api/projects/:id/email/restart" }, { status: 410, headers: corsHeaders });
}
// Silence unused-import warnings for the env-var fallback (settings.ts already
// supports env-var fallback for getSetting, so admins can enable via env too).
void getSetting;
