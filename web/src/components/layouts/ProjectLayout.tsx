import { Outlet, NavLink, useParams, useNavigate, useLocation } from "react-router";
import { useProject } from "@/api/projects";
import { useFiles } from "@/hooks/use-files";
import { useAuthStore } from "@/stores/auth";
import { useIsMobile } from "@/hooks/use-mobile";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { ChatSidebar } from "@/components/chat/ChatSidebar";
import { Loader } from "@/components/ai/loader";
import {
  ArrowLeftIcon,
  ClockIcon,
  FolderIcon,
  LogOutIcon,
  MessageSquareIcon,
  PuzzleIcon,
  NetworkIcon,
  SettingsIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useEffect } from "react";
import { useFilesStore } from "@/stores/files-store";
import { FilePreviewModal } from "@/components/files/file-preview-modal";

function getProjectColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `oklch(0.65 0.15 ${hue})`;
}

function NavRailItem({
  to,
  icon: Icon,
  label,
  end,
  count,
  isActive: isActiveProp,
  hasAlert,
}: {
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  end?: boolean;
  count?: number;
  isActive?: boolean;
  hasAlert?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <NavLink
          to={to}
          end={end}
          className={({ isActive: navIsActive }) => {
            const active = isActiveProp ?? navIsActive;
            return cn(
              "relative flex flex-col items-center justify-center gap-0.5 rounded-lg px-2 py-2 transition-colors w-full",
              active
                ? "bg-sidebar-accent text-sidebar-accent-foreground before:absolute before:left-0 before:top-2 before:bottom-2 before:w-[2px] before:rounded-r-full before:bg-primary"
                : "text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
            );
          }}
        >
          <span className="relative">
            <Icon className="size-[18px]" />
            {count !== undefined && count > 0 && (
              <span className="absolute -top-1.5 -right-2.5 flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground text-[9px] font-semibold leading-none tabular-nums">
                {count > 99 ? "99" : count}
              </span>
            )}
            {hasAlert && (
              <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-destructive" />
            )}
          </span>
          <span className="text-[10px] font-medium leading-tight">
            {label}
          </span>
        </NavLink>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        {label}
        {count !== undefined && count > 0 && ` (${count})`}
      </TooltipContent>
    </Tooltip>
  );
}

function BottomTabItem({
  to,
  icon: Icon,
  label,
  end,
  count,
  isActive: isActiveProp,
  hasAlert,
}: {
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  end?: boolean;
  count?: number;
  isActive?: boolean;
  hasAlert?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive: navIsActive }) => {
        const active = isActiveProp ?? navIsActive;
        return cn(
          "relative flex flex-1 flex-col items-center justify-center gap-0.5 py-1.5 transition-colors",
          active
            ? "text-foreground"
            : "text-muted-foreground"
        );
      }}
    >
      <span className="relative">
        <Icon className="size-5" />
        {count !== undefined && count > 0 && (
          <span className="absolute -top-1 -right-2 flex size-3.5 items-center justify-center rounded-full bg-primary text-primary-foreground text-[8px] font-semibold leading-none tabular-nums">
            {count > 99 ? "99" : count}
          </span>
        )}
        {hasAlert && (
          <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-destructive" />
        )}
      </span>
      <span className="text-[10px] font-medium">{label}</span>
    </NavLink>
  );
}

export function ProjectLayout() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const logout = useAuthStore((s) => s.logout);
  const isMobile = useIsMobile();

  const resetFilesNavigation = useFilesStore((s) => s.resetNavigation);

  useEffect(() => {
    resetFilesNavigation();
  }, [projectId]);

  const { data: project, isLoading: projectLoading } = useProject(projectId!);
  const { data: files } = useFiles(projectId!);

  if (projectLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader size={20} />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3">
        <p className="text-sm text-muted-foreground">Project not found</p>
        <Button variant="outline" size="sm" onClick={() => navigate("/")}>
          Back to projects
        </Button>
      </div>
    );
  }

  const basePath = `/projects/${projectId}`;
  const projectColor = getProjectColor(project.name);

  // Determine if we're on the chat tab (not on /files or other subpages)
  const isOnSubpage =
    location.pathname.includes("/files") ||
    location.pathname.includes("/tasks") ||
    location.pathname.includes("/services") ||
    location.pathname.includes("/skills") ||
    location.pathname.includes("/settings");
  const isChatTab = !isOnSubpage;

  const navItems = [
    {
      to: basePath,
      icon: MessageSquareIcon,
      label: "Chat",
      isActive: isChatTab,
    },
    {
      to: `${basePath}/files`,
      icon: FolderIcon,
      label: "Files",
      count: files?.files?.length,
    },
    {
      to: `${basePath}/tasks`,
      icon: ClockIcon,
      label: "Tasks",
    },
    {
      to: `${basePath}/services`,
      icon: NetworkIcon,
      label: "Services",
    },
    {
      to: `${basePath}/skills`,
      icon: PuzzleIcon,
      label: "Skills",
    },
    {
      to: `${basePath}/settings`,
      icon: SettingsIcon,
      label: "Settings",
    },
  ] as const;

  const outletContent = isChatTab ? (
    <SidebarProvider className="min-h-0 h-full">
      <ChatSidebar projectId={projectId!} />
      <SidebarInset>
        <div className="flex flex-col h-full">
          <div className="flex items-center h-10 px-2 shrink-0 border-b md:border-b-0">
            <SidebarTrigger />
          </div>
          <div className="flex flex-col flex-1 overflow-hidden min-h-0">
            <Outlet context={{ project }} />
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  ) : (
    <Outlet context={{ project }} />
  );

  if (isMobile) {
    return (
      <div className="flex flex-col h-screen">
        {/* Mobile top bar */}
        <header className="shrink-0 border-b h-12 flex items-center px-3 gap-3 bg-background">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => navigate("/")}
            aria-label="Back to projects"
          >
            <ArrowLeftIcon className="size-4" />
          </Button>
          <span className="text-sm font-semibold truncate flex-1">
            {project.name}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={logout}
            aria-label="Sign out"
          >
            <LogOutIcon className="size-4" />
          </Button>
        </header>

        {/* Content */}
        <main className="flex-1 overflow-hidden min-h-0">
          {outletContent}
        </main>

        {/* Bottom tab bar */}
        <nav className="shrink-0 border-t bg-background flex items-stretch">
          {navItems.map((item) => (
            <BottomTabItem key={item.to} {...item} />
          ))}
        </nav>
        <FilePreviewModal projectId={projectId!} />
      </div>
    );
  }

  return (
    <div className="flex h-screen">
      {/* Desktop nav rail */}
      <aside className="w-16 shrink-0 border-r bg-sidebar flex flex-col items-center py-3 px-1.5 gap-1">
        {/* Back to projects */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => navigate("/")}
              className="group relative flex size-9 items-center justify-center rounded-lg mb-3 text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent/50 transition-colors"
              aria-label={`Back to projects — ${project.name}`}
            >
              <ArrowLeftIcon className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            Back to projects
          </TooltipContent>
        </Tooltip>

        {/* Nav items */}
        <nav className="flex flex-col items-center gap-1 flex-1 w-full">
          {navItems.map((item) => (
            <NavRailItem key={item.to} {...item} />
          ))}
        </nav>

        {/* Logout */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={logout}
              aria-label="Sign out"
              className="text-sidebar-foreground/50 hover:text-sidebar-foreground"
            >
              <LogOutIcon className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            Sign out
          </TooltipContent>
        </Tooltip>
      </aside>

      {/* Content */}
      <main className="flex-1 overflow-hidden h-full">
        {outletContent}
      </main>
      <FilePreviewModal projectId={projectId!} />
    </div>
  );
}
