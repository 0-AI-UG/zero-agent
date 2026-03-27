import { corsHeaders } from "@/lib/cors.ts";
import { requireAdmin } from "@/lib/auth.ts";
import { getSetting, setSetting, getAllSettings } from "@/lib/settings.ts";
import { handleError } from "@/routes/utils.ts";

export async function handleGetSettings(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);

    const settings = getAllSettings();

    // Mask sensitive values
    const masked: Record<string, string> = {};
    for (const [key, value] of Object.entries(settings)) {
      if (key.toLowerCase().includes("key") || key.toLowerCase().includes("secret")) {
        masked[key] = value.length > 8 ? value.slice(0, 4) + "..." + value.slice(-4) : "****";
      } else {
        masked[key] = value;
      }
    }

    return Response.json({ settings: masked }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleUpdateSettings(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    const body = await request.json();
    const { settings } = body;

    if (!settings || typeof settings !== "object") {
      return Response.json(
        { error: "settings object is required" },
        { status: 400, headers: corsHeaders }
      );
    }

    for (const [key, value] of Object.entries(settings)) {
      if (typeof value === "string" && value.length > 0) {
        setSetting(key, value);
      }
    }

    return Response.json({ success: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
