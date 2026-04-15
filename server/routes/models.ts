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
import {
  cliBackendsEnabled,
  isCliInferenceProvider,
} from "@/lib/backends/cli/feature-flag.ts";

function formatModel(m: ModelRow) {
  return {
    id: m.id,
    name: m.name,
    provider: m.provider,
    inferenceProvider: m.inference_provider,
    description: m.description,
    contextWindow: m.context_window,
    pricing: { input: m.pricing_input, output: m.pricing_output },
    tags: JSON.parse(m.tags),
    default: m.is_default === 1,
    multimodal: m.multimodal === 1,
    providerConfig: m.provider_config ? JSON.parse(m.provider_config) : undefined,
    enabled: m.enabled === 1,
    sortOrder: m.sort_order,
  };
}

export async function handleListEnabledModels(request: Request): Promise<Response> {
  try {
    await authenticateRequest(request);
    let models = getEnabledModels();
    if (!cliBackendsEnabled()) {
      models = models.filter((m) => !isCliInferenceProvider(m.inference_provider));
    }
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
      inferenceProvider: body.inferenceProvider,
      description: body.description,
      contextWindow: body.contextWindow,
      pricingInput: body.pricing?.input ?? body.pricingInput,
      pricingOutput: body.pricing?.output ?? body.pricingOutput,
      tags: body.tags,
      isDefault: body.default ?? body.isDefault,
      multimodal: body.multimodal,
      providerConfig: body.providerConfig,
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
    if (body.inferenceProvider !== undefined) data.inferenceProvider = body.inferenceProvider;
    if (body.description !== undefined) data.description = body.description;
    if (body.contextWindow !== undefined) data.contextWindow = body.contextWindow;
    if (body.pricing?.input !== undefined) data.pricingInput = body.pricing.input;
    if (body.pricing?.output !== undefined) data.pricingOutput = body.pricing.output;
    if (body.pricingInput !== undefined) data.pricingInput = body.pricingInput;
    if (body.pricingOutput !== undefined) data.pricingOutput = body.pricingOutput;
    if (body.tags !== undefined) data.tags = body.tags;
    if (body.default !== undefined) data.isDefault = body.default;
    if (body.isDefault !== undefined) data.isDefault = body.isDefault;
    if (body.multimodal !== undefined) data.multimodal = body.multimodal;
    if (body.providerConfig !== undefined) data.providerConfig = body.providerConfig;
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
