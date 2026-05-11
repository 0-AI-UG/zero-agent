import { useState } from "react";
import { useNavigate, useLocation } from "react-router";
import { useAuthStore } from "@/stores/auth";
import {
  loginApi,
  passwordResetInit,
  passwordResetPasskeyOptions,
  passwordResetPasskeyConfirm,
} from "@/api/auth";
import {
  passkeyLoginOptions,
  passkeyLoginVerify,
  passkeyEnrollOptions,
  passkeyEnrollVerify,
} from "@/api/passkeys";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
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

type Mode =
  | { kind: "login" }
  | { kind: "verify"; tempToken: string }
  | { kind: "enroll"; tempToken: string }
  | { kind: "reset-init" }
  | { kind: "reset-verify"; tempToken: string }
  | { kind: "reset-done" };

export function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<Mode>({ kind: "login" });

  const setSession = useAuthStore((s) => s.setSession);
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: Location })?.from?.pathname ?? "/";

  const goHome = (user: { id: string; username: string }, token: string | null) => {
    setSession(user, token);
    navigate(from, { replace: true });
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const result = await loginApi(username, password);
      if ("requires2FA" in result) {
        setMode({ kind: "verify", tempToken: result.tempToken });
        await runPasskeyVerify(result.tempToken);
      } else if ("requires2FASetup" in result) {
        setMode({ kind: "enroll", tempToken: result.tempToken });
      } else {
        goHome(result.user, (result as any).token ?? null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  };

  const runPasskeyVerify = async (tempToken: string) => {
    setError(null);
    setLoading(true);
    try {
      const { ceremonyId, ...options } = await passkeyLoginOptions(tempToken);
      const assertion = await startAuthentication({ optionsJSON: options as any });
      const result = await passkeyLoginVerify(tempToken, ceremonyId, assertion);
      goHome(result.user, (result as any).token ?? null);
    } catch (err) {
      if (err instanceof Error && err.name === "NotAllowedError") {
        setError("Passkey verification cancelled");
      } else {
        setError(err instanceof Error ? err.message : "Passkey verification failed");
      }
    } finally {
      setLoading(false);
    }
  };

  const runPasskeyEnroll = async (tempToken: string) => {
    setError(null);
    setLoading(true);
    try {
      const { ceremonyId, ...options } = await passkeyEnrollOptions(tempToken);
      const registration = await startRegistration({ optionsJSON: options as any });
      const result = await passkeyEnrollVerify(tempToken, ceremonyId, registration);
      goHome(result.user, (result as any).token ?? null);
    } catch (err) {
      if (err instanceof Error && err.name === "NotAllowedError") {
        setError("Passkey registration cancelled");
      } else {
        setError(err instanceof Error ? err.message : "Could not register passkey");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleResetInit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await passwordResetInit(username);
      if (res.tempToken) {
        setMode({ kind: "reset-verify", tempToken: res.tempToken });
      } else {
        // Generic response — username doesn't match an eligible account.
        // Show the success page anyway so we don't leak account existence.
        setMode({ kind: "reset-done" });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reset failed");
    } finally {
      setLoading(false);
    }
  };

  const handleResetWithPasskey = async () => {
    if (mode.kind !== "reset-verify" || !newPassword) return;
    setError(null);
    setLoading(true);
    try {
      const { ceremonyId, ...options } = await passwordResetPasskeyOptions(mode.tempToken);
      const assertion = await startAuthentication({ optionsJSON: options as any });
      await passwordResetPasskeyConfirm(mode.tempToken, ceremonyId, assertion, newPassword);
      setMode({ kind: "reset-done" });
    } catch (err) {
      if (err instanceof Error && err.name === "NotAllowedError") {
        setError("Passkey verification cancelled");
      } else {
        setError(err instanceof Error ? err.message : "Reset failed");
      }
    } finally {
      setLoading(false);
    }
  };

  const reset = () => {
    setMode({ kind: "login" });
    setError(null);
    setNewPassword("");
  };

  // ── Render ──

  if (mode.kind === "verify") {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="font-display">Verify with passkey</CardTitle>
          <CardDescription>
            {loading ? "Waiting for your passkey…" : "Use your passkey to continue."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && <div className="text-sm text-destructive">{error}</div>}
          {!loading && (
            <Button className="w-full" onClick={() => runPasskeyVerify(mode.tempToken)}>
              Try again
            </Button>
          )}
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground w-full text-center"
            onClick={reset}
          >
            Back to sign in
          </button>
        </CardContent>
      </Card>
    );
  }

  if (mode.kind === "enroll") {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="font-display">Add a passkey</CardTitle>
          <CardDescription>
            Your account requires a passkey. Use Face ID, Touch ID, Windows Hello, or a security key.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && <div className="text-sm text-destructive">{error}</div>}
          <Button
            className="w-full"
            onClick={() => runPasskeyEnroll(mode.tempToken)}
            disabled={loading}
          >
            {loading ? "Waiting…" : "Create passkey"}
          </Button>
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground w-full text-center"
            onClick={reset}
          >
            Back to sign in
          </button>
        </CardContent>
      </Card>
    );
  }

  if (mode.kind === "reset-done") {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="font-display">Check complete</CardTitle>
          <CardDescription>
            If an account exists with a passkey, your password has been updated. You can now sign in.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button className="w-full" onClick={reset}>
            Back to sign in
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (mode.kind === "reset-verify") {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="font-display">Reset password</CardTitle>
          <CardDescription>
            Enter a new password, then verify with your passkey.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && <div className="text-sm text-destructive">{error}</div>}
          <div className="space-y-2">
            <Label htmlFor="new-password">New password</Label>
            <Input
              id="new-password"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              autoFocus
            />
          </div>
          <Button
            className="w-full"
            onClick={handleResetWithPasskey}
            disabled={loading || !newPassword}
          >
            {loading ? "Verifying…" : "Verify with passkey"}
          </Button>
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground w-full text-center"
            onClick={reset}
          >
            Back to sign in
          </button>
        </CardContent>
      </Card>
    );
  }

  if (mode.kind === "reset-init") {
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="font-display">Reset password</CardTitle>
          <CardDescription>
            Enter your username. We'll prompt for your passkey next.
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
              {loading ? "Checking…" : "Continue"}
            </Button>
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground w-full text-center"
              onClick={reset}
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
        <CardTitle className="font-display">Sign in</CardTitle>
        <CardDescription>Enter your credentials to continue.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleLogin} className="space-y-4">
          {error && <div className="text-sm text-destructive">{error}</div>}
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
            {loading ? "Signing in…" : "Sign in"}
          </Button>
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground w-full text-center"
            onClick={() => { setMode({ kind: "reset-init" }); setError(null); }}
          >
            Forgot password?
          </button>
        </form>
      </CardContent>
    </Card>
  );
}
