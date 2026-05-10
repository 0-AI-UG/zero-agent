import { useState, useEffect } from "react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { ModelLogo } from "@/components/chat-ui/ModelLogo";
import { useModelStore, type ModelConfig } from "@/stores/model";
import { useModels } from "@/api/models";
import { cn } from "@/lib/utils";

function groupByProvider(list: ModelConfig[]): Record<string, ModelConfig[]> {
  const groups: Record<string, ModelConfig[]> = {};
  for (const model of list) {
    (groups[model.provider] ??= []).push(model);
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

  useEffect(() => {
    if (models.length > 0 && !models.find((m) => m.id === selectedModelId) && selectedModel) {
      setSelectedModelId(selectedModel.id);
    }
  }, [models, selectedModelId, selectedModel, setSelectedModelId]);

  if (!selectedModel) return null;

  const grouped = groupByProvider(models);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
        >
          <ModelLogo provider={selectedModel.provider} className="size-3.5" />
          <span className="text-xs font-medium">{selectedModel.name}</span>
          <ChevronDownIcon className="size-3 opacity-50" />
        </Button>
      </DialogTrigger>

      <DialogContent className="p-0 sm:max-w-md">
        <DialogTitle className="sr-only">Model Selector</DialogTitle>
        <Command className="**:data-[slot=command-input-wrapper]:h-auto">
          <CommandInput placeholder="Search models..." className="h-auto py-3.5" />
          <CommandList>
            <CommandEmpty>No models found.</CommandEmpty>
            {Object.entries(grouped).map(([provider, providerModels]) => (
              <CommandGroup key={provider} heading={providerLabels[provider] ?? provider}>
                {providerModels.map((model) => (
                  <CommandItem
                    key={model.id}
                    value={model.id}
                    keywords={[model.name, model.provider, ...(model.multimodal ? ["vision"] : [])]}
                    onSelect={() => {
                      setSelectedModelId(model.id);
                      setOpen(false);
                    }}
                    className="flex items-center gap-3 py-2.5"
                  >
                    <ModelLogo provider={model.provider} className="size-4 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="flex-1 truncate text-left text-sm font-medium">
                          {model.name}
                        </span>
                        {model.default && (
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
                    </div>
                    <CheckIcon
                      className={cn(
                        "size-4 shrink-0",
                        selectedModelId === model.id ? "opacity-100" : "opacity-0",
                      )}
                    />
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
