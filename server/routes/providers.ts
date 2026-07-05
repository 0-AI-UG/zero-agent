import { corsHeaders } from "@/lib/http/cors.ts";
import { listProviders } from "@/lib/providers/index.ts";

/**
 * Static list of supported model providers (id, display name, settings key,
 * capabilities). No auth: it contains no secrets and the pre-auth setup
 * wizard needs it to render its provider picker.
 */
export async function handleListProviders(_request: Request): Promise<Response> {
  const providers = listProviders().map((p) => ({
    id: p.id,
    displayName: p.displayName,
    envVar: p.apiKeySettingKey,
    capabilities: p.capabilities,
    defaults: {
      chat: p.defaultModel("chat"),
      embedding: p.defaultModel("embedding"),
      image: p.defaultModel("image"),
      vision: p.defaultModel("vision"),
    },
  }));
  return Response.json({ providers }, { headers: corsHeaders });
}
