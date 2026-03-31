import { useEffect } from "react";
import { Navigate, Outlet, useLocation } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "@/stores/auth";
import { getSetupStatus } from "@/api/setup";
import { useModels } from "@/api/models";
import { setModelsCache } from "@/stores/model";

export function ProtectedRoute() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const login = useAuthStore((s) => s.login);
  const location = useLocation();

  const { data: setupStatus, isLoading } = useQuery({
    queryKey: ["setup", "status"],
    queryFn: getSetupStatus,
  });

  useEffect(() => {
    if (setupStatus?.desktopMode && !isAuthenticated) {
      login("desktop-mode", { id: "desktop-user", email: "desktop@local" });
    }
  }, [setupStatus?.desktopMode, isAuthenticated, login]);

  if (isLoading) {
    return null;
  }

  if (setupStatus && !setupStatus.setupComplete) {
    const setupPath = setupStatus.desktopMode ? "/setup/desktop" : "/setup";
    return <Navigate to={setupPath} replace />;
  }

  if (!isAuthenticated) {
    // In desktop mode, wait for the useEffect to auto-login
    if (setupStatus?.desktopMode) return null;
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <ModelsCacheSync />;
}

function ModelsCacheSync() {
  const { data: models } = useModels();
  if (models) setModelsCache(models);
  return <Outlet />;
}
