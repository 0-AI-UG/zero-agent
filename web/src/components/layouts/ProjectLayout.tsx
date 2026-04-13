import { Outlet, NavLink, useParams, useNavigate, Link } from "react-router";
import { useProject } from "@/api/projects";
import { useFiles } from "@/hooks/use-files";
import { useAuthStore } from "@/stores/auth";
import { useCurrentUser } from "@/api/admin";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  SidebarProvider,
  SidebarInset,
  SidebarTrigger,
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuAction,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarFooter,
  useSidebar,
} from "@/components/ui/sidebar";
import { Loader } from "@/components/ai/loader";
import {
  CheckIcon,
  ChevronLeftIcon,
  ClockIcon,
  FolderIcon,
  LogOutIcon,
  MessageSquareIcon,
  PlusIcon,
  PuzzleIcon,
  NetworkIcon,
  SettingsIcon,
  TrashIcon,
  SendIcon,
  SearchIcon,
  XIcon,
  ChevronDownIcon,
  LoaderIcon,
  BotIcon,
  UserIcon,
  CircleHelpIcon,
  ShieldIcon,
  SquarePenIcon,
  PanelLeftIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useState, useEffect, useMemo } from "react";
import { useModelStore, type ModelConfig } from "@/stores/model";
import { useModels } from "@/api/models";
import { ModelSelectorLogo } from "@/components/ai/model-selector";
import { useFilesStore } from "@/stores/files-store";
import { useRealtime } from "@/hooks/use-realtime";
import { InstallBanner } from "@/components/InstallBanner";
import { PlanModeToggle } from "@/components/chat/PlanModeToggle";
import { ToolSelector } from "@/components/chat/ToolSelector";
import { useChats, useCreateChat, useDeleteChat, useSearchChats } from "@/api/chats";
import { useMembers } from "@/api/members";
import { useRealtimeStore } from "@/stores/realtime";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

function getProjectColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `oklch(0.65 0.15 ${hue})`;
}

const providerLabels: Record<string, string> = {
  minimax: "MiniMax",
  deepseek: "DeepSeek",
  alibaba: "Alibaba / Qwen",
  zhipuai: "Zhipu AI",
  moonshotai: "Moonshot",
  anthropic: "Anthropic",
  google: "Google",
  openai: "OpenAI",
};

function groupByProvider(modelList: ModelConfig[]) {
  const groups: Record<string, ModelConfig[]> = {};
  for (const model of modelList) {
    const key = model.provider;
    if (!groups[key]) groups[key] = [];
    groups[key].push(model);
  }
  return groups;
}

function MobileModelDropdown() {
  const selectedModelId = useModelStore((s) => s.selectedModelId);
  const setSelectedModelId = useModelStore((s) => s.setSelectedModelId);
  const { data: models = [] } = useModels();
  const selectedModel = models.find((m) => m.id === selectedModelId) ?? models[0];
  const grouped = useMemo(() => groupByProvider(models), [models]);

  if (!selectedModel) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="flex items-center gap-1.5 text-sm font-semibold hover:opacity-70 transition-opacity">
          <span>{selectedModel.name}</span>
          <ChevronDownIcon className="size-3.5 opacity-50" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="max-h-80 overflow-y-auto w-64">
        {Object.entries(grouped).map(([provider, providerModels]) => (
          <div key={provider}>
            <div className="px-2 py-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
              {providerLabels[provider] ?? provider}
            </div>
            {providerModels.map((model) => (
              <DropdownMenuItem
                key={model.id}
                onClick={() => setSelectedModelId(model.id)}
                className="flex items-center gap-2.5"
              >
                <ModelSelectorLogo provider={model.provider as any} className="size-3.5 shrink-0" />
                <span className="flex-1 truncate text-sm">{model.name}</span>
                {model.id === selectedModelId && (
                  <CheckIcon className="size-3.5 shrink-0 text-primary" />
                )}
              </DropdownMenuItem>
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MenuIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={className} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <line x1="2" y1="5.5" x2="14" y2="5.5" />
      <line x1="2" y1="10.5" x2="10" y2="10.5" />
    </svg>
  );
}

function MobileProjectHeader({ projectName, projectId }: { projectName: string; projectId: string }) {
  const navigate = useNavigate();
  const createChat = useCreateChat(projectId);
  const { setOpenMobile } = useSidebar();
  const { chatId } = useParams<{ chatId: string }>();

  const handleNewChat = async () => {
    const result = await createChat.mutateAsync();
    navigate(`/projects/${projectId}/c/${result.chat.id}`);
  };

  return (
    <header className="shrink-0 h-10 flex items-center px-3 gap-1.5 bg-background border-b border-border/30 md:hidden">
      <Button variant="ghost" size="icon-sm" onClick={() => setOpenMobile(true)} aria-label="Open menu">
        <MenuIcon className="size-4" />
      </Button>
      <div className="flex-1 min-w-0 flex items-center justify-center">
        <MobileModelDropdown />
      </div>
      <div className="flex items-center gap-0.5">
        {chatId && <PlanModeToggle chatId={chatId} />}
        <ToolSelector />
        <Button variant="ghost" size="icon-sm" onClick={handleNewChat} disabled={createChat.isPending}>
          <PlusIcon className="size-4" />
        </Button>
      </div>
    </header>
  );
}

const SOURCE_COLORS: Record<string, string> = {
  telegram: "text-[#2AABEE]",
  whatsapp: "text-[#25D366]",
  signal: "text-[#3A76F0]",
};

function CollapsedHeader({ onExpand, onNavigateHome }: { onExpand: () => void; onNavigateHome: () => void }) {
  return (
    <div className="hidden group-data-[collapsible=icon]:flex items-center justify-center">
      <button
        onClick={onNavigateHome}
        className="group/logo relative flex items-center justify-center size-8 rounded-md hover:bg-sidebar-accent transition-colors"
        aria-label="Back to projects"
      >
        <svg viewBox="0 0 32 32" fill="none" className="size-5 group-hover/logo:opacity-0 transition-opacity" aria-label="Zero AI">
          <ellipse cx="16" cy="16" rx="13" ry="5.5" transform="rotate(-30 16 16)" stroke="currentColor" strokeWidth="1.5" opacity="0.5"/>
          <path d="M16 5.5C12.2 5.5 9.5 9.8 9.5 16c0 6.2 2.7 10.5 6.5 10.5s6.5-4.3 6.5-10.5c0-6.2-2.7-10.5-6.5-10.5z" stroke="currentColor" strokeWidth="2.2"/>
          <circle cx="16" cy="16" r="2.5" fill="currentColor" opacity="0.9"/>
          <circle cx="5.5" cy="10.5" r="1.2" fill="currentColor" opacity="0.7"/>
          <circle cx="26.5" cy="21.5" r="1.2" fill="currentColor" opacity="0.7"/>
        </svg>
        <PanelLeftIcon
          className="size-4 absolute opacity-0 group-hover/logo:opacity-100 transition-opacity"
          onClick={(e) => { e.stopPropagation(); onExpand(); }}
        />
      </button>
    </div>
  );
}

function ExpandedHeader({ projectName, onNavigateHome }: { projectName: string; onNavigateHome: () => void }) {
  const { isMobile, setOpenMobile, toggleSidebar } = useSidebar();

  return (
    <div className="flex items-center group-data-[collapsible=icon]:hidden">
      <button
        onClick={onNavigateHome}
        className="flex items-center gap-1.5 text-xl font-bold tracking-tight font-display hover:opacity-70 transition-opacity truncate flex-1"
        aria-label="Back to projects"
      >
        <ChevronLeftIcon className="size-5 shrink-0" />
        <span className="truncate">{projectName}</span>
      </button>
      {isMobile ? (
        <Button variant="ghost" size="icon-sm" className="ml-auto" onClick={() => setOpenMobile(false)} aria-label="Close menu">
          <XIcon className="size-4" />
        </Button>
      ) : (
        <SidebarTrigger className="ml-auto" />
      )}
    </div>
  );
}

function ProjectSidebar({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const navigate = useNavigate();
  const { toggleSidebar, isMobile, setOpenMobile } = useSidebar();
  const logout = useAuthStore((s) => s.logout);
  const user = useAuthStore((s) => s.user);
  const { data: currentUser } = useCurrentUser();
  const isAdmin = currentUser?.isAdmin;
  const { chatId: activeChatId } = useParams<{ chatId: string }>();
  const { data: files } = useFiles(projectId);
  const { data: chats } = useChats(projectId);
  const createChat = useCreateChat(projectId);
  const deleteChat = useDeleteChat(projectId);
  const { data: membersData } = useMembers(projectId);
  const isMultiMember = (membersData?.members.length ?? 0) > 1;
  const memberMap = new Map(membersData?.members.map((m) => [m.userId, m.username]) ?? []);
  const presence = useRealtimeStore((s) => s.presence);
  const currentUserId = useAuthStore((s) => s.user?.id);

  const basePath = `/projects/${projectId}`;

  const handleNewChat = async () => {
    const result = await createChat.mutateAsync();
    navigate(`/projects/${projectId}/c/${result.chat.id}`);
    if (isMobile) setOpenMobile(false);
  };

  const handleDeleteChat = async (chatId: string) => {
    if (chatId === activeChatId) {
      const remaining = chats?.filter((c) => c.id !== chatId);
      if (remaining && remaining.length > 0) {
        navigate(`/projects/${projectId}/c/${remaining[0]!.id}`, { replace: true });
      } else {
        navigate(`/projects/${projectId}`, { replace: true });
      }
    }
    await deleteChat.mutateAsync(chatId);
  };

  const regularChats = chats?.filter((c) => !c.isAutonomous) ?? [];
  const autonomousChats = chats?.filter((c) => c.isAutonomous) ?? [];
  const [searchOpen, setSearchOpen] = useState(false);

  const initials = user?.username
    ? user.username.slice(0, 2).toUpperCase()
    : "U";

  const navItems = [
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
      label: "Apps",
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
  ];

  return (
    <Sidebar collapsible="icon" className="[--sidebar:var(--background)]">
      <SidebarHeader className="flex-col gap-2">
        <CollapsedHeader onExpand={toggleSidebar} onNavigateHome={() => navigate("/")} />
        <ExpandedHeader projectName={projectName} onNavigateHome={() => navigate("/")} />
      </SidebarHeader>

      <SidebarContent>
        {/* Top actions + Navigation items */}
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton onClick={handleNewChat} disabled={createChat.isPending} tooltip="New chat">
                  <PlusIcon className="size-4" />
                  <span>New chat</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton onClick={() => setSearchOpen(true)} tooltip="Search chats">
                  <SearchIcon className="size-4" />
                  <span>Search chats</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {navItems.map((item) => (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton asChild tooltip={item.label}>
                    <NavLink
                      to={item.to}
                      className={({ isActive }) =>
                        isActive ? "font-medium" : ""
                      }
                      onClick={() => { if (isMobile) setOpenMobile(false); }}
                    >
                      <item.icon className="size-4" />
                      <span>{item.label}</span>
                      {item.count !== undefined && item.count > 0 && (
                        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                          {item.count}
                        </span>
                      )}
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Chats section - hidden in collapsed sidebar */}
        <SidebarGroup className="flex-1 min-h-0 group-data-[collapsible=icon]:hidden">
          <SidebarGroupLabel>Chats</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {regularChats.map((chat) => {
                const source = chat.source;
                const iconColor = source ? SOURCE_COLORS[source] ?? "text-muted-foreground" : null;
                const chatViewers = presence.filter(
                  (u) => u.chatId === chat.id && u.userId !== currentUserId,
                );
                const hasStreaming = chatViewers.some((u) => u.isStreaming) ||
                  presence.some((u) => u.chatId === chat.id && u.isStreaming);

                return (
                  <SidebarMenuItem key={chat.id}>
                    <SidebarMenuButton
                      isActive={chat.id === activeChatId}
                      onClick={() => {
                        navigate(`/projects/${projectId}/c/${chat.id}`);
                        if (isMobile) setOpenMobile(false);
                      }}
                    >
                      {source && (
                        <SendIcon className={`size-3.5 shrink-0 ${iconColor}`} />
                      )}
                      <div className="flex flex-col min-w-0 flex-1">
                        <span className="truncate">{chat.title}</span>
                        {isMultiMember && chat.createdBy && (
                          <span className="text-[10px] text-muted-foreground truncate">
                            {memberMap.get(chat.createdBy)?.split("@")[0] ?? ""}
                          </span>
                        )}
                      </div>
                      {(chatViewers.length > 0 || hasStreaming) && (
                        <span
                          className={`w-1.5 h-1.5 rounded-full shrink-0 ${hasStreaming ? "bg-green-500 animate-pulse" : "bg-muted-foreground/40"}`}
                          title={chatViewers.map((u) => u.username).join(", ")}
                        />
                      )}
                    </SidebarMenuButton>
                    <SidebarMenuAction
                      showOnHover
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteChat(chat.id);
                      }}
                      aria-label={`Delete ${chat.title}`}
                    >
                      <TrashIcon className="size-3.5" />
                    </SidebarMenuAction>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>

            {autonomousChats.length > 0 && (
              <ActivityGroup
                chats={autonomousChats}
                activeChatId={activeChatId}
                projectId={projectId}
                onNavigate={(chatId) => { navigate(`/projects/${projectId}/c/${chatId}`); if (isMobile) setOpenMobile(false); }}
                onDelete={handleDeleteChat}
              />
            )}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      {/* Profile section at bottom */}
      <SidebarFooter>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-2.5 w-full px-2 py-1.5 rounded-lg text-sm hover:bg-sidebar-accent/50 transition-colors text-left group-data-[collapsible=icon]:w-8 group-data-[collapsible=icon]:h-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0 group-data-[collapsible=icon]:mx-auto group-data-[collapsible=icon]:rounded-full">
              <Avatar className="size-7 shrink-0">
                <AvatarFallback className="text-[10px] bg-blue-100 text-blue-700 dark:bg-primary/10 dark:text-primary">
                  {initials}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0 group-data-[collapsible=icon]:hidden">
                <p className="text-sm font-medium truncate">
                  {user?.username || "User"}
                </p>
              </div>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            align="start"
            className="w-[var(--radix-dropdown-menu-trigger-width)]"
          >
            <DropdownMenuItem asChild>
              <Link to={`${basePath}/account`}>
                <UserIcon />
                Settings
              </Link>
            </DropdownMenuItem>
            {isAdmin && (
              <DropdownMenuItem asChild>
                <Link to={`${basePath}/admin`}>
                  <ShieldIcon />
                  Admin
                </Link>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem asChild>
              <Link to={`${basePath}/help`}>
                <CircleHelpIcon />
                Help
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={logout}>
              <LogOutIcon />
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarFooter>

      <ChatSearchDialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        projectId={projectId}
        onSelect={(chatId) => {
          navigate(`/projects/${projectId}/c/${chatId}`);
          setSearchOpen(false);
        }}
        onNewChat={async () => {
          setSearchOpen(false);
          await handleNewChat();
        }}
      />
    </Sidebar>
  );
}

function ChatSearchDialog({
  open,
  onOpenChange,
  projectId,
  onSelect,
  onNewChat,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  onSelect: (chatId: string) => void;
  onNewChat: () => void;
}) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setDebouncedQuery("");
    }
  }, [open]);

  const isSearching = debouncedQuery.length > 0;
  const searchResults = useSearchChats(projectId, debouncedQuery);
  const { data: allChats } = useChats(projectId);

  const displayChats = isSearching
    ? searchResults.data?.results.map((r) => ({ id: r.chatId, title: r.title, snippet: r.snippet })) ?? []
    : (allChats ?? []).map((c) => ({ id: c.id, title: c.title, snippet: undefined as string | undefined }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl p-0 gap-0 top-[20%] translate-y-0" showCloseButton={false}>
        <DialogHeader className="sr-only">
          <DialogTitle>Search chats</DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-3 border-b px-5 py-4">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats..."
            className="border-0 shadow-none focus-visible:ring-0 h-auto p-0 text-base bg-transparent dark:bg-transparent"
            autoFocus
          />
          <button
            onClick={() => onOpenChange(false)}
            className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground transition-colors"
          >
            <XIcon className="size-5" />
          </button>
        </div>
        <div className="max-h-[50vh] overflow-y-auto py-2">
          <button
            onClick={onNewChat}
            className="flex w-full items-center gap-4 px-5 py-3 text-sm hover:bg-accent transition-colors"
          >
            <SquarePenIcon className="size-5 shrink-0 text-muted-foreground" />
            <span>New chat</span>
          </button>

          {isSearching && searchResults.isLoading && (
            <div className="flex items-center justify-center py-8">
              <LoaderIcon className="size-5 animate-spin text-muted-foreground" />
            </div>
          )}

          {isSearching && searchResults.data?.results.length === 0 && !searchResults.isLoading && (
            <p className="text-sm text-muted-foreground px-5 py-8 text-center">No matching conversations</p>
          )}

          {displayChats.length > 0 && (
            <div className="mt-1">
              {isSearching && (
                <p className="px-5 py-2 text-xs font-medium text-muted-foreground">Results</p>
              )}
              {displayChats.map((chat) => (
                <button
                  key={chat.id}
                  onClick={() => onSelect(chat.id)}
                  className="flex w-full items-center gap-4 px-5 py-3 text-sm hover:bg-accent transition-colors text-left"
                >
                  <MessageSquareIcon className="size-5 shrink-0 text-muted-foreground" />
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="truncate">{chat.title}</span>
                    {chat.snippet && (
                      <span className="truncate text-xs text-muted-foreground mt-0.5">{chat.snippet}</span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ActivityGroup({
  chats,
  activeChatId,
  projectId,
  onNavigate,
  onDelete,
}: {
  chats: { id: string; title: string }[];
  activeChatId?: string;
  projectId: string;
  onNavigate: (chatId: string) => void;
  onDelete: (chatId: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="mt-2">
      <button
        className="flex items-center gap-1 px-2 text-xs font-medium text-sidebar-foreground/70 cursor-pointer select-none hover:text-sidebar-foreground"
        onClick={() => setCollapsed(!collapsed)}
      >
        Activity
        <ChevronDownIcon
          className={`size-3 transition-transform ${collapsed ? "-rotate-90" : ""}`}
        />
      </button>
      {!collapsed && (
        <SidebarMenu className="mt-1">
          {chats.map((chat) => (
            <SidebarMenuItem key={chat.id}>
              <SidebarMenuButton
                isActive={chat.id === activeChatId}
                onClick={() => onNavigate(chat.id)}
              >
                <BotIcon className="size-3.5 shrink-0" />
                <span className="truncate">{chat.title}</span>
              </SidebarMenuButton>
              <SidebarMenuAction
                showOnHover
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(chat.id);
                }}
                aria-label={`Delete ${chat.title}`}
              >
                <TrashIcon className="size-3.5" />
              </SidebarMenuAction>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      )}
    </div>
  );
}

export function ProjectLayout() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  const resetFilesNavigation = useFilesStore((s) => s.resetNavigation);
  useRealtime(projectId);

  useEffect(() => {
    resetFilesNavigation();
  }, [projectId]);

  const { data: project, isLoading: projectLoading } = useProject(projectId!);

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

  return (
    <SidebarProvider className="h-screen">
      <ProjectSidebar projectId={projectId!} projectName={project.name} />
      <SidebarInset>
        <div className="flex min-w-0 flex-col h-full overflow-hidden">
          <MobileProjectHeader projectName={project.name} projectId={projectId!} />
          <Outlet context={{ project }} />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
