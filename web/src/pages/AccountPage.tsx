import { useState, useEffect } from "react";
import { Link } from "react-router";
import { useCurrentUser } from "@/api/admin";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ArrowLeftIcon, ShieldCheckIcon, CheckIcon, CopyIcon, ClipboardCheckIcon, FingerprintIcon, Trash2Icon } from "lucide-react";
import { totpSetup, totpConfirm, totpDisable, totpStatus } from "@/api/totp";
import { passkeyRegisterOptions, passkeyRegisterVerify, passkeyList, passkeyDelete } from "@/api/passkeys";
import { startRegistration } from "@simplewebauthn/browser";
import { NotificationsCenter } from "@/components/settings/NotificationsCenter";

export function AccountPage() {
  const { data: user } = useCurrentUser();
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
            <p className="text-xs text-muted-foreground">{user.username}</p>
          </div>

          <div className="space-y-2">
            <h2 className="text-sm font-semibold">Two-Factor Authentication</h2>
            <p className="text-sm text-muted-foreground">
              Add a second layer of verification when signing in. You can enable one or both methods.
            </p>
          </div>

          <TwoFactorSection />

          <PasskeySection />

          <NotificationsCenter />
        </div>
      </main>
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
  const [status, setStatus] = useState<{ enabled: boolean; required: boolean; backupCodesRemaining: number; passkeyCount?: number } | null>(null);
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
        <h3 className="text-sm font-semibold">Authenticator App</h3>
      </div>

      <div className="rounded-lg border p-4 space-y-4">
        {error && <p className="text-xs text-destructive">{error}</p>}

        {/* Idle — not enabled */}
        {step === "idle" && !status?.enabled && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Use an authenticator app (e.g. Google Authenticator, 1Password) to generate time-based codes when signing in.
            </p>
            <Button onClick={handleSetup} disabled={loading} size="sm">
              {loading ? "Setting up..." : "Set Up"}
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
            {status.required && (status.passkeyCount ?? 0) === 0 ? (
              <p className="text-xs text-muted-foreground">
                Two-factor authentication is required for your account and cannot be disabled without an alternative method (e.g. passkey).
              </p>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => { setStep("disable"); setCode(""); setError(""); }}
              >
                Disable
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
                {loading ? "Disabling..." : "Disable"}
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

function PasskeySection() {
  const [passkeys, setPasskeys] = useState<{ id: string; deviceName: string; createdAt: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [deviceName, setDeviceName] = useState("");
  const [showNameInput, setShowNameInput] = useState(false);

  const fetchPasskeys = async () => {
    try {
      const data = await passkeyList();
      setPasskeys(data.passkeys);
    } catch {
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchPasskeys(); }, []);

  const handleAdd = async () => {
    setError("");
    setAdding(true);
    try {
      const options = await passkeyRegisterOptions();
      const registration = await startRegistration({ optionsJSON: options });
      await passkeyRegisterVerify(registration, deviceName || "Passkey");
      setDeviceName("");
      setShowNameInput(false);
      await fetchPasskeys();
    } catch (err) {
      if (err instanceof Error && err.name === "NotAllowedError") {
        setError("Passkey registration was cancelled");
      } else {
        setError(err instanceof Error ? err.message : "Failed to add passkey");
      }
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (id: string) => {
    setError("");
    try {
      await passkeyDelete(id);
      setPasskeys((prev) => prev.filter((p) => p.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete passkey");
    }
  };

  if (loading) return null;

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <FingerprintIcon className="size-4 text-blue-500" />
        <h3 className="text-sm font-semibold">Passkeys</h3>
      </div>

      <div className="rounded-lg border p-4 space-y-4">
        {error && <p className="text-xs text-destructive">{error}</p>}

        {passkeys.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Use biometrics (Face ID, Touch ID) or a hardware security key to verify your identity when signing in.
          </p>
        ) : (
          <div className="space-y-2">
            {passkeys.map((p) => (
              <div key={p.id} className="flex items-center justify-between py-2 px-3 rounded-md bg-muted/50">
                <div className="flex items-center gap-2.5">
                  <FingerprintIcon className="size-4 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">{p.deviceName}</p>
                    <p className="text-xs text-muted-foreground">
                      Added {new Date(p.createdAt + "Z").toLocaleDateString()}
                    </p>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => handleDelete(p.id)}
                  aria-label="Delete passkey"
                >
                  <Trash2Icon className="size-3.5 text-muted-foreground" />
                </Button>
              </div>
            ))}
          </div>
        )}

        {showNameInput ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Passkey name</label>
              <Input
                type="text"
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
                placeholder="e.g. MacBook Touch ID"
                autoFocus
              />
            </div>
            <div className="flex gap-2">
              <Button onClick={handleAdd} disabled={adding} size="sm">
                {adding ? "Registering..." : "Register Passkey"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setShowNameInput(false); setDeviceName(""); setError(""); }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button onClick={() => setShowNameInput(true)} size="sm">
            Add Passkey
          </Button>
        )}
      </div>
    </section>
  );
}

