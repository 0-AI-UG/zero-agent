import { useEffect } from "react";
import { Navigate, Outlet, useLocation } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "@/stores/auth";
import { getSetupStatus } from "@/api/setup";
import { useModels } from "@/api/models";
import { setModelsCache } from "@/stores/model";
import { apiFetch } from "@/api/client";

interface MeResponse {
  user: {
    id: string;
    username: string;
    isAdmin: boolean;
    canCreateProjects: boolean;
    companionSharing: boolean;
    passkeyRequired: boolean;
  };
}

export function ProtectedRoute() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const ready = useAuthStore((s) => s.ready);
  const setSession = useAuthStore((s) => s.setSession);
  const clearSession = useAuthStore((s) => s.clearSession);
  const token = useAuthStore((s) => s.token);
  const location = useLocation();

  useEffect(() => {
    if (ready) return;
    apiFetch<MeResponse>("/me")
      .then((res) => setSession({ id: res.user.id, username: res.user.username }, token))
      .catch(() => clearSession());
  }, [ready, setSession, clearSession, token]);

  const { data: setupStatus, isLoading } = useQuery({
    queryKey: ["setup", "status"],
    queryFn: getSetupStatus,
  });

  if (isLoading || !ready) {
    return null;
  }

  if (setupStatus && !setupStatus.setupComplete) {
    return <Navigate to="/setup" replace />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <ModelsCacheSync />;
}

function ModelsCacheSync() {
  const { data: models } = useModels();
  if (models) setModelsCache(models);
  return <Outlet />;
}
