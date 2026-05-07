/**
 * NotificationToast - unified custom-content toast for every server-sent
 * notification on the WebSocket. Replaces the old NotificationReplyToast.
 *
 * Three render modes derived from the dispatcher payload:
 *
 *   1. **Action buttons** (`actions[]` present) - clicking a button POSTs
 *      that action's `id` as the response text. Used by pending-response
 *      flows like CLI requests or plan review prompts.
 *
 *   2. **Free-text reply** (`requiresReply` and no actions) - renders an
 *      inline input. Used by `zero message send --respond`.
 *
 *   3. **Plain notification** (no reply requested) - title + body, with an
 *      optional "Open" link if a URL was provided. Auto-dismisses on the
 *      sonner-default duration.
 *
 * Visual style is intentionally minimal: flat text on the popover surface,
 * no kind accent. A small "X" in the top-right always lets the user dismiss
 * the toast locally - important for sticky interactive variants that
 * otherwise wait forever for an action. Per project preference, no animations.
 */
import { useState, type FormEvent } from "react";
import { XIcon } from "lucide-react";
import { toast } from "sonner";
import { respondToPending } from "@/api/pending-responses";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface NotificationAction {
  id: string;
  label: string;
}

export interface NotificationToastProps {
  toastId: string | number;
  title: string;
  body: string;
  /** Notification kind (e.g. "cli_request", "plan_review"). Currently unused
   *  visually - kept on the interface so the dispatcher payload can pass it. */
  kind?: string;
  /** When present, render as buttons. The button id is POSTed as the response text. */
  actions?: NotificationAction[];
  /** When true and no actions, render a text input. */
  requiresReply?: boolean;
  /** Pending-response row id (per-user). Required for any reply path. */
  responseId?: string;
  /** Optional click-through URL for plain notifications. */
  url?: string;
}

export function NotificationToast({
  toastId,
  title,
  body,
  actions,
  requiresReply,
  responseId,
  url,
}: NotificationToastProps) {
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const hasActions = !!actions && actions.length > 0 && !!responseId;
  const hasReplyInput = !hasActions && requiresReply && !!responseId;

  async function send(value: string, actionId: string) {
    if (!responseId || submitting) return;
    setSubmitting(actionId);
    setError(null);
    try {
      const result = await respondToPending(responseId, value);
      if (result.ok) {
        toast.dismiss(toastId);
      } else if (result.status === "resolved") {
        toast.dismiss(toastId);
      } else if (result.status === "expired") {
        toast.dismiss(toastId);
        toast.warning("Request expired");
      } else if (result.status === "cancelled") {
        toast.dismiss(toastId);
        toast.info("Request cancelled");
      } else {
        setError("Couldn't send reply");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send reply");
    } finally {
      setSubmitting(null);
    }
  }

  function onSubmitReply(e: FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    void send(trimmed, "reply");
  }

  return (
    <div
      className={cn(
        "relative w-[360px] max-w-[calc(100vw-2rem)]",
        "rounded-xl border border-border/60 bg-popover text-popover-foreground",
        "shadow-lg shadow-black/10",
      )}
      role="alertdialog"
      aria-label={title}
    >
      <button
        type="button"
        onClick={() => toast.dismiss(toastId)}
        aria-label="Dismiss"
        className="absolute right-2.5 top-2.5 inline-flex size-6 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
      >
        <XIcon className="size-3.5" />
      </button>
      <div className="flex flex-col gap-3 p-4 pr-10">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="text-sm font-semibold leading-tight">{title}</div>
          {body && (
            <div className="text-[13px] text-muted-foreground whitespace-pre-wrap leading-relaxed">
              {body}
            </div>
          )}
        </div>

        {hasActions && (
          <div className="flex items-center justify-end gap-2 pt-0.5">
            {actions!.map((action, i) => (
              <Button
                key={action.id}
                size="sm"
                variant={i === actions!.length - 1 ? "default" : "outline"}
                disabled={submitting !== null}
                onClick={() => void send(action.id, action.id)}
                className="h-8 px-3.5 text-xs font-medium"
              >
                {submitting === action.id ? "…" : action.label}
              </Button>
            ))}
          </div>
        )}

        {hasReplyInput && (
          <form onSubmit={onSubmitReply} className="flex flex-col gap-2 pt-0.5">
            <Input
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Reply…"
              disabled={submitting !== null}
              className="h-8 text-xs"
              aria-label="Reply"
            />
            {error && <div className="text-xs text-destructive">{error}</div>}
            <div className="flex items-center justify-end">
              <Button
                type="submit"
                size="sm"
                disabled={submitting !== null || !text.trim()}
                className="h-8 px-3.5 text-xs font-medium"
              >
                {submitting ? "Sending…" : "Send"}
              </Button>
            </div>
          </form>
        )}

        {!hasActions && !hasReplyInput && url && (
          <div className="flex items-center justify-end pt-0.5">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                window.location.href = url;
              }}
              className="h-8 px-3.5 text-xs font-medium"
            >
              Open
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

