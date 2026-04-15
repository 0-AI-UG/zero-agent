/**
 * Modal that drives the Codex `codex login --device-auth` flow inside a
 * user's container. Device-auth prints a URL + one-time code, then polls
 * the OpenAI auth server until the user completes the flow in their own
 * browser — no stdin interaction required from us after launch.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  startCliAuth,
  streamCliAuth,
  cancelCliAuth,
  type CliAuthFrame,
} from "@/api/cli-auth";
import { Button } from "@/components/ui/button";
import { XIcon, LoaderIcon } from "lucide-react";

interface CodexLoginModalProps {
  projectId: string;
  onClose: () => void;
  onSuccess: () => void;
}

const URL_RE = /(https?:\/\/\S+)/g;
// Codex prints the one-time code on its own line after "Enter this one-time code".
// Match 6-to-12 character alphanumeric codes that aren't just a word.
const CODE_RE = /Enter this one-time code[^\n]*\n\s*(?:\x1b\[[0-9;]*m)?\s*([A-Z0-9-]{4,16})/i;

export function CodexLoginModal({ projectId, onClose, onSuccess }: CodexLoginModalProps) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [output, setOutput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const abort = new AbortController();
    abortRef.current = abort;
    let currentSession: string | null = null;

    (async () => {
      try {
        const { sessionId: sid } = await startCliAuth("codex", projectId);
        if (cancelled) {
          await cancelCliAuth("codex", sid);
          return;
        }
        setSessionId(sid);
        currentSession = sid;
        for await (const frame of streamCliAuth("codex", sid, abort.signal) as AsyncIterable<CliAuthFrame>) {
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
        cancelCliAuth("codex", currentSession).catch(() => {});
      }
    };
  }, [projectId, onSuccess]);

  useEffect(() => {
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output]);

  const { url, code } = useMemo(() => {
    const clean = output.replace(/\x1b\[[0-9;]*m/g, "");
    const u = clean.match(URL_RE)?.[0] ?? null;
    const c = clean.match(CODE_RE)?.[1] ?? null;
    return { url: u, code: c };
  }, [output]);

  const done = exitCode !== null;
  const succeeded = exitCode === 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-background rounded-lg shadow-xl w-full max-w-xl max-h-[90vh] flex flex-col border">
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <h3 className="font-semibold">Log in with Codex subscription</h3>
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

          {url && !done && (
            <div className="rounded border bg-muted/40 p-3 space-y-2">
              <p className="text-sm">1. Open this link in your browser and sign in to ChatGPT:</p>
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="block text-sm text-primary break-all underline"
              >
                {url}
              </a>
            </div>
          )}

          {code && !done && (
            <div className="rounded border bg-muted/40 p-3 space-y-2">
              <p className="text-sm">2. Enter this one-time code on that page:</p>
              <div className="text-lg font-mono tracking-widest select-all">{code}</div>
              <p className="text-xs text-muted-foreground">
                Codes expire in 15 minutes. Never share it with anyone who asks for it.
              </p>
            </div>
          )}

          {sessionId && !done && url && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderIcon className="size-4 animate-spin" />
              Waiting for you to finish signing in…
            </div>
          )}

          {done && (
            <div className={`text-sm rounded p-3 ${succeeded ? "bg-green-500/10 text-green-600" : "bg-destructive/10 text-destructive"}`}>
              {succeeded
                ? "Logged in. Your Codex subscription is now linked to this workspace."
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
