import { useRealtimeStore } from "@/stores/realtime";
import { useAuthStore } from "@/stores/auth";

/** Minimal presence dots — shown inline next to a chat title. */
export function PresenceDots({ chatId }: { chatId: string }) {
  const presence = useRealtimeStore((s) => s.presence);
  const currentUserId = useAuthStore((s) => s.user?.id);

  const viewers = presence.filter(
    (u) => u.chatId === chatId && u.userId !== currentUserId,
  );

  if (viewers.length === 0) return null;

  return (
    <div className="flex items-center gap-0.5">
      {viewers.slice(0, 4).map((user) => (
        <span
          key={user.userId}
          className="w-2 h-2 rounded-full bg-muted-foreground/40"
          title={user.username}
        />
      ))}
    </div>
  );
}

/** Returns users currently typing in this chat (excluding current user). */
export function useTypingUsers(chatId: string) {
  const typing = useRealtimeStore((s) => s.typing);
  const currentUserId = useAuthStore((s) => s.user?.id);
  return typing.filter(
    (t) => t.chatId === chatId && t.userId !== currentUserId && t.expiresAt > Date.now(),
  );
}
