import { corsHeaders } from "@/lib/http/cors.ts";
import { requireAdmin } from "@/lib/auth/auth.ts";
import { handleError } from "@/routes/utils.ts";
import { getUsageSummary, getUsageByModel, getUsageByUser } from "@/db/queries/usage-logs.ts";

function parseRange(request: Request): { from?: string; to?: string } {
  const url = new URL(request.url);
  const from = url.searchParams.get("from") ?? undefined;
  const to = url.searchParams.get("to") ?? undefined;
  return { from, to };
}

export async function handleUsageSummary(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    const opts = parseRange(request);
    const summary = getUsageSummary(opts);
    return Response.json({ summary }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleUsageByModel(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    const opts = parseRange(request);
    const usage = getUsageByModel(opts);
    return Response.json({ usage }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleUsageByUser(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    const opts = parseRange(request);
    const usage = getUsageByUser(opts);
    return Response.json({ usage }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
