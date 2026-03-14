import { useState } from "react";
import { useNavigate } from "react-router";
import { BellIcon, CheckIcon, CheckCheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useNotifications, useMarkRead, useMarkAllRead } from "@/api/notifications";
import { useAcceptInvitation, useDeclineInvitation } from "@/api/invitations";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const { data } = useNotifications();
  const markRead = useMarkRead();
  const markAllRead = useMarkAllRead();
  const acceptInvite = useAcceptInvitation();
  const declineInvite = useDeclineInvitation();
  const navigate = useNavigate();

  const unreadCount = data?.unreadCount ?? 0;
  const notifications = data?.notifications ?? [];

  function getNotificationText(n: (typeof notifications)[0]) {
    switch (n.type) {
      case "invite":
        return `You're invited to join "${n.data.projectName}"`;
      case "invite_accepted":
        return `${n.data.acceptedByEmail} accepted your invitation to "${n.data.projectName}"`;
      case "member_removed":
        return `You were removed from "${n.data.projectName}"`;
      case "task_completed":
        return `Task "${n.data.taskName}" completed in "${n.data.projectName}"`;
      case "task_failed":
        return `Task "${n.data.taskName}" failed in "${n.data.projectName}"`;
      case "outreach_replied":
        return `${n.data.leadName} replied to your outreach in "${n.data.projectName}"`;
      case "lead_converted":
        return `Lead "${n.data.leadName}" was converted in "${n.data.projectName}"`;
      default:
        return "Notification";
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="relative"
          aria-label="Notifications"
        >
          <BellIcon className="size-4" />
          {unreadCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground text-[9px] font-semibold leading-none">
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between px-3 py-2 border-b">
          <span className="text-xs font-semibold">Notifications</span>
          {unreadCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-[10px] px-2"
              onClick={() => markAllRead.mutate()}
            >
              <CheckCheckIcon className="size-3 mr-1" />
              Mark all read
            </Button>
          )}
        </div>
        <div className="max-h-72 overflow-y-auto">
          {notifications.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-6">
              No notifications
            </p>
          )}
          {notifications.map((n) => (
            <div
              key={n.id}
              className={cn(
                "px-3 py-2.5 border-b last:border-0 text-xs",
                !n.read && "bg-muted/50",
              )}
            >
              <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <p className="leading-relaxed">{getNotificationText(n)}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    {formatDistanceToNow(new Date(n.createdAt), { addSuffix: true })}
                  </p>
                </div>
                {!n.read && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="size-5 shrink-0"
                    onClick={() => markRead.mutate(n.id)}
                  >
                    <CheckIcon className="size-3" />
                  </Button>
                )}
              </div>
              {n.type === "invite" && !n.read && n.data.invitationId && (
                <div className="flex items-center gap-2 mt-2">
                  <Button
                    size="sm"
                    className="h-6 text-[10px] px-2"
                    disabled={acceptInvite.isPending}
                    onClick={() => {
                      acceptInvite.mutate(n.data.invitationId!, {
                        onSuccess: () => {
                          markRead.mutate(n.id);
                          navigate(`/projects/${n.data.projectId}`);
                          setOpen(false);
                        },
                      });
                    }}
                  >
                    Accept
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 text-[10px] px-2"
                    disabled={declineInvite.isPending}
                    onClick={() => {
                      declineInvite.mutate(n.data.invitationId!, {
                        onSuccess: () => markRead.mutate(n.id),
                      });
                    }}
                  >
                    Decline
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
