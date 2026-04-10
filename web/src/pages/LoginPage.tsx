import { useState } from "react";
import { useNavigate, useLocation } from "react-router";
import { useAuthStore } from "@/stores/auth";
import { loginApi, passwordResetInit, passwordResetConfirm, passwordResetPasskeyOptions, passwordResetPasskeyConfirm } from "@/api/auth";
import { totpLogin, totpRecover, totpSetupFromLogin, totpConfirmFromLogin } from "@/api/totp";
import { passkeyLoginOptions, passkeyLoginVerify } from "@/api/passkeys";
import { startAuthentication } from "@simplewebauthn/browser";
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
import { CopyIcon, ClipboardCheckIcon, FingerprintIcon, SmartphoneIcon } from "lucide-react";

export function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // 2FA verify state
  const [tempToken, setTempToken] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [recoverMode, setRecoverMode] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");
  const [availableMethods, setAvailableMethods] = useState<{ totp: boolean; passkey: boolean } | null>(null);
  const [chosenMethod, setChosenMethod] = useState<"totp" | "passkey" | null>(null);

  // Password reset state
  const [resetMode, setResetMode] = useState(false);
  const [resetToken, setResetToken] = useState<string | null>(null);
  const [resetMethods, setResetMethods] = useState<{ totp: boolean; passkey: boolean } | null>(null);
  const [resetChosenMethod, setResetChosenMethod] = useState<"totp" | "passkey" | null>(null);
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

  const completeLogin = (token: string, user: { id: string; username: string }) => {
    login(token, user);
    navigate(from, { replace: true });
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const result = await loginApi(username, password);
      if ("requires2FA" in result) {
        setTempToken(result.tempToken);
        const methods = result.methods ?? { totp: true, passkey: false };
        setAvailableMethods(methods);
        // If only one method, go directly to it
        if (methods.totp && !methods.passkey) {
          setChosenMethod("totp");
        } else if (methods.passkey && !methods.totp) {
          setChosenMethod("passkey");
        }
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
      // Reuse username field to stash user data
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

  const handlePasskeyLogin = async () => {
    if (!tempToken) return;
    setError(null);
    setLoading(true);
    try {
      const options = await passkeyLoginOptions(tempToken);
      const assertion = await startAuthentication({ optionsJSON: options });
      const { token, user } = await passkeyLoginVerify(tempToken, assertion);
      completeLogin(token, user);
    } catch (err) {
      if (err instanceof Error && err.name === "NotAllowedError") {
        setError("Passkey authentication was cancelled");
      } else {
        setError(err instanceof Error ? err.message : "Passkey verification failed");
      }
    } finally {
      setLoading(false);
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
    setResetToken(null);
    setResetMethods(null);
    setResetChosenMethod(null);
    setResetCode("");
    setResetNewPassword("");
    setResetSuccess(false);
    setAvailableMethods(null);
    setChosenMethod(null);
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

  const handleResetInit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username) return;
    setError(null);
    setLoading(true);
    try {
      const { tempToken: token, methods } = await passwordResetInit(username);
      setResetToken(token);
      setResetMethods(methods);
      if (methods.totp && !methods.passkey) {
        setResetChosenMethod("totp");
      } else if (methods.passkey && !methods.totp) {
        setResetChosenMethod("passkey");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Password reset failed");
    } finally {
      setLoading(false);
    }
  };

  const handleResetWithTotp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetToken || !resetCode || !resetNewPassword) return;
    setError(null);
    setLoading(true);
    try {
      await passwordResetConfirm(resetToken, resetCode, resetNewPassword);
      setResetSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Password reset failed");
    } finally {
      setLoading(false);
    }
  };

  const handleResetWithPasskey = async () => {
    if (!resetToken || !resetNewPassword) return;
    setError(null);
    setLoading(true);
    try {
      const options = await passwordResetPasskeyOptions(resetToken);
      const assertion = await startAuthentication({ optionsJSON: options });
      await passwordResetPasskeyConfirm(resetToken, assertion, resetNewPassword);
      setResetSuccess(true);
    } catch (err) {
      if (err instanceof Error && err.name === "NotAllowedError") {
        setError("Passkey authentication was cancelled");
      } else {
        setError(err instanceof Error ? err.message : "Password reset failed");
      }
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

  // 2FA method chooser (both TOTP and passkey available)
  if (tempToken && !chosenMethod && availableMethods?.totp && availableMethods?.passkey) {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="font-display">Two-Factor Authentication</CardTitle>
          <CardDescription>
            Choose a verification method to continue.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {error && <div className="text-sm text-destructive">{error}</div>}
          <Button
            variant="outline"
            className="w-full justify-start gap-3 h-auto py-3"
            onClick={() => setChosenMethod("totp")}
          >
            <SmartphoneIcon className="size-5 shrink-0" />
            <div className="text-left">
              <div className="text-sm font-medium">Authenticator App</div>
              <div className="text-xs text-muted-foreground">Enter a code from your authenticator app</div>
            </div>
          </Button>
          <Button
            variant="outline"
            className="w-full justify-start gap-3 h-auto py-3"
            onClick={() => { setChosenMethod("passkey"); handlePasskeyLogin(); }}
            disabled={loading}
          >
            <FingerprintIcon className="size-5 shrink-0" />
            <div className="text-left">
              <div className="text-sm font-medium">Passkey</div>
              <div className="text-xs text-muted-foreground">Use your passkey to verify</div>
            </div>
          </Button>
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground w-full text-center pt-1"
            onClick={resetToLogin}
          >
            Back to login
          </button>
        </CardContent>
      </Card>
    );
  }

  // Passkey-only 2FA (auto-triggers browser WebAuthn UI)
  if (tempToken && chosenMethod === "passkey") {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="font-display">Passkey Verification</CardTitle>
          <CardDescription>
            {loading ? "Waiting for passkey..." : "Use your passkey to verify your identity."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && <div className="text-sm text-destructive">{error}</div>}
          {!loading && (
            <Button className="w-full" onClick={handlePasskeyLogin}>
              Try Again
            </Button>
          )}
          <div className="flex items-center justify-between">
            {availableMethods?.totp && (
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => { setChosenMethod("totp"); setError(null); }}
              >
                Use authenticator app
              </button>
            )}
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground"
              onClick={resetToLogin}
            >
              Back to login
            </button>
          </div>
        </CardContent>
      </Card>
    );
  }

  // 2FA code entry screen (TOTP)
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
              {availableMethods?.passkey && (
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => { setChosenMethod("passkey"); setError(null); handlePasskeyLogin(); }}
                >
                  Use passkey
                </button>
              )}
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

  // Password reset flow
  if (resetMode) {
    // Success screen
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

    // Step 1: Enter username
    if (!resetToken) {
      return (
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle className="font-display">Reset Password</CardTitle>
            <CardDescription>
              Enter your username to begin. You'll need to verify your identity with 2FA.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleResetInit} className="space-y-4">
              {error && <div className="text-sm text-destructive">{error}</div>}
              <div className="space-y-2">
                <Label htmlFor="reset-username">Username</Label>
                <Input
                  id="reset-username"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                  autoFocus
                  autoComplete="username"
                />
              </div>
              <Button type="submit" className="w-full" disabled={loading || !username}>
                {loading ? "Checking..." : "Continue"}
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

    // Step 2: Method chooser (both available, no method chosen yet)
    if (resetMethods?.totp && resetMethods?.passkey && !resetChosenMethod) {
      return (
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle className="font-display">Reset Password</CardTitle>
            <CardDescription>
              Enter your new password, then verify your identity.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {error && <div className="text-sm text-destructive">{error}</div>}
            <div className="space-y-2">
              <Label htmlFor="reset-password-choose">New Password</Label>
              <Input
                id="reset-password-choose"
                type="password"
                value={resetNewPassword}
                onChange={(e) => setResetNewPassword(e.target.value)}
                autoComplete="new-password"
                autoFocus
              />
            </div>
            <Button
              variant="outline"
              className="w-full justify-start gap-3 h-auto py-3"
              onClick={() => setResetChosenMethod("totp")}
              disabled={!resetNewPassword}
            >
              <SmartphoneIcon className="size-5 shrink-0" />
              <div className="text-left">
                <div className="text-sm font-medium">Authenticator App</div>
                <div className="text-xs text-muted-foreground">Enter a code from your authenticator app</div>
              </div>
            </Button>
            <Button
              variant="outline"
              className="w-full justify-start gap-3 h-auto py-3"
              onClick={() => { setResetChosenMethod("passkey"); }}
              disabled={!resetNewPassword}
            >
              <FingerprintIcon className="size-5 shrink-0" />
              <div className="text-left">
                <div className="text-sm font-medium">Passkey</div>
                <div className="text-xs text-muted-foreground">Use your passkey to verify</div>
              </div>
            </Button>
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground w-full text-center"
              onClick={resetToLogin}
            >
              Back to sign in
            </button>
          </CardContent>
        </Card>
      );
    }

    // Step 2: Passkey verification
    if (resetChosenMethod === "passkey") {
      return (
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle className="font-display">Reset Password</CardTitle>
            <CardDescription>
              Enter your new password, then verify with your passkey.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {error && <div className="text-sm text-destructive">{error}</div>}
            <div className="space-y-2">
              <Label htmlFor="reset-password-passkey">New Password</Label>
              <Input
                id="reset-password-passkey"
                type="password"
                value={resetNewPassword}
                onChange={(e) => setResetNewPassword(e.target.value)}
                autoComplete="new-password"
                autoFocus
              />
            </div>
            <Button
              className="w-full"
              onClick={handleResetWithPasskey}
              disabled={loading || !resetNewPassword}
            >
              {loading ? "Verifying..." : "Verify with Passkey"}
            </Button>
            <div className="flex items-center justify-between">
              {resetMethods?.totp && (
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => { setResetChosenMethod("totp"); setError(null); }}
                >
                  Use authenticator app
                </button>
              )}
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={resetToLogin}
              >
                Back to sign in
              </button>
            </div>
          </CardContent>
        </Card>
      );
    }

    // Step 2: TOTP verification (default/totp chosen)
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="font-display">Reset Password</CardTitle>
          <CardDescription>
            Enter your new password and a 6-digit code from your authenticator app.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleResetWithTotp} className="space-y-4">
            {error && <div className="text-sm text-destructive">{error}</div>}
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
                autoFocus
                autoComplete="one-time-code"
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading || resetCode.length !== 6 || !resetNewPassword}>
              {loading ? "Resetting..." : "Reset Password"}
            </Button>
            <div className="flex items-center justify-between">
              {resetMethods?.passkey && (
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => { setResetChosenMethod("passkey"); setError(null); }}
                >
                  Use passkey
                </button>
              )}
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={resetToLogin}
              >
                Back to sign in
              </button>
            </div>
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
            <Label htmlFor="username">Username</Label>
            <Input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoComplete="username"
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
