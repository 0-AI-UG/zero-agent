import { useState } from "react";
import { useNavigate } from "react-router";
import { useAuthStore } from "@/stores/auth";
import { completeSetup } from "@/api/setup";
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
  const [step, setStep] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Step 1 fields
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  // Step 2 fields
  const [openrouterApiKey, setOpenrouterApiKey] = useState("");
  const [openrouterModel, setOpenrouterModel] = useState("");

  const handleNext = () => {
    setError(null);
    if (!email || !password || !confirmPassword) {
      setError("All fields are required.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
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
      const { token, user } = await completeSetup({
        email,
        password,
        openrouterApiKey,
        openrouterModel: openrouterModel || undefined,
      });
      useAuthStore.getState().login(token, user);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setup failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center p-4">
      {/* Background mesh gradients */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-1/4 -right-1/4 h-[600px] w-[600px] rounded-full bg-primary/10 blur-3xl" />
        <div className="absolute -bottom-1/4 -left-1/4 h-[500px] w-[500px] rounded-full bg-primary/5 blur-3xl" />
      </div>

      <div className="relative z-10 flex flex-col items-center gap-8 w-full max-w-sm">
        {/* Branding */}
        <div className="text-center space-y-2 flex flex-col items-center">
          <img src={logoSvg} alt="Zero Agent" className="size-12" />
          <h1 className="text-xl font-bold font-display tracking-tight">Zero Agent</h1>
          <p className="text-sm text-muted-foreground">Initial Setup</p>
        </div>

        <Card className="w-full max-w-sm">
          <CardHeader>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-muted-foreground font-medium">
                Step {step} of 2
              </span>
            </div>
            <CardTitle className="font-display">
              {step === 1 ? "Create Admin Account" : "Configure LLM"}
            </CardTitle>
            <CardDescription>
              {step === 1
                ? "Set up the first admin account for your instance."
                : "Connect an LLM provider to power the agent."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {step === 1 ? (
              <div className="space-y-4">
                {error && (
                  <div className="text-sm text-destructive">{error}</div>
                )}
                <div className="space-y-2">
                  <Label htmlFor="setup-email">Email</Label>
                  <Input
                    id="setup-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoComplete="email"
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
                  <Label htmlFor="setup-confirm-password">Confirm Password</Label>
                  <Input
                    id="setup-confirm-password"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    autoComplete="new-password"
                  />
                </div>
                <Button type="button" className="w-full" onClick={handleNext}>
                  Next
                </Button>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                {error && (
                  <div className="text-sm text-destructive">{error}</div>
                )}
                <div className="space-y-2">
                  <Label htmlFor="setup-api-key">OpenRouter API Key</Label>
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
                    placeholder="minimax/minimax-m2.7"
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="flex-1"
                    onClick={() => {
                      setError(null);
                      setStep(1);
                    }}
                  >
                    Back
                  </Button>
                  <Button type="submit" className="flex-1" disabled={loading}>
                    {loading ? "Setting up..." : "Complete Setup"}
                  </Button>
                </div>
              </form>
            )}
          </CardContent>
        </Card>

        {/* Feature highlights */}
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
