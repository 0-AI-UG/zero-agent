import { useState } from "react";
import { useParams } from "react-router";
import {
  useServices,
  useDeleteService,
  usePinService,
  useUnpinService,
  useCreateShareLink,
} from "@/api/apps";
import type { ForwardedPort } from "@/api/apps";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  NetworkIcon,
  Trash2Icon,
  ExternalLinkIcon,
  PinIcon,
  PinOffIcon,
  CheckCircle2Icon,
  CircleDotIcon,
  TriangleAlertIcon,
  Share2Icon,
  CopyIcon,
  CheckIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

const SHARE_DURATIONS = [
  { value: "5m", label: "5 minutes" },
  { value: "15m", label: "15 minutes" },
  { value: "1h", label: "1 hour" },
];

function ShareAppPopover({ projectId, serviceId }: { projectId: string; serviceId: string }) {
  const [duration, setDuration] = useState("15m");
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const createShareLink = useCreateShareLink(projectId);

  const generate = async () => {
    setCopied(false);
    const res = await createShareLink.mutateAsync({ serviceId, duration });
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

function StatusBadge({ status }: { status: ForwardedPort["status"] }) {
  if (status === "active") {
    return (
      <Badge variant="outline" className="text-emerald-600 border-emerald-200 bg-emerald-50 dark:bg-emerald-950 dark:text-emerald-400 dark:border-emerald-800 gap-1">
        <CheckCircle2Icon className="size-3" />
        Active
      </Badge>
    );
  }
  if (status === "unavailable") {
    return (
      <Badge variant="outline" className="text-amber-600 border-amber-200 bg-amber-50 dark:bg-amber-950 dark:text-amber-400 dark:border-amber-800 gap-1">
        <TriangleAlertIcon className="size-3" />
        Unavailable
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-muted-foreground gap-1">
      <CircleDotIcon className="size-3" />
      Stopped
    </Badge>
  );
}

function ServiceCard({
  service,
  projectId,
}: {
  service: ForwardedPort;
  projectId: string;
}) {
  const deleteService = useDeleteService(projectId);
  const pinService = usePinService(projectId);
  const unpinService = useUnpinService(projectId);

  const serviceUrl = `${window.location.origin}${service.url}`;

  return (
    <div className="border rounded-lg p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-medium truncate">{service.label || "Untitled app"}</h3>
            <StatusBadge status={service.status} />
            {service.pinned && (
              <Badge variant="outline" className="text-xs gap-1">
                <PinIcon className="size-2.5" />
                Always on
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-3 mt-2 text-[11px] text-muted-foreground flex-wrap">
            <a
              href={serviceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                "hover:text-foreground inline-flex items-center gap-1 underline-offset-2 hover:underline",
                service.status !== "active" && !service.pinned && "opacity-50 pointer-events-none",
              )}
            >
              Open link
              <ExternalLinkIcon className="size-2.5" />
            </a>
          </div>
          {!service.startCommand && (
            <p className="flex items-center gap-1 mt-2 text-[10px] text-amber-600 dark:text-amber-400">
              <TriangleAlertIcon className="size-3 shrink-0" />
              This app won't restart automatically after the project sleeps
            </p>
          )}
          {service.error && (
            <p className="text-xs text-destructive mt-2 line-clamp-2">{service.error}</p>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {(service.status === "active" || service.pinned) && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => window.open(serviceUrl, "_blank")}
              aria-label="Open service"
            >
              <ExternalLinkIcon className="size-3.5" />
            </Button>
          )}

          {service.pinned && (
            <ShareAppPopover projectId={projectId} serviceId={service.id} />
          )}

          {service.pinned ? (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => unpinService.mutate(service.id)}
              disabled={unpinService.isPending}
              aria-label="Don't keep running"
              title="Stop keeping this app running when the project sleeps"
            >
              <PinOffIcon className="size-3.5" />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => pinService.mutate(service.id)}
              disabled={pinService.isPending}
              aria-label="Keep running"
              title="Keep this app available even after the project sleeps"
            >
              <PinIcon className="size-3.5" />
            </Button>
          )}

          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => deleteService.mutate(service.id)}
            disabled={deleteService.isPending}
            aria-label="Delete service"
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
  const { data: services, isLoading } = useServices(projectId!);

  const unpinned = services?.filter(s => !s.pinned) ?? [];
  const pinned = services?.filter(s => s.pinned) ?? [];

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto px-5 py-6 space-y-5">
        <div>
          <h2 className="text-base font-semibold tracking-tight font-display">
            Apps
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Things running in this project that you can open in your browser
          </p>
        </div>

        {isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 2 }).map((_, i) => (
              <Skeleton key={i} className="h-20 rounded-lg" />
            ))}
          </div>
        ) : !services || services.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <NetworkIcon className="size-10 text-muted-foreground/40 mb-3" />
            <p className="text-sm font-medium mb-1">Nothing running yet</p>
            <p className="text-xs text-muted-foreground max-w-[280px]">
              Ask the agent to build or start an app - it will show up here so you can open it.
            </p>
          </div>
        ) : (
          <div className="space-y-5">
            {unpinned.length > 0 && (
              <div className="space-y-3">
                {unpinned.map((service) => (
                  <ServiceCard key={service.id} service={service} projectId={projectId!} />
                ))}
              </div>
            )}

            {pinned.length > 0 && (
              <div className="space-y-3">
                <div className="pt-2">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <PinIcon className="size-3" />
                    <span className="font-medium">Always on</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground/80 mt-0.5">
                    These apps stay available even when the project is idle.
                  </p>
                </div>
                {pinned.map((service) => (
                  <ServiceCard key={service.id} service={service} projectId={projectId!} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
