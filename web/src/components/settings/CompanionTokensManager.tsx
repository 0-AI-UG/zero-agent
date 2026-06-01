import { useState } from "react";
import {
  useCompanionTokens,
  useRevokeCompanionToken,
  type CompanionToken,
} from "@/api/companion-tokens";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { TrashIcon, LaptopIcon, CheckIcon, DownloadIcon, TerminalIcon } from "lucide-react";
import type { LucideIcon } from "lucide-react";

function formatWhen(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function CompanionTokensManager() {
  const { data: tokens = [], isLoading } = useCompanionTokens();
  const revokeToken = useRevokeCompanionToken();

  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
  const serverOrigin = typeof window !== "undefined" ? window.location.origin : "<server-url>";

  const handleRevoke = (id: string) => {
    revokeToken.mutate(id, {
      onSuccess: () => setConfirmRevokeId(null),
    });
  };

  return (
    <section className="space-y-4">
      <h3 className="text-sm font-semibold">Connected computers</h3>

      <div className="rounded-lg border p-4 space-y-4">
        <div className="flex gap-2">
          <CopyButton
            title="Copy install command"
            command={`curl -fsSL ${serverOrigin}/install.sh | sh`}
            icon={DownloadIcon}
          />
          <CopyButton
            title="Copy login command"
            command={`zero login --url ${serverOrigin}`}
            icon={TerminalIcon}
          />
        </div>

        {isLoading && <p className="text-xs text-muted-foreground">Loading…</p>}

        {tokens.length > 0 && (
          <div className="space-y-1 border-t pt-3">
            {tokens.map((t) => (
              <TokenRow
                key={t.id}
                token={t}
                confirmRevokeId={confirmRevokeId}
                setConfirmRevokeId={setConfirmRevokeId}
                onRevoke={handleRevoke}
                isRevoking={revokeToken.isPending}
              />
            ))}
          </div>
        )}

        {!isLoading && tokens.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-3">
            No computers connected.
          </p>
        )}
      </div>
    </section>
  );
}

function CopyButton({ title, command, icon: Icon }: { title: string; command: string; icon: LucideIcon }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      toast.success("Copied");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Copy failed");
    }
  };

  return (
    <Button size="icon-sm" variant="outline" onClick={copy} aria-label={title} title={title}>
      {copied ? <CheckIcon className="size-3.5" /> : <Icon className="size-3.5" />}
    </Button>
  );
}

function TokenRow({
  token,
  confirmRevokeId,
  setConfirmRevokeId,
  onRevoke,
  isRevoking,
}: {
  token: CompanionToken;
  confirmRevokeId: string | null;
  setConfirmRevokeId: (id: string | null) => void;
  onRevoke: (id: string) => void;
  isRevoking: boolean;
}) {
  return (
    <div className="group flex items-center gap-3 py-2 px-2 -mx-2 rounded-md hover:bg-muted/50">
      <div className="size-8 rounded-full bg-muted flex items-center justify-center shrink-0">
        <LaptopIcon className="size-3.5 text-muted-foreground" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium truncate">{token.name}</span>
          <code className="text-[10px] text-muted-foreground font-mono shrink-0">{token.tokenMasked}</code>
        </div>
        <p className="text-[11px] text-muted-foreground truncate">
          {token.projectName ?? token.projectId} · Last used {formatWhen(token.lastConnectedAt)} · Expires{" "}
          {formatWhen(token.expiresAt)}
        </p>
      </div>

      <div className="shrink-0 opacity-0 group-hover:opacity-100">
        {confirmRevokeId === token.id ? (
          <button
            onClick={() => onRevoke(token.id)}
            disabled={isRevoking}
            className="text-destructive text-[10px] font-medium px-2 py-1 rounded-md hover:bg-destructive/10 disabled:opacity-50"
          >
            Revoke?
          </button>
        ) : (
          <button
            onClick={() => setConfirmRevokeId(token.id)}
            className="text-muted-foreground hover:text-destructive p-1.5 rounded-md hover:bg-muted"
            aria-label={`Revoke ${token.name}`}
          >
            <TrashIcon className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
