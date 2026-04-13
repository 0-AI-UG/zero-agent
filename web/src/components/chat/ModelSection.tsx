import { useState, useEffect } from "react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ModelSelector,
  ModelSelectorTrigger,
  ModelSelectorContent,
  ModelSelectorInput,
  ModelSelectorList,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorItem,
  ModelSelectorLogo,
  ModelSelectorName,
} from "@/components/ai/model-selector";
import { useModelStore, type ModelConfig } from "@/stores/model";
import { useModels } from "@/api/models";
import { cn } from "@/lib/utils";

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${tokens / 1_000_000}M`;
  return `${tokens / 1_000}K`;
}

function formatPrice(price: number): string {
  if (price < 1) return `$${price.toFixed(2)}`;
  return `$${price}`;
}

function groupByProvider(modelList: ModelConfig[]) {
  const groups: Record<string, ModelConfig[]> = {};
  for (const model of modelList) {
    const key = model.provider;
    if (!groups[key]) groups[key] = [];
    groups[key].push(model);
  }
  return groups;
}

const providerLabels: Record<string, string> = {
  minimax: "MiniMax",
  deepseek: "DeepSeek",
  alibaba: "Alibaba / Qwen",
  zhipuai: "Zhipu AI",
  moonshotai: "Moonshot",
  anthropic: "Anthropic",
  google: "Google",
  openai: "OpenAI",
};

export function ModelSection() {
  const [open, setOpen] = useState(false);
  const selectedModelId = useModelStore((s) => s.selectedModelId);
  const setSelectedModelId = useModelStore((s) => s.setSelectedModelId);
  const { data: models = [] } = useModels();

  const selectedModel = models.find((m) => m.id === selectedModelId) ?? models[0];

  // Sync store when persisted selectedModelId no longer exists in the models list
  useEffect(() => {
    if (models.length > 0 && !models.find((m) => m.id === selectedModelId) && selectedModel) {
      setSelectedModelId(selectedModel.id);
    }
  }, [models, selectedModelId, selectedModel, setSelectedModelId]);

  const grouped = groupByProvider(models);

  if (!selectedModel) return null;

  return (
    <ModelSelector open={open} onOpenChange={setOpen}>
      <ModelSelectorTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
        >
          <ModelSelectorLogo
            provider={selectedModel.provider as any}
            className="size-3.5"
          />
          <span className="text-xs font-medium">{selectedModel.name}</span>
          <ChevronDownIcon className="size-3 opacity-50" />
        </Button>
      </ModelSelectorTrigger>

      <ModelSelectorContent className="sm:max-w-md">
        <ModelSelectorInput placeholder="Search models..." />
        <ModelSelectorList>
          <ModelSelectorEmpty>No models found.</ModelSelectorEmpty>
          {Object.entries(grouped).map(([provider, providerModels]) => (
            <ModelSelectorGroup
              key={provider}
              heading={providerLabels[provider] ?? provider}
            >
              {providerModels.map((model) => (
                <ModelSelectorItem
                  key={model.id}
                  value={model.id}
                  keywords={[model.name, model.provider, ...model.tags, ...(model.multimodal ? ["vision"] : [])]}
                  onSelect={() => {
                    setSelectedModelId(model.id);
                    setOpen(false);
                  }}
                  className="flex items-center gap-3 py-2.5"
                >
                  <ModelSelectorLogo
                    provider={model.provider as any}
                    className="size-4 shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <ModelSelectorName className="text-sm font-medium">
                        {model.name}
                      </ModelSelectorName>
                      {model.tags.includes("recommended") && (
                        <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                          Default
                        </span>
                      )}
                      {model.multimodal && (
                        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                          Vision
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground truncate mt-0.5">
                      {model.description}
                    </p>
                    <div className="flex items-center gap-2 mt-1 text-[10px] text-muted-foreground/70">
                      <span>{formatContext(model.contextWindow)} ctx</span>
                      <span>·</span>
                      <span>
                        {formatPrice(model.pricing.input)}/{formatPrice(model.pricing.output)} per 1M tokens
                      </span>
                    </div>
                  </div>
                  <CheckIcon
                    className={cn(
                      "size-4 shrink-0",
                      selectedModelId === model.id ? "opacity-100" : "opacity-0",
                    )}
                  />
                </ModelSelectorItem>
              ))}
            </ModelSelectorGroup>
          ))}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  );
}
