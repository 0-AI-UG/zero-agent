/**
 * Settings panel that shows the authentication state of each CLI
 * subscription (Claude Code, Codex) for the current user, and exposes
 * login/logout actions.
 */
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  getCliAuthStatus,
  logoutCliAuth,
  type CliAuthStatus,
} from "@/api/cli-auth";
import { ClaudeLoginModal } from "./ClaudeLoginModal";
import { CodexLoginModal } from "./CodexLoginModal";

interface CliSubscriptionsPanelProps {
  projectId: string;
}

export function CliSubscriptionsPanel({ projectId }: CliSubscriptionsPanelProps) {
  const [status, setStatus] = useState<{ claude: CliAuthStatus; codex: CliAuthStatus } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showLogin, setShowLogin] = useState<"claude" | "codex" | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await getCliAuthStatus(projectId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const handleLogout = async (provider: "claude" | "codex") => {
    try {
      await logoutCliAuth(provider, projectId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="rounded-lg border p-4 space-y-4">
      <div>
        <h4 className="text-sm font-semibold">CLI Subscriptions</h4>
        <p className="text-xs text-muted-foreground mt-1">
          Use your own Claude Code or Codex subscription when chatting with
          models in the CLI-backed model list. Credentials stay inside your
          private per-user container volume and are never shared with other
          users.
        </p>
      </div>

      {error && (
        <div className="text-xs text-destructive bg-destructive/10 rounded p-2">{error}</div>
      )}

      <ProviderRow
        title="Claude Code"
        description="Anthropic Claude subscription (Max, Team, Pro)."
        loading={loading}
        status={status?.claude}
        onLogin={() => setShowLogin("claude")}
        onLogout={() => handleLogout("claude")}
      />

      <ProviderRow
        title="Codex"
        description="OpenAI ChatGPT / Codex subscription."
        loading={loading}
        status={status?.codex}
        onLogin={() => setShowLogin("codex")}
        onLogout={() => handleLogout("codex")}
      />

      {showLogin === "claude" && (
        <ClaudeLoginModal
          projectId={projectId}
          onClose={() => { setShowLogin(null); void refresh(); }}
          onSuccess={() => { void refresh(); }}
        />
      )}
      {showLogin === "codex" && (
        <CodexLoginModal
          projectId={projectId}
          onClose={() => { setShowLogin(null); void refresh(); }}
          onSuccess={() => { void refresh(); }}
        />
      )}
    </div>
  );
}

interface ProviderRowProps {
  title: string;
  description: string;
  loading: boolean;
  status?: CliAuthStatus;
  onLogin?: () => void;
  onLogout?: () => void;
  disabled?: boolean;
}

function ProviderRow({ title, description, loading, status, onLogin, onLogout, disabled }: ProviderRowProps) {
  const authed = status?.authenticated ?? false;
  return (
    <div className="flex items-center justify-between gap-4 py-2 border-t first:border-t-0 first:pt-0">
      <div className="min-w-0">
        <div className="text-sm font-medium flex items-center gap-2">
          {title}
          {loading ? (
            <span className="text-xs text-muted-foreground">checking…</span>
          ) : authed ? (
            <span className="text-xs bg-green-500/15 text-green-700 dark:text-green-400 rounded px-1.5 py-0.5">
              Logged in{status?.account ? ` · ${status.account}` : ""}
            </span>
          ) : (
            <span className="text-xs bg-muted text-muted-foreground rounded px-1.5 py-0.5">Not logged in</span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
      <div className="shrink-0">
        {disabled ? (
          <Button size="sm" variant="outline" disabled>Coming soon</Button>
        ) : authed ? (
          <Button size="sm" variant="outline" onClick={onLogout}>Log out</Button>
        ) : (
          <Button size="sm" onClick={onLogin}>Log in</Button>
        )}
      </div>
    </div>
  );
}
