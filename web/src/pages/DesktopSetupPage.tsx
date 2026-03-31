import { useState } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
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
import logoSvg from "@/logo.svg";

export function DesktopSetupPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [openrouterApiKey, setOpenrouterApiKey] = useState("");
  const [openrouterModel, setOpenrouterModel] = useState("");
  const [braveSearchApiKey, setBraveSearchApiKey] = useState("");

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
        email: "desktop@local",
        password: "desktop",
        openrouterApiKey,
        openrouterModel: openrouterModel || undefined,
        braveSearchApiKey: braveSearchApiKey || undefined,
      });
      useAuthStore.getState().login(token, user);
      queryClient.setQueryData(["setup", "status"], { setupComplete: true, desktopMode: true });
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setup failed");
    } finally {
      setLoading(false);
    }
  };

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
          <p className="text-sm text-muted-foreground">Configure your LLM provider to get started.</p>
        </div>

        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle className="font-display">Setup</CardTitle>
            <CardDescription>
              Connect an LLM provider to power the agent.
            </CardDescription>
          </CardHeader>
          <CardContent>
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
              <div className="space-y-2">
                <Label htmlFor="setup-brave-key">Brave Search API Key (optional)</Label>
                <Input
                  id="setup-brave-key"
                  type="password"
                  value={braveSearchApiKey}
                  onChange={(e) => setBraveSearchApiKey(e.target.value)}
                  placeholder="BSA..."
                />
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? "Setting up..." : "Get Started"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
