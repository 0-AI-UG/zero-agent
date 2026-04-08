import { useState } from "react";
import { useNavigate, useLocation } from "react-router";
import { useAuthStore } from "@/stores/auth";
import { loginApi, passwordResetInit, passwordResetConfirm } from "@/api/auth";
import { totpLogin, totpRecover, totpSetupFromLogin, totpConfirmFromLogin } from "@/api/totp";
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

export function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // 2FA verify state
  const [tempToken, setTempToken] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [recoverMode, setRecoverMode] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");

  // Password reset state
  const [resetMode, setResetMode] = useState(false);
  const [resetCode, setResetCode] = useState("");
  const [resetNewPassword, setResetNewPassword] = useState("");
  const [resetSuccess, setResetSuccess] = useState(false);

  // 2FA setup state (for required setup during login)
  const [setupMode, setSetupMode] = useState(false);
  const [qrCode, setQrCode] = useState("");
  const [secret, setSecret] = useState("");
  const [setupCode, setSetupCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);

  const login = useAuthStore((s) => s.login);
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: Location })?.from?.pathname ?? "/";

  const completeLogin = (token: string, user: { id: string; email: string }) => {
    login(token, user);
    navigate(from, { replace: true });
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const result = await loginApi(email, password);
      if ("requires2FA" in result) {
        setTempToken(result.tempToken);
      } else if ("requires2FASetup" in result) {
        setTempToken(result.tempToken);
        setSetupMode(true);
        // Immediately request TOTP setup
        const data = await totpSetupFromLogin(result.tempToken);
        setQrCode(data.qrCode);
        setSecret(data.secret);
      } else {
        completeLogin(result.token, result.user);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  };

  const handleTotpSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tempToken || !totpCode) return;
    setError(null);
    setLoading(true);

    try {
      const { token, user } = await totpLogin(tempToken, totpCode);
      completeLogin(token, user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
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
      // Store token/user for after backup codes are acknowledged
      setTempToken(result.token);
      // Reuse email field to stash user data
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

  const resetToLogin = () => {
    setTempToken(null);
    setTotpCode("");
    setError(null);
    setRecoverMode(false);
    setRecoveryCode("");
    setSetupMode(false);
    setQrCode("");
    setSecret("");
    setSetupCode("");
    setBackupCodes(null);
    setResetMode(false);
    setResetCode("");
    setResetNewPassword("");
    setResetSuccess(false);
  };

  const handleRecover = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tempToken || !recoveryCode) return;
    setError(null);
    setLoading(true);
    try {
      const { tempToken: reenrollToken } = await totpRecover(tempToken, recoveryCode);
      // Enter re-enroll flow: fetch a fresh setup
      const data = await totpSetupFromLogin(reenrollToken);
      setTempToken(reenrollToken);
      setQrCode(data.qrCode);
      setSecret(data.secret);
      setSetupMode(true);
      setRecoverMode(false);
      setRecoveryCode("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Recovery failed");
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !resetCode || !resetNewPassword) return;
    setError(null);
    setLoading(true);
    try {
      const { tempToken: resetToken } = await passwordResetInit(email);
      await passwordResetConfirm(resetToken, resetCode, resetNewPassword);
      setResetSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Password reset failed");
    } finally {
      setLoading(false);
    }
  };

  // Backup codes screen (after successful setup during login)
  if (backupCodes) {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="font-display">Save Your Backup Codes</CardTitle>
          <CardDescription>
            Two-factor authentication is now enabled. Save these backup codes in a safe place. Each code can only be used once.
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
            <Button size="sm" onClick={handleBackupCodesDone}>
              Continue
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  // 2FA setup screen (required setup during login)
  if (setupMode && tempToken && qrCode) {
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
            {error && (
              <div className="text-sm text-destructive">{error}</div>
            )}
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
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground w-full text-center"
              onClick={resetToLogin}
            >
              Back to login
            </button>
          </form>
        </CardContent>
      </Card>
    );
  }

  // 2FA recovery screen — consume a backup code to re-enroll
  if (tempToken && recoverMode) {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="font-display">Recover Access</CardTitle>
          <CardDescription>
            Enter one of your recovery codes. This will disable your current 2FA and let you set up a new authenticator.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleRecover} className="space-y-4">
            {error && <div className="text-sm text-destructive">{error}</div>}
            <div className="space-y-2">
              <Label htmlFor="recovery-code">Recovery Code</Label>
              <Input
                id="recovery-code"
                type="text"
                maxLength={9}
                value={recoveryCode}
                onChange={(e) => setRecoveryCode(e.target.value)}
                placeholder="XXXX-XXXX"
                autoFocus
                autoComplete="one-time-code"
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading || !recoveryCode}>
              {loading ? "Verifying..." : "Recover & Re-enroll"}
            </Button>
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground w-full text-center"
              onClick={() => { setRecoverMode(false); setRecoveryCode(""); setError(null); }}
            >
              Back
            </button>
          </form>
        </CardContent>
      </Card>
    );
  }

  // 2FA code entry screen (existing TOTP)
  if (tempToken) {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="font-display">Two-Factor Authentication</CardTitle>
          <CardDescription>
            Enter the 6-digit code from your authenticator app.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleTotpSubmit} className="space-y-4">
            {error && (
              <div className="text-sm text-destructive">{error}</div>
            )}
            <div className="space-y-2">
              <Label htmlFor="totp-code">Authentication Code</Label>
              <Input
                id="totp-code"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value)}
                placeholder="000000"
                autoFocus
                autoComplete="one-time-code"
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading || !totpCode}>
              {loading ? "Verifying..." : "Verify"}
            </Button>
            <div className="flex items-center justify-between">
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => { setRecoverMode(true); setError(null); }}
              >
                Lost your device?
              </button>
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={resetToLogin}
              >
                Back to login
              </button>
            </div>
          </form>
        </CardContent>
      </Card>
    );
  }

  // Forgot password screen
  if (resetMode) {
    if (resetSuccess) {
      return (
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle className="font-display">Password Reset</CardTitle>
            <CardDescription>Your password has been updated. You can now sign in.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button className="w-full" onClick={resetToLogin}>Back to sign in</Button>
          </CardContent>
        </Card>
      );
    }
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="font-display">Reset Password</CardTitle>
          <CardDescription>
            Enter your email, a current 6-digit code from your authenticator, and a new password. Password reset requires 2FA to be enabled.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleForgotPassword} className="space-y-4">
            {error && <div className="text-sm text-destructive">{error}</div>}
            <div className="space-y-2">
              <Label htmlFor="reset-email">Email</Label>
              <Input
                id="reset-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="reset-code">Authenticator Code</Label>
              <Input
                id="reset-code"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                value={resetCode}
                onChange={(e) => setResetCode(e.target.value)}
                placeholder="000000"
                autoComplete="one-time-code"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="reset-password">New Password</Label>
              <Input
                id="reset-password"
                type="password"
                value={resetNewPassword}
                onChange={(e) => setResetNewPassword(e.target.value)}
                autoComplete="new-password"
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading || !email || resetCode.length !== 6 || !resetNewPassword}>
              {loading ? "Resetting..." : "Reset Password"}
            </Button>
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground w-full text-center"
              onClick={resetToLogin}
            >
              Back to sign in
            </button>
          </form>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="font-display">Sign In</CardTitle>
        <CardDescription>
          Enter your credentials to access your projects.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleLogin} className="space-y-4">
          {error && (
            <div className="text-sm text-destructive">{error}</div>
          )}
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </div>
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? "Signing in..." : "Sign In"}
          </Button>
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground w-full text-center"
            onClick={() => { setResetMode(true); setError(null); }}
          >
            Forgot password?
          </button>
        </form>
      </CardContent>
    </Card>
  );
}
