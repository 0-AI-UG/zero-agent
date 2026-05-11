import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router";
import { useAuthStore } from "@/stores/auth";
import {
  lookupInvitation,
  acceptInvitation,
  type InvitationLookup,
} from "@/api/user-invitations";
import { passkeyEnrollOptions, passkeyEnrollVerify } from "@/api/passkeys";
import { startRegistration } from "@simplewebauthn/browser";
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

export function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const setSession = useAuthStore((s) => s.setSession);

  const [lookup, setLookup] = useState<InvitationLookup | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [enrollToken, setEnrollToken] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    lookupInvitation(token)
      .then(setLookup)
      .catch((err) => setLookupError(err instanceof Error ? err.message : "Failed to load"));
  }, [token]);

  const goHome = (user: { id: string; username: string }, sessionToken: string | null) => {
    setSession(user, sessionToken);
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
        setEnrollToken(result.tempToken);
      } else {
        goHome(result.user, (result as any).token ?? null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to accept invitation");
    } finally {
      setLoading(false);
    }
  };

  const handleEnroll = async () => {
    if (!enrollToken) return;
    setError(null);
    setLoading(true);
    try {
      const { ceremonyId, ...options } = await passkeyEnrollOptions(enrollToken);
      const registration = await startRegistration({ optionsJSON: options as any });
      const result = await passkeyEnrollVerify(enrollToken, ceremonyId, registration);
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

  if (enrollToken) {
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
          <Button className="w-full" onClick={handleEnroll} disabled={loading}>
            {loading ? "Waiting…" : "Create passkey"}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle className="font-display">Accept invitation</CardTitle>
        <CardDescription>
          Create a password for <span className="font-medium text-foreground">{lookup.username}</span>.
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
            {loading ? "Creating account…" : "Create account"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
