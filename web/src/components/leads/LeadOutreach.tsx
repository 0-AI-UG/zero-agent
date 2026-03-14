import { useLeadOutreach, useApproveMessage, useEditMessage, useRecordReply } from "@/api/outreach";
import type { OutreachMessage } from "@/api/outreach";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  CopyIcon,
  CheckIcon,
  SendIcon,
  MailIcon,
  MessageSquareIcon,
  HashIcon,
  AlertCircleIcon,
  ClockIcon,
  XCircleIcon,
  ThumbsUpIcon,
  ThumbsDownIcon,
  ReplyIcon,
  PencilIcon,
} from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

const CHANNEL_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  direct_message: MessageSquareIcon,
  comment: HashIcon,
  email: MailIcon,
  manual: SendIcon,
};

const CHANNEL_LABEL: Record<string, string> = {
  direct_message: "DM",
  comment: "Comment",
  email: "Email",
  manual: "Manual",
};

const STATUS_STYLE: Record<string, { icon: React.ComponentType<{ className?: string }>; color: string; label: string }> = {
  pending: { icon: ClockIcon, color: "text-amber-500", label: "Pending approval" },
  approved: { icon: ClockIcon, color: "text-blue-500", label: "Approved - awaiting send" },
  sent: { icon: CheckIcon, color: "text-emerald-500", label: "Sent" },
  delivered: { icon: CheckIcon, color: "text-emerald-500", label: "Delivered" },
  failed: { icon: AlertCircleIcon, color: "text-destructive", label: "Failed" },
  replied: { icon: MessageSquareIcon, color: "text-purple-500", label: "Replied" },
  rejected: { icon: XCircleIcon, color: "text-muted-foreground", label: "Rejected" },
};

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={handleCopy}
      className="shrink-0 text-muted-foreground/60 hover:text-muted-foreground transition-colors"
    >
      {copied ? <CheckIcon className="size-3 text-emerald-500" /> : <CopyIcon className="size-3" />}
    </Button>
  );
}

function ReplyInput({
  onSubmit,
  isSubmitting,
}: {
  onSubmit: (text: string) => void;
  isSubmitting: boolean;
}) {
  const [text, setText] = useState("");
  const [expanded, setExpanded] = useState(false);

  if (!expanded) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-[11px] text-muted-foreground"
        onClick={() => setExpanded(true)}
      >
        <ReplyIcon className="size-3 mr-1" />
        Add reply
      </Button>
    );
  }

  return (
    <div className="flex gap-1.5 items-end max-w-[85%]">
      <textarea
        className="flex-1 min-h-[60px] rounded-lg border bg-muted/50 px-2.5 py-1.5 text-xs resize-none focus:outline-none focus:ring-1 focus:ring-ring"
        placeholder="What did the lead reply?"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setExpanded(false);
            setText("");
          }
        }}
        autoFocus
      />
      <div className="flex flex-col gap-1">
        <Button
          variant="default"
          size="sm"
          className="h-6 px-2 text-[11px]"
          disabled={!text.trim() || isSubmitting}
          onClick={() => {
            onSubmit(text.trim());
            setText("");
            setExpanded(false);
          }}
        >
          Save
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[11px]"
          onClick={() => {
            setExpanded(false);
            setText("");
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  onApprove,
  onReject,
  onEdit,
  onRecordReply,
  isActioning,
  isEditing,
  isRecordingReply,
}: {
  message: OutreachMessage;
  onApprove: () => void;
  onReject: () => void;
  onEdit: (body: string) => void;
  onRecordReply: (text: string) => void;
  isActioning: boolean;
  isEditing: boolean;
  isRecordingReply: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(message.body);

  const ChannelIcon = CHANNEL_ICON[message.channel] ?? SendIcon;
  const statusInfo = (STATUS_STYLE[message.status] ?? STATUS_STYLE.pending)!;
  const StatusIcon = statusInfo.icon;
  const isRejected = message.status === "rejected";
  const isPending = message.status === "pending";
  const isApproved = message.status === "approved";
  const canEdit = isPending || isApproved;
  const canAddReply = message.status === "sent" || message.status === "delivered";
  const time = message.sentAt ?? message.createdAt;

  const handleSaveEdit = () => {
    const trimmed = editText.trim();
    if (trimmed && trimmed !== message.body.trim()) {
      onEdit(trimmed);
    }
    setEditing(false);
  };

  return (
    <>
      {/* Outgoing message bubble (right-aligned) */}
      <div className="group flex flex-col gap-1 items-end">
        <div
          className={cn(
            "relative max-w-[85%] rounded-xl px-3.5 py-2.5",
            isRejected && "opacity-50",
            "bg-primary/10 rounded-tr-sm"
          )}
        >
          {editing ? (
            <div className="flex flex-col gap-1.5 min-w-[300px]">
              <textarea
                className="w-full min-h-[160px] rounded-lg border bg-background px-2.5 py-1.5 text-sm resize-y focus:outline-none focus:ring-1 focus:ring-ring"
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setEditing(false);
                    setEditText(message.body);
                  }
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    handleSaveEdit();
                  }
                }}
                autoFocus
              />
              <div className="flex justify-end gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => {
                    setEditing(false);
                    setEditText(message.body);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  className="h-6 px-2 text-[11px]"
                  disabled={!editText.trim() || isEditing}
                  onClick={handleSaveEdit}
                >
                  Save
                </Button>
              </div>
            </div>
          ) : message.body ? (
            <p className={cn("text-xs whitespace-pre-wrap leading-relaxed", isRejected && "line-through")}>
              {message.body.trim()}
            </p>
          ) : (
            <p className="text-xs italic text-muted-foreground">Empty message</p>
          )}
        </div>
        <div className="flex items-center gap-1.5 px-1">
          {message.body && <CopyButton text={message.body.trim()} />}
          {canEdit && !editing && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => {
                setEditText(message.body);
                setEditing(true);
              }}
              className="shrink-0 text-muted-foreground/60 hover:text-muted-foreground transition-colors"
            >
              <PencilIcon className="size-3" />
            </Button>
          )}
          <ChannelIcon className="size-2.5 text-muted-foreground" />
          <span className="text-[10px] text-muted-foreground">
            {CHANNEL_LABEL[message.channel] ?? message.channel}
          </span>
          <StatusIcon className={cn("size-2.5", statusInfo.color)} />
          <span className={cn("text-[10px]", statusInfo.color)}>{statusInfo.label}</span>
          <span className="text-[10px] text-muted-foreground/60">
            {new Date(time).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </div>
        {message.status === "failed" && message.error && (
          <p className="text-[11px] text-destructive px-1 max-w-[85%]">{message.error}</p>
        )}
        {isPending && !editing && (
          <div className="flex items-center gap-1.5 px-1">
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[11px] text-emerald-600 border-emerald-200 hover:bg-emerald-50 dark:hover:bg-emerald-950"
              onClick={onApprove}
              disabled={isActioning}
            >
              <ThumbsUpIcon className="size-3 mr-1" />
              Approve
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[11px] text-muted-foreground"
              onClick={onReject}
              disabled={isActioning}
            >
              <ThumbsDownIcon className="size-3 mr-1" />
              Reject
            </Button>
          </div>
        )}
      </div>

      {/* Reply bubble (left-aligned) if there's a reply */}
      {message.replyBody && (
        <div className="flex flex-col gap-1 items-start">
          <div className="group relative max-w-[85%] rounded-xl px-3.5 py-2.5 bg-muted rounded-tl-sm">
            <p className="text-xs whitespace-pre-wrap leading-relaxed">
              {message.replyBody.trim()}
            </p>
          </div>
          <div className="flex items-center gap-1.5 px-1">
            <CopyButton text={message.replyBody.trim()} />
            <ReplyIcon className="size-2.5 text-purple-500" />
            <span className="text-[10px] text-purple-500">Lead reply</span>
            {message.repliedAt && (
              <span className="text-[10px] text-muted-foreground/60">
                {new Date(message.repliedAt).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Add reply input for sent messages without a reply */}
      {canAddReply && (
        <div className="flex flex-col gap-1 items-start">
          <ReplyInput onSubmit={onRecordReply} isSubmitting={isRecordingReply} />
        </div>
      )}
    </>
  );
}

interface LeadOutreachProps {
  projectId: string;
  leadId: string;
}

export function LeadOutreach({ projectId, leadId }: LeadOutreachProps) {
  const { data, isLoading } = useLeadOutreach(projectId, leadId);
  const approveMessage = useApproveMessage(projectId, leadId);
  const editMessage = useEditMessage(projectId, leadId);
  const recordReply = useRecordReply(projectId, leadId);

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-16 w-3/4 ml-auto rounded-xl" />
        <Skeleton className="h-16 w-3/4 rounded-xl" />
        <Skeleton className="h-16 w-3/4 ml-auto rounded-xl" />
      </div>
    );
  }

  const messages = data?.messages ?? [];

  if (messages.length === 0) {
    return (
      <div className="text-center py-8">
        <MessageSquareIcon className="size-8 text-muted-foreground/30 mx-auto mb-2" />
        <p className="text-xs text-muted-foreground">No outreach messages yet</p>
      </div>
    );
  }

  // Sort by created date ascending (oldest first, like a chat)
  const sorted = [...messages].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );

  return (
    <div className="flex flex-col gap-3">
      {sorted.map((msg) => (
        <MessageBubble
          key={msg.id}
          message={msg}
          onApprove={() => approveMessage.mutate({ messageId: msg.id, action: "approve" })}
          onReject={() => approveMessage.mutate({ messageId: msg.id, action: "reject" })}
          onEdit={(body) => editMessage.mutate({ messageId: msg.id, body })}
          onRecordReply={(text) => recordReply.mutate({ messageId: msg.id, replyBody: text })}
          isActioning={approveMessage.isPending}
          isEditing={editMessage.isPending}
          isRecordingReply={recordReply.isPending}
        />
      ))}
    </div>
  );
}
