import { corsHeaders } from "@/lib/http/cors.ts";
import { authenticateRequest, requireAdmin } from "@/lib/auth/auth.ts";
import { handleError } from "@/routes/utils.ts";
import {
  getAllModels,
  getEnabledModels,
  insertModel,
  updateModel,
  deleteModel,
  type ModelInput,
} from "@/db/queries/models.ts";
import type { ModelRow } from "@/db/types.ts";
import { getModel } from "@mariozechner/pi-ai";

function lookupContextWindow(provider: string, id: string): number | undefined {
  // The DB `provider` column groups models by maker (anthropic, moonshotai, …)
  // but inference is routed through OpenRouter, so model ids are openrouter-format.
  // Try openrouter first, then fall back to the maker provider.
  for (const key of ["openrouter", provider]) {
    try {
      const m = getModel(key as never, id as never) as { contextWindow?: number } | undefined;
      if (m?.contextWindow) return m.contextWindow;
    } catch {
      // unknown (provider, id) combination — try next
    }
  }
  return undefined;
}

function formatModel(m: ModelRow) {
  return {
    id: m.id,
    name: m.name,
    provider: m.provider,
    default: m.is_default === 1,
    multimodal: m.multimodal === 1,
    enabled: m.enabled === 1,
    sortOrder: m.sort_order,
    contextWindow: lookupContextWindow(m.provider, m.id),
  };
}

export async function handleListEnabledModels(request: Request): Promise<Response> {
  try {
    await authenticateRequest(request);
    const models = getEnabledModels();
    return Response.json({ models: models.map(formatModel) }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleListAllModels(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    const models = getAllModels();
    return Response.json({ models: models.map(formatModel) }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleCreateModel(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    const body: any = await request.json();

    if (!body.id || !body.name || !body.provider) {
      return Response.json({ error: "id, name, and provider are required" }, { status: 400, headers: corsHeaders });
    }

    const data: ModelInput = {
      id: body.id,
      name: body.name,
      provider: body.provider,
      isDefault: body.default ?? body.isDefault,
      multimodal: body.multimodal,
      enabled: body.enabled,
      sortOrder: body.sortOrder,
    };

    const model = insertModel(data);
    return Response.json({ model: formatModel(model) }, { status: 201, headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleUpdateModel(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    const body: any = await request.json();

    if (!body.id) {
      return Response.json({ error: "id is required" }, { status: 400, headers: corsHeaders });
    }

    const data: Partial<ModelInput> = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.provider !== undefined) data.provider = body.provider;
    if (body.default !== undefined) data.isDefault = body.default;
    if (body.isDefault !== undefined) data.isDefault = body.isDefault;
    if (body.multimodal !== undefined) data.multimodal = body.multimodal;
    if (body.enabled !== undefined) data.enabled = body.enabled;
    if (body.sortOrder !== undefined) data.sortOrder = body.sortOrder;

    const model = updateModel(body.id, data);
    if (!model) {
      return Response.json({ error: "Model not found" }, { status: 404, headers: corsHeaders });
    }
    return Response.json({ model: formatModel(model) }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}

export async function handleDeleteModel(request: Request): Promise<Response> {
  try {
    await requireAdmin(request);
    const url = new URL(request.url);
    const id = url.searchParams.get("id");

    if (!id) {
      return Response.json({ error: "id query parameter is required" }, { status: 400, headers: corsHeaders });
    }

    const deleted = deleteModel(id);
    if (!deleted) {
      return Response.json({ error: "Model not found" }, { status: 404, headers: corsHeaders });
    }
    return Response.json({ success: true }, { headers: corsHeaders });
  } catch (error) {
    return handleError(error);
  }
}
