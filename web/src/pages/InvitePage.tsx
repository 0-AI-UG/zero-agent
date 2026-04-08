import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router";
import { useAuthStore } from "@/stores/auth";
import {
  lookupInvitation,
  acceptInvitation,
  type InvitationLookup,
} from "@/api/user-invitations";
import { totpSetupFromLogin, totpConfirmFromLogin } from "@/api/totp";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { CopyIcon, ClipboardCheckIcon } from "lucide-react";

export function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const login = useAuthStore((s) => s.login);

  const [lookup, setLookup] = useState<InvitationLookup | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 2FA setup state (when admin requires 2FA)
  const [tempToken, setTempToken] = useState<string | null>(null);
  const [qrCode, setQrCode] = useState("");
  const [secret, setSecret] = useState("");
  const [setupCode, setSetupCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!token) return;
    lookupInvitation(token)
      .then(setLookup)
      .catch((err) => setLookupError(err instanceof Error ? err.message : "Failed to load"));
  }, [token]);

  const completeLogin = (authToken: string, user: { id: string; email: string }) => {
    login(authToken, user);
    navigate("/", { replace: true });
  };

  const handleAccept = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setError(null);
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }
    setLoading(true);
    try {
      const result = await acceptInvitation(token, password);
      if ("requires2FASetup" in result) {
        setTempToken(result.tempToken);
        const data = await totpSetupFromLogin(result.tempToken);
        setQrCode(data.qrCode);
        setSecret(data.secret);
      } else {
        completeLogin(result.token, result.user);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to accept invitation");
    } finally {
      setLoading(false);
    }
  };

  const handleSetupConfirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tempToken || setupCode.length !== 6) return;
    setError(null);
    setLoading(true);
    try {
      const result = await totpConfirmFromLogin(tempToken, setupCode);
      setBackupCodes(result.backupCodes);
      (window as any).__pendingLogin = { token: result.token, user: result.user };
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setLoading(false);
    }
  };

  const handleBackupCodesDone = () => {
    const pending = (window as any).__pendingLogin;
    if (pending) {
      delete (window as any).__pendingLogin;
      completeLogin(pending.token, pending.user);
    }
  };

  const copyBackupCodes = () => {
    if (backupCodes) {
      navigator.clipboard.writeText(backupCodes.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  if (lookupError) {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="font-display">Invitation unavailable</CardTitle>
          <CardDescription>{lookupError}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (!lookup) {
    return (
      <Card className="w-full max-w-sm">
        <CardContent className="py-8 text-center text-sm text-muted-foreground">Loading…</CardContent>
      </Card>
    );
  }

  if (!lookup.valid) {
    const reasonText =
      lookup.reason === "expired"
        ? "This invitation has expired. Ask your admin to send a new one."
        : lookup.reason === "already_accepted"
        ? "This invitation has already been used."
        : "This invitation is invalid.";
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="font-display">Invitation unavailable</CardTitle>
          <CardDescription>{reasonText}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" className="w-full" onClick={() => navigate("/login")}>
            Go to sign in
          </Button>
        </CardContent>
      </Card>
    );
  }

  // Backup codes screen
  if (backupCodes) {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="font-display">Save Your Backup Codes</CardTitle>
          <CardDescription>
            Two-factor authentication is now enabled. Save these backup codes — each can only be used once.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
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
            <Button size="sm" onClick={handleBackupCodesDone}>Continue</Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  // 2FA setup screen
  if (tempToken && qrCode) {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="font-display">Set Up Two-Factor Authentication</CardTitle>
          <CardDescription>
            Your account requires two-factor authentication. Scan this QR code with your authenticator app, then enter the 6-digit code.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSetupConfirm} className="space-y-4">
            {error && <div className="text-sm text-destructive">{error}</div>}
            <div className="flex justify-center">
              <img src={qrCode} alt="TOTP QR Code" className="size-48 rounded-lg" />
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Or enter this key manually:</p>
              <code className="block text-xs bg-muted px-3 py-2 rounded select-all break-all">{secret}</code>
            </div>
            <div className="space-y-2">
              <Label htmlFor="setup-code">Verification Code</Label>
              <Input
                id="setup-code"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                value={setupCode}
                onChange={(e) => { setSetupCode(e.target.value); setError(null); }}
                placeholder="000000"
                autoFocus
                autoComplete="one-time-code"
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading || setupCode.length !== 6}>
              {loading ? "Verifying..." : "Verify & Enable"}
            </Button>
          </form>
        </CardContent>
      </Card>
    );
  }

  // Password setup screen
  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="font-display">Accept Invitation</CardTitle>
        <CardDescription>
          Create a password for <span className="font-medium text-foreground">{lookup.email}</span>.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleAccept} className="space-y-4">
          {error && <div className="text-sm text-destructive">{error}</div>}
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="new-password"
              minLength={8}
            />
            <p className="text-[11px] text-muted-foreground">
              Must be 8+ characters with uppercase, lowercase, and a number.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm">Confirm password</Label>
            <Input
              id="confirm"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              autoComplete="new-password"
            />
          </div>
          <Button type="submit" className="w-full" disabled={loading || !password || !confirm}>
            {loading ? "Creating account..." : "Create account"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
