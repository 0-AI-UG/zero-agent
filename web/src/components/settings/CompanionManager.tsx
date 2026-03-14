import { useState } from "react";
import {
  useCompanionTokens,
  useCreateCompanionToken,
  useDeleteCompanionToken,
  useCompanionStatus,
} from "@/api/companion";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { MonitorIcon, TrashIcon, CopyIcon, CheckIcon, TerminalSquareIcon } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { type Project, useUpdateProject } from "@/api/projects";

interface CompanionManagerProps {
  projectId: string;
  project: Project;
  updateProject: ReturnType<typeof useUpdateProject>;
}

export function CompanionManager({ projectId, project, updateProject }: CompanionManagerProps) {
  const { data: tokens, isLoading } = useCompanionTokens(projectId);
  const { data: status } = useCompanionStatus(projectId);
  const createToken = useCreateCompanionToken(projectId);
  const deleteToken = useDeleteCompanionToken(projectId);

  const [createOpen, setCreateOpen] = useState(false);
  const [tokenName, setTokenName] = useState("");
  const [createError, setCreateError] = useState("");
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleCreate = () => {
    if (!tokenName.trim()) {
      setCreateError("Name is required");
      return;
    }
    createToken.mutate(tokenName, {
      onSuccess: (data) => {
        setTokenName("");
        setCreateError("");
        setNewToken(data.token.token ?? null);
      },
      onError: (err: Error) => setCreateError(err.message),
    });
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCloseDialog = () => {
    setCreateOpen(false);
    setNewToken(null);
    setTokenName("");
    setCreateError("");
  };

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <MonitorIcon className="size-4 text-cyan-500" />
        <h3 className="text-sm font-semibold">Companion</h3>
      </div>

      <div className="rounded-lg border p-4 space-y-4">
        {/* Connection status */}
        <div className="flex items-center gap-3">
          <span
            className={`size-2 rounded-full ${status?.connected ? "bg-emerald-500" : "bg-zinc-400"}`}
          />
          <span className="text-sm">
            {status?.connected ? "Connected" : "Not connected"}
          </span>
          {status?.connected && status.browserUrl && (
            <span className="text-xs text-muted-foreground truncate">
              {status.browserUrl}
            </span>
          )}
        </div>

        {isLoading && (
          <p className="text-xs text-muted-foreground">Loading tokens...</p>
        )}

        {!isLoading && (!tokens || tokens.length === 0) && (
          <p className="text-xs text-muted-foreground">
            No devices connected yet. Generate a token to link your browser.
          </p>
        )}

        {/* Token list */}
        {tokens && tokens.length > 0 && (
          <div className="space-y-2">
            {tokens.map((t) => (
              <div
                key={t.id}
                className="flex items-center justify-between gap-3 py-1.5"
              >
                <div className="min-w-0">
                  <span className="text-sm font-medium truncate block">
                    {t.name}
                  </span>
                  <div className="flex items-center gap-2">
                    {t.lastConnectedAt && (
                      <p className="text-xs text-muted-foreground">
                        Last active {new Date(t.lastConnectedAt).toLocaleDateString()}
                      </p>
                    )}
                    {t.expiresAt && (
                      <p className={`text-xs ${new Date(t.expiresAt + "Z") < new Date() ? "text-destructive" : "text-muted-foreground"}`}>
                        {new Date(t.expiresAt + "Z") < new Date()
                          ? "Expired"
                          : `Expires ${new Date(t.expiresAt + "Z").toLocaleDateString()}`}
                      </p>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => deleteToken.mutate(t.id)}
                  className="text-muted-foreground hover:text-destructive p-1 shrink-0"
                  aria-label={`Delete token ${t.name}`}
                >
                  <TrashIcon className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2 pt-2 border-t">
          <button
            onClick={() => setCreateOpen(true)}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            Generate token
          </button>
        </div>

        {/* Browser Automation toggle */}
        <div className="flex items-center justify-between gap-4 pt-2 border-t">
          <div className="space-y-1">
            <div className="flex items-center gap-1.5">
              <MonitorIcon className="size-3.5 text-cyan-500" />
              <p className="text-sm font-medium">Browser automation</p>
            </div>
            <p className="text-xs text-muted-foreground">
              Allow the assistant to control the browser in this project.
            </p>
          </div>
          <Switch
            checked={project.browserAutomationEnabled}
            onCheckedChange={() => updateProject.mutate({ browserAutomationEnabled: !project.browserAutomationEnabled })}
            disabled={updateProject.isPending}
            aria-label="Toggle browser automation"
          />
        </div>

        {/* Code Execution toggle */}
        <div className="flex items-center justify-between gap-4 pt-2 border-t">
          <div className="space-y-1">
            <div className="flex items-center gap-1.5">
              <TerminalSquareIcon className="size-3.5 text-green-500" />
              <p className="text-sm font-medium">Code execution</p>
            </div>
            <p className="text-xs text-muted-foreground">
              Allow the assistant to run Python scripts on the companion machine.
            </p>
          </div>
          <Switch
            checked={project.codeExecutionEnabled}
            onCheckedChange={() => updateProject.mutate({ codeExecutionEnabled: !project.codeExecutionEnabled })}
            disabled={updateProject.isPending}
            aria-label="Toggle code execution"
          />
        </div>

      </div>

      {/* Create token dialog */}
      <Dialog open={createOpen} onOpenChange={handleCloseDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {newToken ? "Token Created" : "Connect a Device"}
            </DialogTitle>
          </DialogHeader>

          {newToken ? (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Copy this token and paste it into the companion app. It won't be shown again.
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 bg-muted px-3 py-2 rounded text-xs font-mono break-all select-all">
                  {newToken}
                </code>
                <button
                  onClick={() => handleCopy(newToken)}
                  className="shrink-0 rounded-md border p-2 hover:bg-muted"
                  aria-label="Copy token"
                >
                  {copied ? (
                    <CheckIcon className="size-3.5 text-emerald-500" />
                  ) : (
                    <CopyIcon className="size-3.5" />
                  )}
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                Name this device so you can recognize it later.
              </p>
              <input
                type="text"
                placeholder="e.g. MacBook Pro"
                value={tokenName}
                onChange={(e) => {
                  setTokenName(e.target.value);
                  setCreateError("");
                }}
                className="w-full rounded-md border bg-background px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              />
              {createError && (
                <p className="text-[11px] text-destructive">{createError}</p>
              )}
            </div>
          )}

          <DialogFooter>
            {newToken ? (
              <button
                onClick={handleCloseDialog}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
              >
                Done
              </button>
            ) : (
              <>
                <button
                  onClick={handleCloseDialog}
                  className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreate}
                  disabled={createToken.isPending}
                  className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {createToken.isPending ? "Generating..." : "Generate"}
                </button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
