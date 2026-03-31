import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { SettingsIcon, EyeIcon, EyeOffIcon, StarIcon, PlusIcon, TrashIcon } from "lucide-react";
import { apiFetch } from "@/api/client";
import { useAdminModels, useCreateModel, useUpdateModel, useDeleteModel } from "@/api/models";
import { useUsageSummary, useUsageByModel } from "@/api/usage";

function useSettings() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: async () => {
      const res = await apiFetch<{ settings: Record<string, string> }>("/settings");
      return res.settings;
    },
    staleTime: 30_000,
  });
}

function useUpdateSettingsMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ key, value }: { key: string; value: string }) => {
      return apiFetch<{ success: boolean }>(`/settings/${encodeURIComponent(key)}`, {
        method: "PUT",
        body: JSON.stringify({ settings: { [key]: value } }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });
}

function ApiKeyField({
  label,
  settingKey,
  maskedValue,
  onSave,
}: {
  label: string;
  settingKey: string;
  maskedValue: string;
  onSave: (key: string, value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [visible, setVisible] = useState(false);

  if (!editing) {
    return (
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{label}</p>
          <p className="text-xs text-muted-foreground font-mono truncate">
            {maskedValue || "Not set"}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
          {maskedValue ? "Change" : "Set"}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{label}</p>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Input
            type={visible ? "text" : "password"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Enter new value..."
            className="pr-8 text-xs"
          />
          <button
            type="button"
            onClick={() => setVisible(!visible)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            {visible ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
          </button>
        </div>
        <Button
          size="sm"
          onClick={() => {
            if (value.trim()) onSave(settingKey, value.trim());
            setEditing(false);
            setValue("");
          }}
          disabled={!value.trim()}
        >
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setValue(""); }}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function AddModelDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [provider, setProvider] = useState("");
  const [contextWindow, setContextWindow] = useState("128000");
  const [pricingInput, setPricingInput] = useState("");
  const [pricingOutput, setPricingOutput] = useState("");
  const [multimodal, setMultimodal] = useState(false);
  const [error, setError] = useState("");
  const createModel = useCreateModel();

  const handleClose = () => {
    setOpen(false);
    setName("");
    setProvider("");
    setContextWindow("128000");
    setPricingInput("");
    setPricingOutput("");
    setMultimodal(false);
    setError("");
  };

  const handleCreate = () => {
    if (!name.trim()) { setError("Model name is required (e.g. openai/gpt-4o)"); return; }
    createModel.mutate(
      {
        name: name.trim(),
        provider: provider.trim() || name.trim().split("/")[0] || "openrouter",
        contextWindow: parseInt(contextWindow) || 128000,
        pricing: {
          input: parseFloat(pricingInput) || 0,
          output: parseFloat(pricingOutput) || 0,
        },
        multimodal,
        enabled: true,
      },
      {
        onSuccess: handleClose,
        onError: (err: Error) => setError(err.message),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(v) => v ? setOpen(true) : handleClose()}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="text-xs h-7 gap-1">
          <PlusIcon className="size-3" />
          Add Model
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Model</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="space-y-1.5">
            <Label className="text-xs">Model Name</Label>
            <Input
              value={name}
              onChange={(e) => { setName(e.target.value); setError(""); }}
              placeholder="e.g. openai/gpt-4o"
              className="text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Provider</Label>
            <Input
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              placeholder="Auto-detected from name"
              className="text-xs"
            />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Context Window</Label>
              <Input
                value={contextWindow}
                onChange={(e) => setContextWindow(e.target.value)}
                type="number"
                className="text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Price In ($/M tok)</Label>
              <Input
                value={pricingInput}
                onChange={(e) => setPricingInput(e.target.value)}
                type="number"
                step="0.01"
                placeholder="0"
                className="text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Price Out ($/M tok)</Label>
              <Input
                value={pricingOutput}
                onChange={(e) => setPricingOutput(e.target.value)}
                type="number"
                step="0.01"
                placeholder="0"
                className="text-xs"
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={multimodal} onCheckedChange={setMultimodal} />
            <Label className="text-xs">Supports vision/images</Label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={handleClose}>Cancel</Button>
          <Button size="sm" onClick={handleCreate} disabled={createModel.isPending}>
            {createModel.isPending ? "Adding..." : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatCost(cost: number) {
  return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}

function formatTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function DesktopSettingsDialog() {
  const { data: settings } = useSettings();
  const updateSetting = useUpdateSettingsMutation();
  const { data: models } = useAdminModels();
  const updateModel = useUpdateModel();
  const deleteModel = useDeleteModel();
  const { data: summary } = useUsageSummary();
  const { data: usageByModel } = useUsageByModel();

  const handleSaveSetting = (key: string, value: string) => {
    updateSetting.mutate({ key, value });
  };

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Settings">
          <SettingsIcon className="size-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          {/* API Keys */}
          <section className="space-y-3">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">API Keys</h3>
            <div className="space-y-4">
              <ApiKeyField
                label="OpenRouter API Key"
                settingKey="OPENROUTER_API_KEY"
                maskedValue={settings?.OPENROUTER_API_KEY ?? ""}
                onSave={handleSaveSetting}
              />
              <ApiKeyField
                label="Brave Search API Key"
                settingKey="BRAVE_SEARCH_API_KEY"
                maskedValue={settings?.BRAVE_SEARCH_API_KEY ?? ""}
                onSave={handleSaveSetting}
              />
            </div>
          </section>

          {/* Models */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Models{models ? ` (${models.filter((m) => m.enabled).length} enabled)` : ""}
              </h3>
              <AddModelDialog />
            </div>
            {models && models.length > 0 && (
              <div className="space-y-1">
                {models.map((model) => (
                  <div
                    key={model.id}
                    className="flex items-center justify-between gap-3 py-1.5 px-2 rounded-md hover:bg-muted/50 group"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`text-sm truncate ${!model.enabled ? "text-muted-foreground" : ""}`}>
                        {model.name}
                      </span>
                      {model.default && (
                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0 gap-0.5">
                          <StarIcon className="size-2.5" />
                          Default
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      {!model.default && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs h-7 opacity-0 group-hover:opacity-100"
                          onClick={() => updateModel.mutate({ id: model.id, default: true })}
                        >
                          Set default
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs h-7"
                        onClick={() => updateModel.mutate({ id: model.id, enabled: !model.enabled })}
                      >
                        {model.enabled ? "Disable" : "Enable"}
                      </Button>
                      <button
                        className="text-muted-foreground hover:text-destructive p-1 opacity-0 group-hover:opacity-100"
                        onClick={() => deleteModel.mutate(model.id)}
                        aria-label={`Delete ${model.name}`}
                      >
                        <TrashIcon className="size-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Usage */}
          {summary && (
            <section className="space-y-3">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Usage</h3>
              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">Requests</p>
                  <p className="text-lg font-semibold tabular-nums">{summary.totalRequests}</p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">Tokens</p>
                  <p className="text-lg font-semibold tabular-nums">
                    {formatTokens(summary.totalInputTokens + summary.totalOutputTokens)}
                  </p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">Cost</p>
                  <p className="text-lg font-semibold tabular-nums">{formatCost(summary.totalCost)}</p>
                </div>
              </div>

              {usageByModel && usageByModel.length > 0 && (
                <div className="space-y-1">
                  {usageByModel.map((u) => (
                    <div
                      key={u.modelId}
                      className="flex items-center justify-between gap-3 py-1 text-xs"
                    >
                      <span className="truncate text-muted-foreground">{u.modelId}</span>
                      <div className="flex items-center gap-3 shrink-0 tabular-nums">
                        <span>{u.totalRequests} req</span>
                        <span>{formatTokens(u.totalInputTokens + u.totalOutputTokens)} tok</span>
                        <span>{formatCost(u.totalCost)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
