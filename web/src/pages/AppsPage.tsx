import { useState } from "react";
import { useParams } from "react-router";
import {
  useApps,
  useDeleteApp,
  useCreateShareLink,
} from "@/api/apps";
import type { App } from "@/api/apps";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  NetworkIcon,
  Trash2Icon,
  ExternalLinkIcon,
  Share2Icon,
  CopyIcon,
  CheckIcon,
} from "lucide-react";

const SHARE_DURATIONS = [
  { value: "5m", label: "5 minutes" },
  { value: "15m", label: "15 minutes" },
  { value: "1h", label: "1 hour" },
];

function ShareAppPopover({ projectId, appId }: { projectId: string; appId: string }) {
  const [duration, setDuration] = useState("15m");
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const createShareLink = useCreateShareLink(projectId);

  const generate = async () => {
    setCopied(false);
    const res = await createShareLink.mutateAsync({ appId, duration });
    setLink(`${window.location.origin}${res.path}`);
  };

  const copy = async () => {
    if (!link) return;
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Popover onOpenChange={(open) => { if (!open) { setLink(null); setCopied(false); } }}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Share app" title="Share link">
          <Share2Icon className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3 space-y-3">
        <div>
          <p className="text-xs font-medium">Share this app</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Anyone with the link can open it until it expires.
          </p>
        </div>
        <div className="space-y-1.5">
          <label className="text-[11px] text-muted-foreground">Link expires after</label>
          <div className="flex gap-1">
            {SHARE_DURATIONS.map((d) => (
              <Button
                key={d.value}
                type="button"
                variant={duration === d.value ? "default" : "outline"}
                size="sm"
                className="flex-1 text-[11px] h-7"
                onClick={() => { setDuration(d.value); setLink(null); }}
              >
                {d.label}
              </Button>
            ))}
          </div>
        </div>
        {link ? (
          <div className="flex items-center gap-1">
            <input
              readOnly
              value={link}
              className="flex-1 min-w-0 text-[11px] border rounded px-2 py-1 bg-muted font-mono"
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button variant="outline" size="icon-sm" onClick={copy} aria-label="Copy link">
              {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            className="w-full"
            onClick={generate}
            disabled={createShareLink.isPending}
          >
            {createShareLink.isPending ? "Generating…" : "Generate link"}
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

function AppCard({ app, projectId }: { app: App; projectId: string }) {
  const deleteApp = useDeleteApp(projectId);
  const appUrl = `${window.location.origin}${app.url}`;

  return (
    <div className="border rounded-lg p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium truncate">{app.name}</h3>
          <div className="flex items-center gap-3 mt-1 text-[11px] text-muted-foreground flex-wrap">
            <span className="font-mono">port {app.port}</span>
            <a
              href={appUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-foreground inline-flex items-center gap-1 underline-offset-2 hover:underline"
            >
              Open link
              <ExternalLinkIcon className="size-2.5" />
            </a>
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => window.open(appUrl, "_blank")}
            aria-label="Open app"
          >
            <ExternalLinkIcon className="size-3.5" />
          </Button>
          <ShareAppPopover projectId={projectId} appId={app.id} />
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => deleteApp.mutate(app.id)}
            disabled={deleteApp.isPending}
            aria-label="Delete app"
          >
            <Trash2Icon className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

export function AppsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { data: apps, isLoading } = useApps(projectId!);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto px-4 md:px-5 py-6 space-y-5">
        <div>
          <h2 className="text-xl font-bold tracking-tight font-display">Apps</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Each app gets a permanent URL that proxies to a port on the host.
          </p>
        </div>

        {isLoading ? (
          <Skeleton className="h-20 rounded-lg" />
        ) : !apps || apps.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <NetworkIcon className="size-10 text-muted-foreground/40 mb-3" />
            <p className="text-sm font-medium mb-1">No apps yet</p>
            <p className="text-xs text-muted-foreground max-w-[280px]">
              Create an app to get a port + URL. Bind your server to that port and the URL will proxy to it.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {apps.map((app) => (
              <AppCard key={app.id} app={app} projectId={projectId!} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
