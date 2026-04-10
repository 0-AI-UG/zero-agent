import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router";
import { useChats, useCreateChat, useDeleteChat, useSearchChats } from "@/api/chats";
import {
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
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BotIcon, PlusIcon, TrashIcon, SendIcon, SearchIcon, XIcon, ChevronDownIcon, LoaderIcon } from "lucide-react";
import { useMembers } from "@/api/members";
import { useRealtimeStore } from "@/stores/realtime";
import { useAuthStore } from "@/stores/auth";

const SOURCE_COLORS: Record<string, string> = {
  telegram: "text-[#2AABEE]",
  whatsapp: "text-[#25D366]",
  signal: "text-[#3A76F0]",
};

export function ChatSidebar({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const { chatId: activeChatId } = useParams<{ chatId: string }>();
  const { data: chats } = useChats(projectId);
  const createChat = useCreateChat(projectId);
  const deleteChat = useDeleteChat(projectId);
  const { data: membersData } = useMembers(projectId);
  const isMultiMember = (membersData?.members.length ?? 0) > 1;
  const memberMap = new Map(membersData?.members.map((m) => [m.userId, m.username]) ?? []);
  const presence = useRealtimeStore((s) => s.presence);
  const currentUserId = useAuthStore((s) => s.user?.id);

  const handleNewChat = async () => {
    const result = await createChat.mutateAsync();
    navigate(`/projects/${projectId}/c/${result.chat.id}`);
  };

  const handleDeleteChat = async (chatId: string) => {
    // If we're deleting the active chat, navigate away first
    if (chatId === activeChatId) {
      const remaining = chats?.filter((c) => c.id !== chatId);
      if (remaining && remaining.length > 0) {
        navigate(`/projects/${projectId}/c/${remaining[0]!.id}`, { replace: true });
      } else {
        navigate(`/projects/${projectId}`, { replace: true });
      }
    }

    // Optimistic cache update + rollback handled by the mutation hook
    await deleteChat.mutateAsync(chatId);
  };

  const [searchInput, setSearchInput] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchInput.trim()), 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const isSearching = debouncedQuery.length > 0;
  const searchQuery = useSearchChats(projectId, debouncedQuery);

  const regularChats = chats?.filter((c) => !c.isAutonomous) ?? [];
  const autonomousChats = chats?.filter((c) => c.isAutonomous) ?? [];

  return (
    <Sidebar className="left-16">
      <SidebarHeader className="flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold px-1">Chats</span>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={handleNewChat}
            disabled={createChat.isPending}
            aria-label="New Chat"
          >
            <PlusIcon className="size-4" />
          </Button>
        </div>
        <div className="relative">
          <SearchIcon className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search conversations..."
            className="pl-7 pr-7 h-8 text-xs"
          />
          {searchInput && (
            <button
              onClick={() => { setSearchInput(""); setDebouncedQuery(""); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <XIcon className="size-3.5" />
            </button>
          )}
        </div>
      </SidebarHeader>
      <SidebarContent className="scroll-shadow">
        {isSearching ? (
          <SidebarGroup>
            <SidebarGroupLabel>Search results</SidebarGroupLabel>
            <SidebarGroupContent>
              {searchQuery.isLoading && (
                <div className="flex items-center justify-center py-4">
                  <LoaderIcon className="size-4 animate-spin text-muted-foreground" />
                </div>
              )}
              {searchQuery.data?.results.length === 0 && !searchQuery.isLoading && (
                <p className="text-xs text-muted-foreground px-3 py-4">No matching conversations</p>
              )}
              <SidebarMenu>
                {searchQuery.data?.results.map((result) => (
                  <SidebarMenuItem key={result.chatId}>
                    <SidebarMenuButton
                      isActive={result.chatId === activeChatId}
                      onClick={() => {
                        navigate(`/projects/${projectId}/c/${result.chatId}`);
                        setSearchInput("");
                        setDebouncedQuery("");
                      }}
                    >
                      <div className="flex flex-col min-w-0 gap-0.5">
                        <span className="truncate text-xs font-medium">{result.title}</span>
                        <span className="truncate text-[11px] text-muted-foreground">{result.snippet}</span>
                      </div>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ) : (
        <>
        <SidebarGroup>
          <SidebarGroupLabel className="sr-only">Chat list</SidebarGroupLabel>
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
                      onClick={() =>
                        navigate(`/projects/${projectId}/c/${chat.id}`)
                      }
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
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Autonomous activity chats */}
        {autonomousChats.length > 0 && (
          <ActivityGroup
            chats={autonomousChats}
            activeChatId={activeChatId}
            projectId={projectId!}
            onNavigate={(chatId) => navigate(`/projects/${projectId}/c/${chatId}`)}
            onDelete={handleDeleteChat}
          />
        )}
        </>
        )}
      </SidebarContent>
    </Sidebar>
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
    <SidebarGroup>
      <SidebarGroupLabel
        className="cursor-pointer select-none"
        onClick={() => setCollapsed(!collapsed)}
      >
        <span className="flex items-center gap-1">
          Activity
          <ChevronDownIcon
            className={`size-3 transition-transform ${collapsed ? "-rotate-90" : ""}`}
          />
        </span>
      </SidebarGroupLabel>
      {!collapsed && (
        <SidebarGroupContent>
          <SidebarMenu>
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
        </SidebarGroupContent>
      )}
    </SidebarGroup>
  );
}
