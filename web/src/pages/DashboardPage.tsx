import { useState, useMemo } from "react";
import { Link } from "react-router";
import { useProjects } from "@/api/projects";
import { useAuthStore } from "@/stores/auth";
import { useCurrentUser } from "@/api/admin";
import { useInvitations, useAcceptInvitation, useDeclineInvitation } from "@/api/invitations";
import { ProjectCard } from "@/components/projects/ProjectCard";
import { CreateProjectDialog } from "@/components/projects/CreateProjectDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { CircleHelpIcon, LogOutIcon, MailIcon, SearchIcon, ShieldIcon, UserIcon } from "lucide-react";
import { EmptyProjectsIllustration } from "@/components/ui/illustrations";
import { InstallBanner } from "@/components/InstallBanner";

export function DashboardPage() {
  const { data: projects, isLoading, error } = useProjects();
  const logout = useAuthStore((s) => s.logout);
  const { data: currentUser } = useCurrentUser();
  const { data: invitations } = useInvitations();
  const acceptInvitation = useAcceptInvitation();
  const declineInvitation = useDeclineInvitation();
  const isAdmin = currentUser?.isAdmin;
  const canCreateProjects = currentUser?.canCreateProjects !== false;
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    if (!projects) return [];
    if (!search.trim()) return projects;
    const q = search.toLowerCase();
    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.description?.toLowerCase().includes(q)
    );
  }, [projects, search]);

  return (
    <div className="flex flex-col h-screen">
      <header className="shrink-0 border-b bg-background/95 backdrop-blur-sm supports-[backdrop-filter]:bg-background/60">
        <div className="flex items-center justify-between h-14 px-6 max-w-5xl mx-auto w-full">
          <h1 className="text-sm font-semibold tracking-tight font-display">Projects</h1>
          <div className="flex items-center gap-2">
            {canCreateProjects && <CreateProjectDialog />}
            <Button variant="ghost" size="icon-sm" asChild aria-label="Help">
              <Link to="/help">
                <CircleHelpIcon className="size-4" />
              </Link>
            </Button>
            {isAdmin && (
              <Button variant="ghost" size="icon-sm" asChild aria-label="Admin settings">
                <Link to="/admin">
                  <ShieldIcon className="size-4" />
                </Link>
              </Button>
            )}
            <Button variant="ghost" size="icon-sm" asChild aria-label="Account settings">
              <Link to="/account">
                <UserIcon className="size-4" />
              </Link>
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={logout}
              aria-label="Sign out"
            >
              <LogOutIcon className="size-4" />
            </Button>
          </div>
        </div>
      </header>

      <InstallBanner />

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
          {/* Pending Invitations */}
          {invitations && invitations.length > 0 && (
            <div className="space-y-2">
              {invitations.map((inv) => (
                <div
                  key={inv.id}
                  className="rounded-lg border border-primary/20 bg-primary/5 p-4 flex items-center justify-between gap-4"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <MailIcon className="size-4 text-primary shrink-0" />
                    <p className="text-sm truncate">
                      <span className="text-muted-foreground">{inv.inviterUsername}</span>{" "}
                      invited you to{" "}
                      <span className="font-medium">{inv.projectName}</span>
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      variant="default"
                      size="sm"
                      onClick={() => acceptInvitation.mutate(inv.id)}
                      disabled={acceptInvitation.isPending || declineInvitation.isPending}
                    >
                      Accept
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => declineInvitation.mutate(inv.id)}
                      disabled={acceptInvitation.isPending || declineInvitation.isPending}
                    >
                      Decline
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Search */}
          {projects && projects.length > 0 && (
            <div className="relative max-w-xs">
              <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search projects..."
                className="pl-9 h-9"
              />
            </div>
          )}

          {isLoading && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-[120px] rounded-xl" />
              ))}
            </div>
          )}

          {error && (
            <div className="text-sm text-destructive">
              Failed to load projects: {error.message}
            </div>
          )}

          {projects && projects.length === 0 && (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <EmptyProjectsIllustration className="mb-4" />
              <h2 className="text-sm font-medium mb-1">No projects yet</h2>
              <p className="text-sm text-muted-foreground mb-6">
                {canCreateProjects
                  ? "Create your first project to get started."
                  : "Ask an admin to add you to a project."}
              </p>
              {canCreateProjects && <CreateProjectDialog />}
            </div>
          )}

          {filtered.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {filtered.map((project) => (
                <ProjectCard key={project.id} project={project} />
              ))}
            </div>
          )}

          {projects && projects.length > 0 && filtered.length === 0 && search && (
            <p className="text-sm text-muted-foreground text-center py-8">
              No projects matching "{search}"
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
