import { useState, useMemo } from "react";
import { useProjects } from "@/api/projects";
import { useCurrentUser } from "@/api/admin";
import { useInvitations, useAcceptInvitation, useDeclineInvitation } from "@/api/invitations";
import { ProjectCard } from "@/components/projects/ProjectCard";
import { CreateProjectDialog } from "@/components/projects/CreateProjectDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { MailIcon, SearchIcon } from "lucide-react";
import { EmptyProjectsIllustration } from "@/components/ui/illustrations";

export function DashboardPage() {
  const { data: projects, isLoading, error } = useProjects();
  const { data: currentUser } = useCurrentUser();
  const { data: invitations } = useInvitations();
  const acceptInvitation = useAcceptInvitation();
  const declineInvitation = useDeclineInvitation();
  const canCreateProjects = currentUser?.canCreateProjects !== false;
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    if (!projects) return [];
    const active = projects.filter((p) => !p.isArchived);
    const list = search.trim()
      ? active.filter((p) => {
          const q = search.toLowerCase();
          return (
            p.name.toLowerCase().includes(q) ||
            p.description?.toLowerCase().includes(q)
          );
        })
      : active;
    return list.sort((a, b) => (a.isStarred === b.isStarred ? 0 : a.isStarred ? -1 : 1));
  }, [projects, search]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-4 md:px-6 pt-6 md:pt-16 pb-8 space-y-8">
          {/* Page header */}
          <div className="flex items-center justify-between">
            <h1 className="text-xl font-bold tracking-tight font-display">
              Projects
            </h1>
            {canCreateProjects && <CreateProjectDialog />}
          </div>

          {/* Pending Invitations */}
          {invitations && invitations.length > 0 && (
            <div className="space-y-2">
              {invitations.map((inv) => (
                <div
                  key={inv.id}
                  className="rounded-lg border border-primary/20 bg-primary/5 p-4 flex items-center justify-between gap-4"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <MailIcon className="size-4 text-muted-foreground shrink-0" />
                    <p className="text-sm truncate">
                      <span className="text-muted-foreground">
                        {inv.inviterUsername}
                      </span>{" "}
                      invited you to{" "}
                      <span className="font-medium">{inv.projectName}</span>
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      variant="default"
                      size="sm"
                      onClick={() => acceptInvitation.mutate(inv.id)}
                      disabled={
                        acceptInvitation.isPending ||
                        declineInvitation.isPending
                      }
                    >
                      Accept
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => declineInvitation.mutate(inv.id)}
                      disabled={
                        acceptInvitation.isPending ||
                        declineInvitation.isPending
                      }
                    >
                      Decline
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Search bar - full width, bold */}
          {projects && projects.length > 0 && (
            <div className="relative">
              <SearchIcon className="absolute left-4 top-1/2 -translate-y-1/2 size-5 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search projects..."
                className="!h-12 pl-12 text-base border-border"
              />
            </div>
          )}

          {isLoading && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-[140px] rounded-xl" />
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
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {filtered.map((project) => (
                <ProjectCard key={project.id} project={project} />
              ))}
            </div>
          )}

          {projects &&
            projects.length > 0 &&
            filtered.length === 0 &&
            search && (
              <p className="text-sm text-muted-foreground text-center py-8">
                No projects matching &quot;{search}&quot;
              </p>
            )}
        </div>
      </div>
    </div>
  );
}
