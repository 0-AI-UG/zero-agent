import { Navigate, Outlet, useLocation } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "@/stores/auth";
import { getSetupStatus } from "@/api/setup";

export function ProtectedRoute() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const location = useLocation();

  const { data: setupStatus, isLoading } = useQuery({
    queryKey: ["setup", "status"],
    queryFn: getSetupStatus,
  });

  if (isLoading) {
    return null;
  }

  if (setupStatus && !setupStatus.setupComplete) {
    return <Navigate to="/setup" replace />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <Outlet />;
}
