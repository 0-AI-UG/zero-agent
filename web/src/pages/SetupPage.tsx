import { useState } from "react";
import { useNavigate, Navigate } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuthStore } from "@/stores/auth";
import { completeSetup, getSetupStatus } from "@/api/setup";
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
import { UsersIcon, BotIcon, ClockIcon } from "lucide-react";
import logoSvg from "@/logo.svg";

export function SetupPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const setSession = useAuthStore((s) => s.setSession);
  const [step, setStep] = useState(1);
  const { data: setupStatus, isLoading: statusLoading } = useQuery({
    queryKey: ["setup", "status"],
    queryFn: getSetupStatus,
    enabled: step === 1,
  });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Step 1
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");

  // Step 2
  const [openrouterApiKey, setOpenrouterApiKey] = useState("");
  const [openrouterModel, setOpenrouterModel] = useState("");
  const [braveSearchApiKey, setBraveSearchApiKey] = useState("");

  // Step 3 (passkey)
  const [tempToken, setTempToken] = useState("");

  if (statusLoading) return null;
  if (setupStatus?.setupComplete) return <Navigate to="/login" replace />;

  const handleNext = () => {
    setError(null);
    if (!username || !password || !confirmPassword) {
      setError("All fields are required.");
      return;
    }
    if (username.length < 3 || username.length > 32 || !/^[a-zA-Z0-9_-]+$/.test(username)) {
      setError("Username must be 3-32 chars (letters, numbers, _ or -).");
      return;
    }
    if (
      password.length < 8 ||
      !/[a-z]/.test(password) ||
      !/[A-Z]/.test(password) ||
      !/[0-9]/.test(password)
    ) {
      setError("Password must be 8+ characters with upper, lower, and a number.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setStep(2);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!openrouterApiKey) {
      setError("OpenRouter API key is required.");
      return;
    }
    setLoading(true);
    try {
      const result = await completeSetup(
        {
          username,
          password,
          openrouterApiKey,
          openrouterModel: openrouterModel || undefined,
          braveSearchApiKey: braveSearchApiKey || undefined,
        },
        setupToken || undefined,
      );
      if ("token" in result && !("requires2FASetup" in result)) {
        setSession(result.user, (result as any).token ?? null);
        queryClient.setQueryData(["setup", "status"], { setupComplete: true });
        navigate("/", { replace: true });
        return;
      }
      if (!("tempToken" in result)) throw new Error("Unexpected response");
      setTempToken(result.tempToken);
      setStep(3);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setup failed");
    } finally {
      setLoading(false);
    }
  };

  const handleEnrollPasskey = async () => {
    setError(null);
    setLoading(true);
    try {
      const { ceremonyId, ...options } = await passkeyEnrollOptions(tempToken);
      const registration = await startRegistration({ optionsJSON: options as any });
      const result = await passkeyEnrollVerify(tempToken, ceremonyId, registration);
      setSession(result.user, (result as any).token ?? null);
      queryClient.setQueryData(["setup", "status"], { setupComplete: true });
      navigate("/", { replace: true });
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

  const isProd = !!(import.meta as any).env?.PROD;

  return (
    <div className="relative flex min-h-screen items-center justify-center p-4">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-1/4 -right-1/4 h-[600px] w-[600px] rounded-full bg-primary/10 blur-3xl" />
        <div className="absolute -bottom-1/4 -left-1/4 h-[500px] w-[500px] rounded-full bg-primary/5 blur-3xl" />
      </div>

      <div className="relative z-10 flex flex-col items-center gap-8 w-full max-w-sm">
        <div className="text-center space-y-2 flex flex-col items-center">
          <img src={logoSvg} alt="Zero Agent" className="size-12" />
          <h1 className="text-xl font-bold font-display tracking-tight">Zero Agent</h1>
          <p className="text-sm text-muted-foreground">Initial setup</p>
        </div>

        <Card className="w-full max-w-sm">
          <CardHeader>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-muted-foreground font-medium">
                Step {step} of 3
              </span>
            </div>
            <CardTitle className="font-display">
              {step === 1 ? "Create admin account" : step === 2 ? "Configure LLM" : "Add a passkey"}
            </CardTitle>
            <CardDescription>
              {step === 1
                ? "Set up the first admin account for your instance."
                : step === 2
                  ? "Connect an LLM provider to power the agent."
                  : "Admin accounts require a passkey. Use Face ID, Touch ID, Windows Hello, or a security key."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {step === 1 ? (
              <div className="space-y-4">
                {error && <div className="text-sm text-destructive">{error}</div>}
                <div className="space-y-2">
                  <Label htmlFor="setup-username">Username</Label>
                  <Input
                    id="setup-username"
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    required
                    autoComplete="username"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="setup-password">Password</Label>
                  <Input
                    id="setup-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoComplete="new-password"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="setup-confirm-password">Confirm password</Label>
                  <Input
                    id="setup-confirm-password"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    autoComplete="new-password"
                  />
                </div>
                {isProd && (
                  <div className="space-y-2">
                    <Label htmlFor="setup-token">Setup token</Label>
                    <Input
                      id="setup-token"
                      type="password"
                      value={setupToken}
                      onChange={(e) => setSetupToken(e.target.value)}
                      placeholder="Required in production"
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Find this value in <code>SETUP_TOKEN</code> on the server.
                    </p>
                  </div>
                )}
                <Button type="button" className="w-full" onClick={handleNext}>
                  Next
                </Button>
              </div>
            ) : step === 2 ? (
              <form onSubmit={handleSubmit} className="space-y-4">
                {error && <div className="text-sm text-destructive">{error}</div>}
                <div className="space-y-2">
                  <Label htmlFor="setup-api-key">OpenRouter API key</Label>
                  <Input
                    id="setup-api-key"
                    type="password"
                    value={openrouterApiKey}
                    onChange={(e) => setOpenrouterApiKey(e.target.value)}
                    required
                    placeholder="sk-or-..."
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="setup-model">Model (optional)</Label>
                  <Input
                    id="setup-model"
                    type="text"
                    value={openrouterModel}
                    onChange={(e) => setOpenrouterModel(e.target.value)}
                    placeholder="anthropic/claude-opus-4-7"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="setup-brave-key">Brave Search API key (optional)</Label>
                  <Input
                    id="setup-brave-key"
                    type="password"
                    value={braveSearchApiKey}
                    onChange={(e) => setBraveSearchApiKey(e.target.value)}
                    placeholder="BSA..."
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="flex-1"
                    onClick={() => { setError(null); setStep(1); }}
                  >
                    Back
                  </Button>
                  <Button type="submit" className="flex-1" disabled={loading}>
                    {loading ? "Setting up…" : "Next"}
                  </Button>
                </div>
              </form>
            ) : (
              <div className="space-y-4">
                {error && <div className="text-sm text-destructive">{error}</div>}
                <Button className="w-full" onClick={handleEnrollPasskey} disabled={loading}>
                  {loading ? "Waiting…" : "Create passkey"}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="flex items-center justify-center gap-6 text-muted-foreground">
          <div className="flex flex-col items-center gap-1">
            <BotIcon className="size-4" />
            <span className="text-[10px] font-medium">Agent</span>
          </div>
          <div className="flex flex-col items-center gap-1">
            <UsersIcon className="size-4" />
            <span className="text-[10px] font-medium">Collaboration</span>
          </div>
          <div className="flex flex-col items-center gap-1">
            <ClockIcon className="size-4" />
            <span className="text-[10px] font-medium">Automation</span>
          </div>
        </div>
      </div>
    </div>
  );
}
