import { useNavigate, useParams } from "react-router";
import { useChats, useCreateChat, useDeleteChat } from "@/api/chats";
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
import { BotIcon, PlusIcon, TrashIcon, SendIcon } from "lucide-react";
import { useMembers } from "@/api/members";

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
  const memberMap = new Map(membersData?.members.map((m) => [m.userId, m.email]) ?? []);

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

  const regularChats = chats?.filter((c) => !c.isAutonomous) ?? [];
  const autonomousChats = chats?.filter((c) => c.isAutonomous) ?? [];

  return (
    <Sidebar className="left-16">
      <SidebarHeader className="flex-row items-center justify-between">
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
      </SidebarHeader>
      <SidebarContent className="scroll-shadow">
        <SidebarGroup>
          <SidebarGroupLabel className="sr-only">Chat list</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {regularChats.map((chat) => {
                const source = chat.source;
                const iconColor = source ? SOURCE_COLORS[source] ?? "text-muted-foreground" : null;

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
                      <div className="flex flex-col min-w-0">
                        <span className="truncate">{chat.title}</span>
                        {isMultiMember && chat.createdBy && (
                          <span className="text-[10px] text-muted-foreground truncate">
                            {memberMap.get(chat.createdBy)?.split("@")[0] ?? ""}
                          </span>
                        )}
                      </div>
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
          <SidebarGroup>
            <SidebarGroupLabel>Activity</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {autonomousChats.map((chat) => (
                  <SidebarMenuItem key={chat.id}>
                    <SidebarMenuButton
                      isActive={chat.id === activeChatId}
                      onClick={() =>
                        navigate(`/projects/${projectId}/c/${chat.id}`)
                      }
                    >
                      <BotIcon className="size-3.5 shrink-0" />
                      <span>{chat.title}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>
    </Sidebar>
  );
}
