import { Navigate, Outlet } from "react-router";
import { useAuthStore } from "@/stores/auth";
import { UsersIcon, BotIcon, ClockIcon } from "lucide-react";
import logoSvg from "@/logo.svg";

export function AuthLayout() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  if (isAuthenticated) {
    return <Navigate to="/" replace />;
  }

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
          <p className="text-sm text-muted-foreground">AI agent for your projects</p>
        </div>

        <Outlet />

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
