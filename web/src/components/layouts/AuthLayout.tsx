import { Navigate, Outlet, useLocation } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { useAuthStore } from "@/stores/auth";
import { getSetupStatus } from "@/api/setup";
import { AsciiBackground } from "@/components/AsciiBackground";
import logoSvg from "@/logo.svg";

export function AuthLayout() {
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
    if (location.pathname !== "/setup") {
      return <Navigate to="/setup" replace />;
    }
    return <Outlet />;
  }

  if (isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="relative flex h-screen items-center justify-center p-4 overflow-hidden">
      <div className="ascii-auth">
        <AsciiBackground />
      </div>

      <div className="relative z-10 flex flex-col items-center gap-8 w-full max-w-sm">
        {/* Branding */}
        <div className="text-center space-y-2 flex flex-col items-center">
          <img src={logoSvg} alt="Zero Agent" className="size-12" />
          <h1 className="text-xl font-bold font-display tracking-tight">Zero Agent</h1>
          <p className="text-sm text-muted-foreground">AI agent for your projects</p>
        </div>

        <Outlet />
      </div>
    </div>
  );
}
