import { Outlet, useNavigate, useParams } from "react-router";
import { useAuthStore } from "@/stores/auth";
import { useUIStore } from "@/stores/ui";
import { useProject } from "@/api/projects";
import { Button } from "@/components/ui/button";
import { ArrowLeft, FolderOpen, Users, LogOut } from "lucide-react";

export function AppLayout() {
  const logout = useAuthStore((s) => s.logout);
  const toggleDrawer = useUIStore((s) => s.toggleDrawer);
  const activeDrawer = useUIStore((s) => s.activeDrawer);

  const navigate = useNavigate();
  const { projectId } = useParams<{ projectId: string }>();
  const { data: project } = useProject(projectId ?? "");

  return (
    <div className="flex flex-col h-screen">
      <header className="h-14 shrink-0 border-b flex items-center justify-between px-4">
        <div className="flex items-center gap-3">
          {projectId && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => navigate("/")}
              aria-label="Back to dashboard"
            >
              <ArrowLeft className="size-4" />
            </Button>
          )}
          <h1 className="text-base font-semibold truncate">
            {project?.name ?? "Projects"}
          </h1>
        </div>

        <div className="flex items-center gap-1">
          {projectId && (
            <>
              <Button
                variant={activeDrawer === "files" ? "secondary" : "ghost"}
                size="icon-sm"
                onClick={() => toggleDrawer("files")}
                aria-label="Toggle files panel"
              >
                <FolderOpen className="size-4" />
              </Button>
              <Button
                variant={activeDrawer === "leads" ? "secondary" : "ghost"}
                size="icon-sm"
                onClick={() => toggleDrawer("leads")}
                aria-label="Toggle leads panel"
              >
                <Users className="size-4" />
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={logout}
            aria-label="Sign out"
          >
            <LogOut className="size-4" />
          </Button>
        </div>
      </header>

      <main className="flex-1 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
