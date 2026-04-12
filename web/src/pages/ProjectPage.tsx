import { useEffect, useMemo, useRef } from "react";
import { useParams, useNavigate } from "react-router";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { useChats, useCreateChat } from "@/api/chats";
import { useMessages } from "@/api/messages";
import { Loader } from "@/components/ai/loader";

export function ProjectPage() {
  const { projectId, chatId } = useParams<{
    projectId: string;
    chatId: string;
  }>();
  const navigate = useNavigate();

  const { data: chats, isLoading: chatsLoading } = useChats(projectId!);
  const createChat = useCreateChat(projectId!);
  const creatingChatRef = useRef(false);

  useEffect(() => {
    if (chatId) {
      creatingChatRef.current = false;
      return;
    }
    if (chatsLoading || createChat.isPending || creatingChatRef.current) return;

    if (chats && chats.length > 0) {
      navigate(`/projects/${projectId}/c/${chats[0]!.id}`, { replace: true });
    } else if (chats && chats.length === 0) {
      creatingChatRef.current = true;
      createChat.mutateAsync().then((result) => {
        navigate(`/projects/${projectId}/c/${result.chat.id}`, {
          replace: true,
        });
      });
    }
  }, [chatId, chats, chatsLoading, createChat.isPending, projectId, navigate]);

  const { data: messagesData, isLoading: messagesLoading } = useMessages(
    projectId!,
    chatId ?? "",
  );
  const initialMessages = messagesData?.messages;
  const initialIsStreaming = messagesData?.isStreaming ?? false;

  const activeChat = useMemo(
    () => chats?.find((c) => c.id === chatId),
    [chats, chatId],
  );
  const isAutonomous = activeChat?.isAutonomous ?? false;
  const chatSource = activeChat?.source ?? null;

  if (!chatId || chatsLoading || messagesLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader size={16} />
      </div>
    );
  }

  return (
    <ChatPanel
      key={chatId}
      projectId={projectId!}
      chatId={chatId}
      initialMessages={initialMessages}
      initialIsStreaming={initialIsStreaming}
      isAutonomous={isAutonomous}
      source={chatSource}
    />
  );
}
