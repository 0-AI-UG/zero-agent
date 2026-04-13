import { useState } from "react";
import { useNavigate } from "react-router";
import { formatDistanceToNow } from "date-fns";
import {
  MoreVerticalIcon,
  StarIcon,
  PencilIcon,
  ArchiveIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";
import type { Project } from "@/api/projects";
import { useDeleteProject, useStarProject, useArchiveProject } from "@/api/projects";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

interface ProjectCardProps {
  project: Project;
}

export function ProjectCard({ project }: ProjectCardProps) {
  const navigate = useNavigate();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const deleteProject = useDeleteProject();
  const starProject = useStarProject();
  const archiveProject = useArchiveProject();
  const basePath = `/projects/${project.id}`;

  return (
    <>
      <Card
        className="group cursor-pointer transition-all border-border/50 hover:border-border hover:bg-accent/50 relative !py-0 !gap-0"
        onClick={() => navigate(basePath)}
      >
        <CardHeader className="px-4 py-3.5">
          <div className="flex items-start justify-between gap-2">
            <CardTitle className="text-base truncate">{project.name}</CardTitle>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-7 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground -mt-0.5 -mr-1"
                  onClick={(e) => e.stopPropagation()}
                  aria-label="Project options"
                >
                  <MoreVerticalIcon className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                <DropdownMenuItem
                  onClick={() => starProject.mutate({ id: project.id, isStarred: !project.isStarred })}
                >
                  <StarIcon className={project.isStarred ? "fill-current" : ""} />
                  {project.isStarred ? "Unstar" : "Star"}
                </DropdownMenuItem>
                <DropdownMenuItem>
                  <PencilIcon />
                  Edit details
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => archiveProject.mutate({ id: project.id, isArchived: !project.isArchived })}
                >
                  <ArchiveIcon />
                  {project.isArchived ? "Unarchive" : "Archive"}
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => setConfirmOpen(true)}
                >
                  <Trash2Icon />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <CardDescription className="line-clamp-2">
            {project.description || "No description"}
          </CardDescription>

          <div className="flex items-center justify-between mt-2">
            <p className="text-xs text-muted-foreground">
              Updated{" "}
              {formatDistanceToNow(new Date(project.updatedAt), {
                addSuffix: true,
              })}
            </p>
            {project.memberCount > 1 && (
              <span className="flex items-center gap-1 text-[10px] text-muted-foreground shrink-0">
                <UsersIcon className="size-3" />
                {project.memberCount}
              </span>
            )}
          </div>
        </CardHeader>
      </Card>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete project</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete <strong>{project.name}</strong> and
              all its chats, messages, and files. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleteProject.isPending}
              onClick={() => deleteProject.mutate(project.id)}
            >
              {deleteProject.isPending ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
