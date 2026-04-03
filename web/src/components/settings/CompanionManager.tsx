import { useState, useRef } from "react";
import {
  useCompanionTokens,
  useCreateCompanionToken,
  useDeleteCompanionToken,
  useCompanionStatus,
} from "@/api/companion";
import { useDesktopMode } from "@/hooks/use-desktop-mode";
import {
  useCredentials,
  useCreateCredential,
  useDeleteCredential,
  useUpdateCredential,
  type Credential,
  type CreateCredentialInput,
  type UpdateCredentialInput,
} from "@/api/credentials";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { MonitorIcon, TrashIcon, CopyIcon, CheckIcon, TerminalSquareIcon, KeyRoundIcon, ShieldCheckIcon, PencilIcon, EyeIcon, EyeOffIcon, FingerprintIcon, SmartphoneIcon, MessageSquareIcon, ImageIcon, AlertTriangleIcon, DownloadIcon, PlayIcon } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { type Project, useUpdateProject } from "@/api/projects";
import { decodeQrImage } from "@/lib/qr-decode";

interface CompanionManagerProps {
  projectId: string;
  project: Project;
  updateProject: ReturnType<typeof useUpdateProject>;
}

export function CompanionManager({ projectId, project, updateProject }: CompanionManagerProps) {
  const desktopMode = useDesktopMode();
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

        {/* Docker/Chrome status warnings (when connected — reported by companion) */}
        {status?.connected && status.dockerRunning === false && (
          <div className="flex items-start gap-2 rounded-md bg-amber-500/10 border border-amber-500/20 px-3 py-2">
            <AlertTriangleIcon className="size-4 text-amber-500 shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
                {status.dockerInstalled ? "Docker is not running" : "Docker is not installed"}
              </p>
              <p className="text-[11px] text-amber-600/80 dark:text-amber-400/70">
                {status.dockerInstalled
                  ? "Start Docker Desktop to enable code execution."
                  : "Install Docker Desktop to enable code execution."}
              </p>
            </div>
          </div>
        )}
        {status?.connected && status.chromeAvailable === false && (
          <div className="flex items-start gap-2 rounded-md bg-amber-500/10 border border-amber-500/20 px-3 py-2">
            <AlertTriangleIcon className="size-4 text-amber-500 shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-medium text-amber-700 dark:text-amber-400">Chrome is not available</p>
              <p className="text-[11px] text-amber-600/80 dark:text-amber-400/70">
                Browser automation requires Google Chrome. Please install it.
              </p>
            </div>
          </div>
        )}


        {!desktopMode && isLoading && (
          <p className="text-xs text-muted-foreground">Loading tokens...</p>
        )}

        {!desktopMode && !isLoading && (!tokens || tokens.length === 0) && (
          <p className="text-xs text-muted-foreground">
            No devices connected yet. Generate a token to link your browser.
          </p>
        )}

        {/* Download or run companion app */}
        {!desktopMode && !status?.connected && (
          tokens?.some((t) => t.lastConnectedAt)
            ? <CompanionRun />
            : <CompanionDownload />
        )}

        {/* Token list */}
        {!desktopMode && tokens && tokens.length > 0 && (
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
        {!desktopMode && (
          <div className="flex items-center gap-2 pt-2 border-t">
            <button
              onClick={() => setCreateOpen(true)}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            >
              Generate token
            </button>
          </div>
        )}

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
              Allow the assistant to run bash commands in a Docker container on the companion machine.
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

      <SavedLogins projectId={projectId} />
    </section>
  );
}

// ── Companion Download ──

type Platform = { os: string; artifact: string } | null;

function detectPlatform(): Platform {
  const ua = navigator.userAgent;
  if (ua.includes("Mac")) return { os: "macOS", artifact: "zero-agent-companion-darwin-arm64.tar.gz" };
  if (ua.includes("Linux")) return { os: "Linux", artifact: "zero-agent-companion-linux-x64.tar.gz" };
  return null;
}

const GITHUB_LATEST = "https://api.github.com/repos/0-AI-UG/zero-agent/releases/latest";

function CompanionDownload() {
  const platform = detectPlatform();
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const handleDownload = async () => {
    if (downloadUrl) {
      window.open(downloadUrl, "_blank");
      return;
    }
    if (!platform) {
      window.open("https://github.com/0-AI-UG/zero-agent/releases/latest", "_blank");
      return;
    }
    setLoading(true);
    setError(false);
    try {
      const res = await fetch(GITHUB_LATEST);
      const release = await res.json();
      const asset = release.assets?.find((a: { name: string }) => a.name === platform.artifact);
      if (asset?.browser_download_url) {
        setDownloadUrl(asset.browser_download_url);
        window.open(asset.browser_download_url, "_blank");
      } else {
        window.open("https://github.com/0-AI-UG/zero-agent/releases/latest", "_blank");
      }
    } catch {
      setError(true);
      window.open("https://github.com/0-AI-UG/zero-agent/releases/latest", "_blank");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-md border p-3 space-y-2.5">
      <p className="text-xs text-muted-foreground">
        Install the companion app to enable browser automation and code execution on your computer.
      </p>
      <button
        onClick={handleDownload}
        disabled={loading}
        className="w-full rounded-md bg-primary hover:bg-primary/90 px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50 flex items-center justify-center gap-2"
      >
        <DownloadIcon className="size-4" />
        {loading ? "Preparing download..." : platform ? `Download for ${platform.os}` : "Download companion"}
      </button>
      {error && (
        <p className="text-[11px] text-muted-foreground text-center">
          Download will open in a new tab.
        </p>
      )}
    </div>
  );
}

function CompanionRun() {
  const handleRun = () => {
    window.location.href = "zero-agent-companion://open";
  };

  return (
    <div className="rounded-md border p-3 space-y-2.5">
      <p className="text-xs text-muted-foreground">
        The companion app is installed but not running. Open it to reconnect.
      </p>
      <button
        onClick={handleRun}
        className="w-full rounded-md bg-primary hover:bg-primary/90 px-4 py-2 text-sm font-medium text-primary-foreground flex items-center justify-center gap-2"
      >
        <PlayIcon className="size-4" />
        Run companion
      </button>
    </div>
  );
}

// ── Saved Accounts ──

interface CredentialFormState {
  label: string;
  siteUrl: string;
  credType: "password" | "passkey";
  username: string;
  password: string;
  totpSecret: string;
  backupCodes: string[];
}

const EMPTY_FORM: CredentialFormState = {
  label: "",
  siteUrl: "",
  credType: "password",
  username: "",
  password: "",
  totpSecret: "",
  backupCodes: [],
};

/** Try to extract a hostname for favicon lookup */
function faviconUrl(siteUrl: string): string | null {
  try {
    const host = siteUrl.includes("://") ? new URL(siteUrl).hostname : siteUrl.replace(/\/.*$/, "");
    return `https://www.google.com/s2/favicons?domain=${host}&sz=32`;
  } catch {
    return null;
  }
}

function SavedLogins({ projectId }: { projectId: string }) {
  const { data: credentials, isLoading } = useCredentials(projectId);
  const createCred = useCreateCredential(projectId);
  const updateCred = useUpdateCredential(projectId);
  const deleteCred = useDeleteCredential(projectId);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<CredentialFormState>({ ...EMPTY_FORM });
  const [formError, setFormError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showTotpFields, setShowTotpFields] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [qrError, setQrError] = useState("");
  const qrFileRef = useRef<HTMLInputElement>(null);


  const openCreate = () => {
    setEditingId(null);
    setForm({ ...EMPTY_FORM });
    setFormError("");
    setShowPassword(false);
    setShowTotpFields(false);
    setQrError("");
    setDialogOpen(true);
  };

  const openEdit = (cred: Credential) => {
    setEditingId(cred.id);
    setForm({
      label: cred.label,
      siteUrl: cred.siteUrl,
      credType: cred.credType,
      username: "",
      password: "",
      totpSecret: "",
      backupCodes: [],
    });
    setShowTotpFields(cred.hasTotp);
    setFormError("");
    setShowPassword(false);
    setQrError("");
    setDialogOpen(true);
  };

  const handleClose = () => {
    setDialogOpen(false);
    setEditingId(null);
    setForm({ ...EMPTY_FORM });
    setFormError("");
  };

  const handleSave = () => {
    if (!form.label.trim()) { setFormError("Give this account a name"); return; }
    if (!form.siteUrl.trim()) { setFormError("Enter the website address"); return; }
    if (form.credType === "password" && !form.username?.trim() && !editingId) { setFormError("Enter your username or email"); return; }
    if (form.credType === "password" && !form.password?.trim() && !editingId) { setFormError("Enter your password"); return; }

    let data: CreateCredentialInput | UpdateCredentialInput;

    if (editingId) {
      if (form.credType === "password") {
        data = {
          label: form.label,
          siteUrl: form.siteUrl,
          credType: "password" as const,
          username: form.username || undefined,
          password: form.password || undefined,
          totpSecret: form.totpSecret?.trim() || undefined,
          backupCodes: form.backupCodes?.length ? form.backupCodes : undefined,
        };
      } else {
        data = {
          label: form.label,
          siteUrl: form.siteUrl,
          credType: "passkey" as const,
        };
      }
      updateCred.mutate({ id: editingId, data: data as UpdateCredentialInput }, {
        onSuccess: () => handleClose(),
        onError: (err: Error) => setFormError(err.message),
      });
    } else {
      data = {
        label: form.label,
        siteUrl: form.siteUrl,
        credType: "password" as const,
        username: form.username,
        password: form.password,
        totpSecret: form.totpSecret?.trim() || undefined,
        backupCodes: form.backupCodes?.length ? form.backupCodes : undefined,
      };
      createCred.mutate(data as CreateCredentialInput, {
        onSuccess: () => handleClose(),
        onError: (err: Error) => setFormError(err.message),
      });
    }
  };

  const handleQrUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setQrError("");
    try {
      const result = await decodeQrImage(file);
      setForm((prev) => ({ ...prev, totpSecret: result.secret }));
    } catch (err) {
      setQrError(err instanceof Error ? err.message : "Failed to decode QR code");
    }
    // Reset file input so same file can be re-selected
    if (qrFileRef.current) qrFileRef.current.value = "";
  };

  const isSaving = createCred.isPending || updateCred.isPending;

  return (
    <>
      <div className="flex items-center gap-2 mt-6">
        <KeyRoundIcon className="size-4 text-amber-500" />
        <h3 className="text-sm font-semibold">Saved Accounts</h3>
      </div>

      <div className="rounded-lg border p-4 space-y-3">
        {isLoading && (
          <div className="flex items-center gap-2 py-3">
            <div className="size-4 rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground animate-spin" />
            <p className="text-xs text-muted-foreground">Loading accounts...</p>
          </div>
        )}

        {!isLoading && (!credentials || credentials.length === 0) && (
          <div className="text-center py-4 space-y-2">
            <div className="mx-auto size-10 rounded-full bg-amber-500/10 flex items-center justify-center">
              <KeyRoundIcon className="size-5 text-amber-500/70" />
            </div>
            <p className="text-xs text-muted-foreground">
              No accounts saved yet
            </p>
            <p className="text-[11px] text-muted-foreground/70">
              Save your website logins so the assistant can sign in for you.
            </p>
          </div>
        )}

        {credentials && credentials.length > 0 && (
          <div className="space-y-1">
            {credentials.map((c) => {
              const favicon = faviconUrl(c.siteUrl);
              const isPasskey = c.credType === "passkey";
              return (
                <div
                  key={c.id}
                  className="group flex items-center gap-3 py-2 px-2 -mx-2 rounded-md hover:bg-muted/50 transition-colors"
                >
                  {/* Site icon */}
                  <div className="size-8 rounded-md bg-muted flex items-center justify-center shrink-0 overflow-hidden">
                    {isPasskey ? (
                      <FingerprintIcon className="size-4 text-violet-500" />
                    ) : favicon ? (
                      <img
                        src={favicon}
                        alt=""
                        className="size-4"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                      />
                    ) : (
                      <KeyRoundIcon className="size-3.5 text-muted-foreground" />
                    )}
                  </div>

                  {/* Info */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-medium truncate">{c.label}</span>
                      {c.hasTotp && (
                        <span title="Two-factor enabled"><ShieldCheckIcon className="size-3 text-emerald-500" /></span>
                      )}
                      {isPasskey && (
                        <span className="text-[10px] font-medium bg-violet-500/10 text-violet-600 px-1.5 py-0.5 rounded">
                          Passkey
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground truncate">
                      {c.siteUrl}
                      <span className="mx-1.5 opacity-40">&middot;</span>
                      {isPasskey ? "Passkey" : "Login & password"}
                    </p>
                  </div>

                  {/* Actions — visible on hover */}
                  <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => openEdit(c)}
                      className="text-muted-foreground hover:text-foreground p-1.5 rounded-md hover:bg-muted"
                      aria-label={`Edit ${c.label}`}
                    >
                      <PencilIcon className="size-3.5" />
                    </button>
                    {confirmDeleteId === c.id ? (
                      <button
                        onClick={() => { deleteCred.mutate(c.id); setConfirmDeleteId(null); }}
                        className="text-destructive text-[10px] font-medium px-2 py-1 rounded-md hover:bg-destructive/10"
                      >
                        Remove?
                      </button>
                    ) : (
                      <button
                        onClick={() => setConfirmDeleteId(c.id)}
                        className="text-muted-foreground hover:text-destructive p-1.5 rounded-md hover:bg-muted"
                        aria-label={`Delete ${c.label}`}
                      >
                        <TrashIcon className="size-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="flex items-center gap-2 pt-2 border-t">
          <button
            onClick={openCreate}
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            Add account
          </button>
        </div>
      </div>

      {/* Add / Edit account dialog */}
      <Dialog open={dialogOpen} onOpenChange={handleClose}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit Account" : "Add Account"}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            {/* Account name & website — side by side on wider screens */}
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="text-xs font-medium mb-1 block">Account name</label>
                <input
                  type="text"
                  placeholder="e.g. Work Gmail"
                  value={form.label}
                  onChange={(e) => { setForm({ ...form, label: e.target.value }); setFormError(""); }}
                  className="w-full rounded-md border bg-background px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
              <div>
                <label className="text-xs font-medium mb-1 block">Website</label>
                <input
                  type="text"
                  placeholder="e.g. accounts.google.com"
                  value={form.siteUrl}
                  onChange={(e) => { setForm({ ...form, siteUrl: e.target.value }); setFormError(""); }}
                  className="w-full rounded-md border bg-background px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
            </div>

            {/* Login type info */}

            {form.credType === "passkey" ? (
              <p className="text-xs text-muted-foreground">
                Only the label and website URL can be edited for passkey credentials.
              </p>
            ) : (
              <div className="space-y-4">
                <div>
                  <label className="text-xs font-medium mb-1 block">Username or email</label>
                  <input
                    type="text"
                    placeholder={editingId ? "Leave blank to keep current" : ""}
                    value={form.username ?? ""}
                    onChange={(e) => setForm({ ...form, username: e.target.value })}
                    className="w-full rounded-md border bg-background px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium mb-1 block">Password</label>
                  <div className="relative">
                    <input
                      type={showPassword ? "text" : "password"}
                      placeholder={editingId ? "Leave blank to keep current" : ""}
                      value={form.password ?? ""}
                      onChange={(e) => setForm({ ...form, password: e.target.value })}
                      className="w-full rounded-md border bg-background px-3 py-1.5 text-xs pr-8 focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showPassword ? <EyeOffIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
                    </button>
                  </div>
                </div>

                {/* Extra verification section */}
                <div className="pt-3 border-t">
                  <button
                    type="button"
                    onClick={() => setShowTotpFields(!showTotpFields)}
                    className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1.5 transition-colors"
                  >
                    <ShieldCheckIcon className="size-3.5" />
                    {showTotpFields ? "Hide extra login steps" : "This site has extra login steps"}
                  </button>

                  {showTotpFields && (
                    <div className="mt-3 space-y-3">
                      <p className="text-[11px] text-muted-foreground">
                        How does this site verify it's you after the password? Set up what applies — the assistant will handle the rest.
                      </p>

                      <input
                        ref={qrFileRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={handleQrUpload}
                      />

                      <div className="grid gap-2 sm:grid-cols-2">
                        {/* ── Authenticator app card ── */}
                        <div className="rounded-lg border p-3 space-y-2">
                          <div className="flex items-center gap-2">
                            <div className="size-7 rounded-full bg-violet-500/10 flex items-center justify-center shrink-0">
                              <SmartphoneIcon className="size-3.5 text-violet-500" />
                            </div>
                            <div>
                              <p className="text-xs font-medium">Authenticator app</p>
                              <p className="text-[10px] text-muted-foreground">Google Authenticator, Authy, etc.</p>
                            </div>
                          </div>

                          {form.totpSecret?.trim() ? (
                            <div className="rounded-md bg-emerald-500/5 border border-emerald-500/20 px-2.5 py-2 flex items-center gap-2">
                              <CheckIcon className="size-3.5 text-emerald-600 shrink-0" />
                              <span className="text-[11px] text-emerald-700 dark:text-emerald-400 font-medium">Linked</span>
                              <button
                                type="button"
                                onClick={() => setForm({ ...form, totpSecret: "" })}
                                className="text-[10px] text-muted-foreground hover:text-foreground ml-auto underline underline-offset-2"
                              >
                                Change
                              </button>
                            </div>
                          ) : (
                            <div className="space-y-1.5">
                              <div className="flex gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => qrFileRef.current?.click()}
                                  className="flex-1 rounded-md border border-dashed px-2 py-1.5 text-[11px] text-muted-foreground hover:text-foreground hover:border-foreground/30 hover:bg-muted/50 transition-colors flex items-center justify-center gap-1.5"
                                >
                                  <ImageIcon className="size-3" />
                                  Upload QR
                                </button>
                                <span className="text-[10px] text-muted-foreground self-center">or</span>
                              </div>
                              <input
                                type="text"
                                placeholder="Paste setup key"
                                value={form.totpSecret ?? ""}
                                onChange={(e) => setForm({ ...form, totpSecret: e.target.value })}
                                className="w-full rounded-md border bg-background px-2.5 py-1.5 text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-ring"
                              />
                              {qrError && (
                                <p className="text-[10px] text-destructive">{qrError}</p>
                              )}
                            </div>
                          )}
                        </div>

                        {/* ── Text message card ── */}
                        <div className="rounded-lg border p-3">
                          <div className="flex items-center gap-2">
                            <div className="size-7 rounded-full bg-amber-500/10 flex items-center justify-center shrink-0">
                              <MessageSquareIcon className="size-3.5 text-amber-500" />
                            </div>
                            <div>
                              <p className="text-xs font-medium">Text message</p>
                              <p className="text-[10px] text-muted-foreground">A code is sent to your phone</p>
                            </div>
                          </div>
                          <div className="rounded-md bg-muted/50 px-2.5 py-2 mt-2">
                            <p className="text-[10px] text-muted-foreground">
                              The assistant will ask you in chat to type the code.
                            </p>
                          </div>
                        </div>

                        {/* ── Backup codes card ── */}
                        <div className="rounded-lg border p-3 space-y-2">
                          <div className="flex items-center gap-2">
                            <div className="size-7 rounded-full bg-zinc-500/10 flex items-center justify-center shrink-0">
                              <KeyRoundIcon className="size-3.5 text-zinc-500" />
                            </div>
                            <div>
                              <p className="text-xs font-medium">Backup codes</p>
                              <p className="text-[10px] text-muted-foreground">One-time fallback codes</p>
                            </div>
                          </div>
                          {(form.backupCodes ?? []).length > 0 ? (
                            <div className="rounded-md bg-emerald-500/5 border border-emerald-500/20 px-2.5 py-2 flex items-center gap-2">
                              <CheckIcon className="size-3.5 text-emerald-600 shrink-0" />
                              <span className="text-[11px] text-emerald-700 dark:text-emerald-400 font-medium">{form.backupCodes!.length} codes saved</span>
                              <button
                                type="button"
                                onClick={() => setForm({ ...form, backupCodes: [] })}
                                className="text-[10px] text-muted-foreground hover:text-foreground ml-auto underline underline-offset-2"
                              >
                                Clear
                              </button>
                            </div>
                          ) : (
                            <textarea
                              placeholder="Paste codes, one per line"
                              value=""
                              onChange={(e) => setForm({ ...form, backupCodes: e.target.value.split("\n").filter(Boolean) })}
                              rows={2}
                              className="w-full rounded-md border bg-background px-2.5 py-1.5 text-[11px] font-mono focus:outline-none focus:ring-1 focus:ring-ring resize-none"
                            />
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {formError && (
              <p className="text-[11px] text-destructive">{formError}</p>
            )}
          </div>

          <DialogFooter>
            <button
              onClick={handleClose}
              className="rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={isSaving}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {isSaving ? "Saving..." : editingId ? "Update" : "Save"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </>
  );
}
