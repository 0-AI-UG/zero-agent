/**
 * Composer affordance for the host browser the agent is driving.
 *
 * Renders a globe icon in the prompt input bar that only appears once a
 * `chat.browser-screenshot` frame has arrived. Clicking it opens a popover
 * showing the latest screenshot — the hook keeps subscribing while mounted,
 * so the image updates live as the agent acts on the page.
 */
import { GlobeIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useBrowserPreview } from "@/hooks/use-browser-preview";
import { useBlobUrl } from "@/hooks/use-blob-url";

interface Props {
  projectId: string;
}

export function BrowserPreviewButton({ projectId }: Props) {
  const frame = useBrowserPreview(projectId);
  const src = useBlobUrl(frame?.hash, projectId);
  if (!frame) return null;

  const host = (() => {
    try { return new URL(frame.url).host; } catch { return frame.url; }
  })();

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-foreground"
              aria-label="Show live browser preview"
            >
              <GlobeIcon className="size-4" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">Live browser preview</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="start"
        side="top"
        className="w-[28rem] p-0 overflow-hidden"
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b">
          <GlobeIcon className="size-3.5 text-muted-foreground shrink-0" />
          <span className="text-xs font-medium truncate" title={frame.title}>
            {frame.title || host || "Browser"}
          </span>
          {host && (
            <span className="text-[11px] text-muted-foreground truncate">
              · {host}
            </span>
          )}
        </div>
        <a href={frame.url} target="_blank" rel="noreferrer" className="block">
          {src ? (
            <img
              src={src}
              alt={frame.title || "Browser preview"}
              className="block w-full h-auto"
            />
          ) : (
            <div className="h-48 grid place-items-center text-xs text-muted-foreground">
              Loading…
            </div>
          )}
        </a>
      </PopoverContent>
    </Popover>
  );
}
