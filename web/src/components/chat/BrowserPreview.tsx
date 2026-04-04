import { MonitorIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useBrowserScreenshot } from "@/api/containers";

interface BrowserPreviewProps {
  projectId: string;
  chatId: string;
}

export function BrowserPreview({ projectId, chatId }: BrowserPreviewProps) {
  const { data: screenshot } = useBrowserScreenshot(projectId, chatId, true);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-foreground"
        >
          <MonitorIcon className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-auto max-w-lg p-0 overflow-hidden">
        {screenshot ? (
          <div>
            <div className="px-3 py-1.5 border-b text-xs text-muted-foreground truncate">
              {screenshot.title || "Browser"}
            </div>
            <img
              src={`data:image/jpeg;base64,${screenshot.base64}`}
              alt={screenshot.title ?? "Browser"}
              className="max-h-80 w-auto"
            />
          </div>
        ) : (
          <div className="flex items-center justify-center px-8 py-6">
            <p className="text-xs text-muted-foreground">Waiting for browser activity...</p>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
