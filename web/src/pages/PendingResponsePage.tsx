/**
 * PendingResponsePage — full-screen click-through target for a pending
 * response. Opened from a PWA push notification (Stage 4) and, later,
 * from the Telegram `url` deeplink in Stage 5.
 *
 * Loads the pending_responses row, shows the prompt, lets the user type
 * a reply, and posts to /api/pending-responses/:id/respond. The page
 * then reflects the resolved state (or "already answered" / "expired" /
 * "cancelled" if the row moved out of `pending` while rendering).
 */
import { useEffect, useState, type FormEvent } from "react";
import { useParams, useNavigate } from "react-router";
import {
  getPendingResponse,
  respondToPending,
  type PendingResponseRow,
  type PendingResponseStatus,
} from "@/api/pending-responses";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

const STATUS_COPY: Record<Exclude<PendingResponseStatus, "pending">, {
  title: string;
  description: string;
}> = {
  resolved: {
    title: "Request resolved",
    description: "A response has already been recorded for this request.",
  },
  expired: {
    title: "Request expired",
    description: "This request timed out before a reply was received.",
  },
  cancelled: {
    title: "Request cancelled",
    description: "This request was cancelled.",
  },
};

export function PendingResponsePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [row, setRow] = useState<PendingResponseRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    getPendingResponse(id)
      .then((r) => {
        if (!cancelled) setRow(r);
      })
      .catch((err: Error) => {
        if (!cancelled) setLoadError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!id) return;
    const trimmed = text.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await respondToPending(id, trimmed);
      setRow(result.row);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Couldn't send reply");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-6">
        <div className="text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }

  if (loadError || !row) {
    return (
      <div className="flex min-h-dvh items-center justify-center p-6">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Request not found</CardTitle>
            <CardDescription>
              {loadError ?? "This request no longer exists."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => navigate("/")}>Back to dashboard</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const isPending = row.status === "pending";
  const terminalStatus = row.status === "pending" ? null : row.status;

  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Reply requested</CardTitle>
          <CardDescription className="whitespace-pre-wrap text-sm">
            {row.prompt}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {isPending ? (
            <form onSubmit={onSubmit} className="flex flex-col gap-3">
              <Textarea
                autoFocus
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Type your reply…"
                rows={4}
                disabled={submitting}
                aria-label="Reply"
              />
              {submitError && (
                <div className="text-xs text-destructive">{submitError}</div>
              )}
              <div className="flex gap-2">
                <Button type="submit" disabled={submitting || !text.trim()}>
                  {submitting ? "Sending…" : "Send reply"}
                </Button>
                <Button type="button" variant="ghost" onClick={() => navigate("/")}>
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex flex-col gap-3">
              {terminalStatus && (
                <div>
                  <div className="text-sm font-medium">
                    {STATUS_COPY[terminalStatus].title}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {STATUS_COPY[terminalStatus].description}
                  </div>
                </div>
              )}
              {row.status === "resolved" && row.responseText && (
                <div className="rounded-md border bg-muted/30 p-3 text-sm whitespace-pre-wrap">
                  {row.responseText}
                </div>
              )}
              <Button onClick={() => navigate("/")}>Back to dashboard</Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default PendingResponsePage;
