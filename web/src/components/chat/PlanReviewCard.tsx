import { useState, useEffect } from "react";
import { useNavigate } from "react-router";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ClipboardListIcon,
  CheckIcon,
  PlusIcon,
  PencilIcon,
} from "lucide-react";
import { respondToPending } from "@/api/pending-responses";
import { usePlanModeStore } from "@/stores/plan-mode";
import { cn } from "@/lib/utils";
import { Shimmer } from "@/components/ai/shimmer";

interface PlanReviewCardProps {
  planFilePath: string;
  summary: string;
  chatId: string;
  projectId: string;
  /** True while the tool is still awaiting a response. */
  isPending: boolean;
}

export function PlanReviewCard({
  planFilePath,
  summary,
  chatId,
  projectId,
  isPending,
}: PlanReviewCardProps) {
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [resolved, setResolved] = useState<string | null>(null);
  const navigate = useNavigate();

  const planReview = usePlanModeStore((s) => s.getPlanReview(chatId));
  const newChatRedirect = usePlanModeStore((s) => s.newChatRedirects[chatId]);
  const responseId = planReview?.responseId;
  const planContent = planReview?.planContent ?? "";

  // Navigate to the new chat once the server creates it
  useEffect(() => {
    if (newChatRedirect) {
      usePlanModeStore.getState().consumeNewChatRedirect(chatId);
      navigate(`/projects/${projectId}/c/${newChatRedirect}`);
    }
  }, [newChatRedirect, chatId, projectId, navigate]);

  async function handleAction(action: string, responseText: string) {
    if (!responseId || submitting) return;
    setSubmitting(action);
    try {
      const result = await respondToPending(responseId, responseText);
      if (result.ok || result.status === "resolved") {
        setResolved(action);
        usePlanModeStore.getState().updatePlanReviewStatus(
          chatId,
          action === "alter" ? "altered" : action as "implement" | "implement_new_chat",
        );

        if (action === "implement") {
          usePlanModeStore.getState().disablePlanMode(chatId);
        }
      }
    } catch {
      // Ignore — user can retry
    } finally {
      setSubmitting(null);
    }
  }

  const displayStatus = resolved || planReview?.status;
  const isResolved = displayStatus && displayStatus !== "pending";

  return (
    <div className="my-2 max-w-2xl">
      {/* Plan header */}
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
        <ClipboardListIcon className="size-3" />
        <span className="font-medium">Plan</span>
        <span className="text-muted-foreground/60">{planFilePath}</span>
      </div>

      {/* Plan content — rendered as markdown */}
      {planContent ? (
        <div className="text-sm prose prose-sm dark:prose-invert max-w-none mb-3 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 border-l-2 border-muted-foreground/20 pl-4">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{planContent}</ReactMarkdown>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground mb-3 italic">{summary}</p>
      )}

      {/* Loading state */}
      {isPending && !responseId && !isResolved && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Shimmer duration={1.5}>Waiting for plan review</Shimmer>
        </div>
      )}

      {/* Action buttons — vertical, uniform style */}
      {isPending && responseId && !isResolved && (
        <div className="flex flex-col gap-1 items-start">
          <ActionButton
            icon={<CheckIcon className="size-3" />}
            label="Implement"
            loading={submitting === "implement"}
            disabled={submitting !== null}
            onClick={() => void handleAction("implement", "implement")}
          />
          <ActionButton
            icon={<PlusIcon className="size-3" />}
            label="Implement in new chat"
            loading={submitting === "implement_new_chat"}
            disabled={submitting !== null}
            onClick={() => void handleAction("implement_new_chat", "implement_new_chat")}
          />
          <ActionButton
            icon={<PencilIcon className="size-3" />}
            label="Revise plan"
            loading={submitting === "alter"}
            disabled={submitting !== null}
            onClick={() => void handleAction("alter", "alter:")}
          />
        </div>
      )}

      {/* Resolved status */}
      {isResolved && (
        <div
          className={cn(
            "flex items-center gap-1.5 text-xs",
            displayStatus === "implement"
              ? "text-emerald-600 dark:text-emerald-400"
              : displayStatus === "implement_new_chat"
                ? "text-blue-600 dark:text-blue-400"
                : "text-amber-600 dark:text-amber-400",
          )}
        >
          {displayStatus === "implement" && (
            <><CheckIcon className="size-3" /> Implementing plan</>
          )}
          {displayStatus === "implement_new_chat" && (
            <><PlusIcon className="size-3" /> Implementing in new chat</>
          )}
          {displayStatus === "altered" && (
            <><PencilIcon className="size-3" /> Revising plan</>
          )}
        </div>
      )}
    </div>
  );
}

function ActionButton({
  icon,
  label,
  loading,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  loading?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-50 py-0.5 transition-colors cursor-pointer"
    >
      {icon}
      {loading ? "..." : label}
    </button>
  );
}
