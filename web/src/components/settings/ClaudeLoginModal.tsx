/**
 * Modal that drives the Claude Code `setup-token` flow inside a user's
 * container. Opens an NDJSON stream, renders live CLI output, and offers
 * a single text field for the user to paste back the token they got from
 * visiting the URL the CLI printed.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  startCliAuth,
  streamCliAuth,
  sendCliAuthStdin,
  cancelCliAuth,
  type CliAuthFrame,
} from "@/api/cli-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { XIcon, LoaderIcon } from "lucide-react";

interface ClaudeLoginModalProps {
  projectId: string;
  onClose: () => void;
  onSuccess: () => void;
}

const URL_RE = /(https?:\/\/\S+)/g;

export function ClaudeLoginModal({ projectId, onClose, onSuccess }: ClaudeLoginModalProps) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [output, setOutput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);

  // Start session on mount. If cancelled via unmount, abort the stream and
  // tell the server to kill the runner-side process.
  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    abortRef.current = abort;
    let currentSession: string | null = null;

    (async () => {
      try {
        const { sessionId: sid } = await startCliAuth("claude", projectId);
        if (cancelled) {
          await cancelCliAuth("claude", sid);
          return;
        }
        setSessionId(sid);
        currentSession = sid;
        for await (const frame of streamCliAuth("claude", sid, abort.signal) as AsyncIterable<CliAuthFrame>) {
          if (cancelled) break;
          if (frame.type === "stdout") {
            setOutput((prev) => prev + frame.data);
          } else if (frame.type === "error") {
            setError(frame.message);
          } else if (frame.type === "exit") {
            setExitCode(frame.code);
            if (frame.code === 0) onSuccess();
            break;
          }
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
      abort.abort();
      if (currentSession) {
        cancelCliAuth("claude", currentSession).catch(() => {});
      }
    };
  }, [projectId, onSuccess]);

  // Auto-scroll output as it arrives.
  useEffect(() => {
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output]);

  // Extract the first URL the CLI printed so we can surface it prominently.
  const firstUrl = useMemo(() => {
    const m = output.match(URL_RE);
    return m?.[0] ?? null;
  }, [output]);

  const submitToken = useCallback(async () => {
    if (!sessionId || !token.trim()) return;
    setSending(true);
    try {
      // setup-token reads token + newline, blocks until it validates, then exits.
      await sendCliAuthStdin("claude", sessionId, token.trim() + "\n");
      setToken("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }, [sessionId, token]);

  const done = exitCode !== null;
  const succeeded = exitCode === 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-background rounded-lg shadow-xl w-full max-w-xl max-h-[90vh] flex flex-col border">
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <h3 className="font-semibold">Log in with Claude Code subscription</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <XIcon className="size-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {!sessionId && !error && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderIcon className="size-4 animate-spin" />
              Starting login session inside your container…
            </div>
          )}

          {error && (
            <div className="text-sm text-destructive bg-destructive/10 rounded p-3">
              {error}
            </div>
          )}

          {firstUrl && !done && (
            <div className="rounded border bg-muted/40 p-3 space-y-2">
              <p className="text-sm">1. Visit this URL in your browser, sign in, then copy the token shown:</p>
              <a
                href={firstUrl}
                target="_blank"
                rel="noreferrer"
                className="block text-sm text-primary break-all underline"
              >
                {firstUrl}
              </a>
            </div>
          )}

          {sessionId && !done && (
            <div className="space-y-2">
              <p className="text-sm">2. Paste the token below and press Enter:</p>
              <div className="flex gap-2">
                <Input
                  type="password"
                  placeholder="sk-ant-..."
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") submitToken(); }}
                  disabled={sending || done}
                  autoFocus
                />
                <Button onClick={submitToken} disabled={!token.trim() || sending || done}>
                  Submit
                </Button>
              </div>
            </div>
          )}

          {done && (
            <div className={`text-sm rounded p-3 ${succeeded ? "bg-green-500/10 text-green-600" : "bg-destructive/10 text-destructive"}`}>
              {succeeded
                ? "Logged in. Your Claude Code subscription is now linked to this workspace."
                : `Login failed (exit code ${exitCode}). Check the output below and try again.`}
            </div>
          )}

          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">CLI output</summary>
            <pre
              ref={preRef}
              className="mt-2 bg-black text-green-300 rounded p-3 overflow-auto max-h-60 whitespace-pre-wrap break-all"
            >
              {output || "(waiting for output…)"}
            </pre>
          </details>
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t">
          <Button variant="outline" onClick={onClose}>
            {done ? "Close" : "Cancel"}
          </Button>
        </div>
      </div>
    </div>
  );
}
