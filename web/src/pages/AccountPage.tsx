import { useState, useEffect } from "react";
import { Link, Navigate } from "react-router";
import { useCurrentUser, useUpdateMe } from "@/api/admin";
import { useDesktopMode } from "@/hooks/use-desktop-mode";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ArrowLeftIcon, MonitorIcon, KeyRoundIcon, ShieldCheckIcon, CheckIcon, EyeIcon, EyeOffIcon, CopyIcon, ClipboardCheckIcon } from "lucide-react";
import { apiFetch } from "@/api/client";
import { totpSetup, totpConfirm, totpDisable, totpStatus } from "@/api/totp";

export function AccountPage() {
  const { data: user } = useCurrentUser();
  const updateMe = useUpdateMe();
  const desktopMode = useDesktopMode();

  if (desktopMode) return <Navigate to="/" replace />;
  if (!user) return null;

  return (
    <div className="flex flex-col h-screen">
      <header className="shrink-0 border-b bg-background/95 backdrop-blur-sm supports-[backdrop-filter]:bg-background/60">
        <div className="flex items-center h-14 px-6 max-w-xl mx-auto w-full gap-3">
          <Button variant="ghost" size="icon-sm" asChild aria-label="Back">
            <Link to="/">
              <ArrowLeftIcon className="size-4" />
            </Link>
          </Button>
          <h1 className="text-sm font-semibold tracking-tight font-display">Account</h1>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-xl mx-auto px-5 py-6 space-y-8">
          <div>
            <p className="text-xs text-muted-foreground">{user.email}</p>
          </div>

          <ChangePasswordSection />

          <TwoFactorSection />

          <section className="space-y-4">
            <div className="flex items-center gap-2">
              <MonitorIcon className="size-4 text-cyan-500" />
              <h3 className="text-sm font-semibold">Companion</h3>
            </div>

            <div className="rounded-lg border p-4">
              <div className="flex items-center justify-between gap-4">
                <div className="space-y-1">
                  <p className="text-sm font-medium">Allow others to use your companion</p>
                  <p className="text-xs text-muted-foreground">
                    When enabled, other project members can use your connected companion for browser and code actions.
                  </p>
                </div>
                <Switch
                  checked={user.companionSharing}
                  onCheckedChange={(checked) =>
                    updateMe.mutate({ companionSharing: checked })
                  }
                  disabled={updateMe.isPending}
                  aria-label="Toggle companion sharing"
                />
              </div>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

function PasswordInput({
  value,
  onChange,
  placeholder,
  onKeyDown,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  onKeyDown?: (e: React.KeyboardEvent) => void;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        onKeyDown={onKeyDown}
        className="pr-9"
      />
      <button
        type="button"
        onClick={() => setVisible(!visible)}
        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        tabIndex={-1}
      >
        {visible ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
      </button>
    </div>
  );
}

function TwoFactorSection() {
  const [step, setStep] = useState<"idle" | "setup" | "confirm" | "backup" | "disable">("idle");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [qrCode, setQrCode] = useState("");
  const [secret, setSecret] = useState("");
  const [code, setCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState<{ enabled: boolean; required: boolean; backupCodesRemaining: number } | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);

  // Fetch status on mount
  useEffect(() => {
    totpStatus()
      .then(setStatus)
      .catch(() => {})
      .finally(() => setStatusLoading(false));
  }, []);

  const handleSetup = async () => {
    setError("");
    setLoading(true);
    try {
      const data = await totpSetup();
      setQrCode(data.qrCode);
      setSecret(data.secret);
      setStep("setup");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setup failed");
    } finally {
      setLoading(false);
    }
  };

  const handleConfirm = async () => {
    setError("");
    setLoading(true);
    try {
      const data = await totpConfirm(code);
      setBackupCodes(data.backupCodes);
      setStep("backup");
      setStatus({ enabled: true, required: status?.required ?? false, backupCodesRemaining: data.backupCodes.length });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Confirmation failed");
    } finally {
      setLoading(false);
    }
  };

  const handleDisable = async () => {
    setError("");
    setLoading(true);
    try {
      await totpDisable(code);
      setStatus({ enabled: false, required: status?.required ?? false, backupCodesRemaining: 0 });
      setStep("idle");
      setCode("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to disable");
    } finally {
      setLoading(false);
    }
  };

  const copyBackupCodes = () => {
    navigator.clipboard.writeText(backupCodes.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (statusLoading) return null;

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <ShieldCheckIcon className="size-4 text-emerald-500" />
        <h3 className="text-sm font-semibold">Two-Factor Authentication</h3>
      </div>

      <div className="rounded-lg border p-4 space-y-4">
        {error && <p className="text-xs text-destructive">{error}</p>}

        {/* Idle — not enabled */}
        {step === "idle" && !status?.enabled && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Add an extra layer of security by requiring a code from your authenticator app when signing in.
            </p>
            <Button onClick={handleSetup} disabled={loading} size="sm">
              {loading ? "Setting up..." : "Enable 2FA"}
            </Button>
          </div>
        )}

        {/* Idle — enabled */}
        {step === "idle" && status?.enabled && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <div className="size-2 rounded-full bg-emerald-500" />
              <p className="text-sm font-medium">Two-factor authentication is enabled</p>
            </div>
            <p className="text-xs text-muted-foreground">
              {status.backupCodesRemaining} backup code{status.backupCodesRemaining !== 1 ? "s" : ""} remaining
            </p>
            {status.required ? (
              <p className="text-xs text-muted-foreground">
                Two-factor authentication is required for your account and cannot be disabled.
              </p>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => { setStep("disable"); setCode(""); setError(""); }}
              >
                Disable 2FA
              </Button>
            )}
          </div>
        )}

        {/* Setup — show QR */}
        {step === "setup" && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Scan this QR code with your authenticator app, then enter the 6-digit code below.
            </p>
            <div className="flex justify-center">
              <img src={qrCode} alt="TOTP QR Code" className="size-48 rounded-lg" />
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Or enter this key manually:</p>
              <code className="block text-xs bg-muted px-3 py-2 rounded select-all break-all">{secret}</code>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Verification code</label>
              <Input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                value={code}
                onChange={(e) => { setCode(e.target.value); setError(""); }}
                placeholder="000000"
                autoFocus
              />
            </div>
            <div className="flex gap-2">
              <Button onClick={handleConfirm} disabled={loading || code.length !== 6} size="sm">
                {loading ? "Verifying..." : "Verify & Enable"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setStep("idle"); setCode(""); setError(""); }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {/* Backup codes */}
        {step === "backup" && (
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <CheckIcon className="size-4 text-emerald-500" />
              <p className="text-sm font-medium">Two-factor authentication enabled</p>
            </div>
            <p className="text-sm text-muted-foreground">
              Save these backup codes in a safe place. Each code can only be used once.
            </p>
            <div className="grid grid-cols-2 gap-2">
              {backupCodes.map((c) => (
                <code key={c} className="text-xs bg-muted px-3 py-1.5 rounded text-center font-mono">
                  {c}
                </code>
              ))}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={copyBackupCodes}>
                {copied ? (
                  <><ClipboardCheckIcon className="size-3.5 mr-1.5" />Copied</>
                ) : (
                  <><CopyIcon className="size-3.5 mr-1.5" />Copy all</>
                )}
              </Button>
              <Button size="sm" onClick={() => { setStep("idle"); setCode(""); }}>
                Done
              </Button>
            </div>
          </div>
        )}

        {/* Disable — confirm with code */}
        {step === "disable" && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Enter your current authenticator code to disable two-factor authentication.
            </p>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Authentication code</label>
              <Input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                value={code}
                onChange={(e) => { setCode(e.target.value); setError(""); }}
                placeholder="000000"
                autoFocus
              />
            </div>
            <div className="flex gap-2">
              <Button
                variant="destructive"
                onClick={handleDisable}
                disabled={loading || code.length !== 6}
                size="sm"
              >
                {loading ? "Disabling..." : "Disable 2FA"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setStep("idle"); setCode(""); setError(""); }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function ChangePasswordSection() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);

  const clearError = () => setError("");

  const handleSubmit = async () => {
    setError("");
    setSuccess(false);

    if (!currentPassword) { setError("Enter your current password"); return; }
    if (newPassword.length < 8) { setError("New password must be at least 8 characters"); return; }
    if (newPassword !== confirmPassword) { setError("Passwords don't match"); return; }

    setSaving(true);
    try {
      await apiFetch("/me", {
        method: "PUT",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update password");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <KeyRoundIcon className="size-4 text-amber-500" />
        <h3 className="text-sm font-semibold">Password</h3>
      </div>

      <div className="rounded-lg border p-4 space-y-4">
        <div className="space-y-1.5">
          <label className="text-sm font-medium">Current password</label>
          <PasswordInput
            value={currentPassword}
            onChange={(v) => { setCurrentPassword(v); clearError(); }}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">New password</label>
            <PasswordInput
              value={newPassword}
              onChange={(v) => { setNewPassword(v); clearError(); }}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Confirm</label>
            <PasswordInput
              value={confirmPassword}
              onChange={(v) => { setConfirmPassword(v); clearError(); }}
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            />
          </div>
        </div>

        {error && <p className="text-xs text-destructive">{error}</p>}

        <div className="flex items-center gap-3 pt-1 border-t">
          <Button
            onClick={handleSubmit}
            disabled={saving || !currentPassword || !newPassword}
            size="sm"
          >
            {success ? (
              <>
                <CheckIcon className="size-3.5 mr-1.5" />
                Updated
              </>
            ) : saving ? "Updating..." : "Change password"}
          </Button>
          <p className="text-[11px] text-muted-foreground">
            Must be at least 8 characters
          </p>
        </div>
      </div>
    </section>
  );
}
