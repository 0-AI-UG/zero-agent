import { useParams } from "react-router";
import {
  useServices,
  useDeleteService,
  usePinService,
  useUnpinService,
} from "@/api/apps";
import type { ForwardedPort } from "@/api/apps";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  NetworkIcon,
  Trash2Icon,
  ExternalLinkIcon,
  PinIcon,
  PinOffIcon,
  CheckCircle2Icon,
  CircleDotIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

function StatusBadge({ status }: { status: ForwardedPort["status"] }) {
  if (status === "active") {
    return (
      <Badge variant="outline" className="text-emerald-600 border-emerald-200 bg-emerald-50 dark:bg-emerald-950 dark:text-emerald-400 dark:border-emerald-800 gap-1">
        <CheckCircle2Icon className="size-3" />
        Active
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
            <h3 className="text-sm font-medium truncate">{service.label || `Port ${service.port}`}</h3>
            <StatusBadge status={service.status} />
            {service.pinned && (
              <Badge variant="outline" className="text-xs gap-1">
                <PinIcon className="size-2.5" />
                Pinned
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-3 mt-2 text-[11px] text-muted-foreground flex-wrap">
            <code className="bg-muted px-1.5 py-0.5 rounded text-[10px]">
              :{service.port}
            </code>
            <a
              href={serviceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                "bg-muted px-1.5 py-0.5 rounded text-[10px] hover:text-foreground inline-flex items-center gap-1",
                service.status !== "active" && !service.pinned && "opacity-50 pointer-events-none",
              )}
            >
              {service.url}
              <ExternalLinkIcon className="size-2.5" />
            </a>
          </div>
          {service.startCommand ? (
            <code className="block mt-2 text-[10px] text-muted-foreground bg-muted px-2 py-1 rounded truncate">
              {service.startCommand}
            </code>
          ) : (
            <p className="flex items-center gap-1 mt-2 text-[10px] text-amber-600 dark:text-amber-400">
              <TriangleAlertIcon className="size-3 shrink-0" />
              No start command — cold-start won't be able to restart this service
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

          {service.pinned ? (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => unpinService.mutate(service.id)}
              disabled={unpinService.isPending}
              aria-label="Unpin service"
              title="Unpin"
            >
              <PinOffIcon className="size-3.5" />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => pinService.mutate(service.id)}
              disabled={pinService.isPending}
              aria-label="Pin service"
              title="Pin (persists across sessions)"
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
            Services
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Forwarded ports in this project
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
            <p className="text-sm font-medium mb-1">No forwarded ports</p>
            <p className="text-xs text-muted-foreground max-w-[280px]">
              Ask the agent to start a server — it will forward the port automatically.
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
                <div className="flex items-center gap-2 text-xs text-muted-foreground pt-2">
                  <PinIcon className="size-3" />
                  <span className="font-medium">Pinned</span>
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
