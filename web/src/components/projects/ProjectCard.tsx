import { useState } from "react";
import { useNavigate } from "react-router";
import { formatDistanceToNow } from "date-fns";
import { Trash2Icon, MessageSquareIcon, FolderIcon, UsersIcon } from "lucide-react";
import type { Project } from "@/api/projects";
import { useDeleteProject } from "@/api/projects";
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
import { Button } from "@/components/ui/button";

interface ProjectCardProps {
  project: Project;
}

export function ProjectCard({ project }: ProjectCardProps) {
  const navigate = useNavigate();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const deleteProject = useDeleteProject();
  const basePath = `/projects/${project.id}`;

  return (
    <>
      <Card
        className="group cursor-pointer transition-colors hover:bg-muted/50 relative"
        onClick={() => navigate(basePath)}
      >
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <CardTitle className="text-base truncate">{project.name}</CardTitle>
            {project.memberCount > 1 && (
              <span className="flex items-center gap-1 text-[10px] text-muted-foreground shrink-0 mt-1">
                <UsersIcon className="size-3" />
                {project.memberCount}
              </span>
            )}
          </div>
          <CardDescription className="line-clamp-2">
            {project.description || "No description"}
          </CardDescription>

          <div className="flex items-center justify-between mt-2">
            <p className="text-xs text-muted-foreground">
              Updated {formatDistanceToNow(new Date(project.updatedAt), { addSuffix: true })}
            </p>

            {/* Quick action buttons */}
            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-7 text-muted-foreground hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  navigate(basePath);
                }}
                aria-label="Open chat"
              >
                <MessageSquareIcon className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-7 text-muted-foreground hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation();
                  navigate(`${basePath}/files`);
                }}
                aria-label="Open files"
              >
                <FolderIcon className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-7 text-muted-foreground hover:text-destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  setConfirmOpen(true);
                }}
                aria-label="Delete project"
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </div>
          </div>
        </CardHeader>
      </Card>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete project</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete <strong>{project.name}</strong> and
              all its chats, messages, and files. This action cannot be
              undone.
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
