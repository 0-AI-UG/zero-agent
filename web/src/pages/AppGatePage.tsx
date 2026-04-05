import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router";
import { apiFetch } from "@/api/client";
import { Loader2Icon } from "lucide-react";

type Status = "checking" | "starting" | "redirecting" | "error";

export function AppGatePage() {
  const { slug, "*": rest } = useParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState<Status>("checking");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function go() {
      try {
        setStatus("starting");

        const { status: appStatus, error: appError } = await apiFetch<{
          status: string;
          error?: string;
        }>(`/apps/${slug}/status`);

        if (cancelled) return;

        if (appStatus === "ready") {
          setStatus("redirecting");
          const { token } = await apiFetch<{ token: string }>("/app-token", {
            method: "POST",
          });
          if (cancelled) return;
          const path = rest ? `/${rest}` : "";
          window.location.href = `/_apps/${slug}${path}?token=${encodeURIComponent(token)}`;
          return;
        }

        if (appStatus === "failed" || appStatus === "stopped") {
          setStatus("error");
          setError(appError || "Service could not be started");
          return;
        }
      } catch {
        if (!cancelled) {
          setStatus("error");
          setError("Not authenticated");
          setTimeout(() => navigate("/login"), 1000);
        }
      }
    }

    go();
    return () => { cancelled = true; };
  }, [slug, rest, navigate]);

  if (status === "error") {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <div className="text-center space-y-2">
          <p className="text-sm text-destructive font-medium">Failed to start</p>
          <p className="text-xs text-muted-foreground">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center min-h-screen bg-background">
      <div className="text-center space-y-3">
        <Loader2Icon className="size-6 text-muted-foreground mx-auto animate-spin" />
        <p className="text-sm text-muted-foreground">
          {status === "redirecting" ? "Redirecting" : "Starting service"}
        </p>
      </div>
    </div>
  );
}
