import { useState } from "react";
import { DownloadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatBytes } from "./file-row";
import type { FileItem } from "@/hooks/use-files";

interface ImagePreviewProps {
  file: FileItem;
  url: string;
  thumbnailUrl?: string;
}

export function ImagePreview({ file, url, thumbnailUrl }: ImagePreviewProps) {
  const [fullLoaded, setFullLoaded] = useState(false);
  const showThumbnail = !!thumbnailUrl && !fullLoaded;

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="relative">
        {showThumbnail && (
          <img
            src={thumbnailUrl}
            alt={file.filename}
            className="w-full rounded-md object-contain max-h-[60vh]"
          />
        )}
        <img
          src={url}
          alt={file.filename}
          onLoad={() => setFullLoaded(true)}
          className={
            showThumbnail
              ? "absolute inset-0 w-full rounded-md object-contain max-h-[60vh] opacity-0"
              : "w-full rounded-md object-contain max-h-[60vh]"
          }
        />
      </div>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">{file.filename}</p>
          <p className="text-xs text-muted-foreground">
            {formatBytes(file.sizeBytes)}
          </p>
        </div>
        <Button variant="outline" size="sm" asChild>
          <a href={url} download={file.filename}>
            <DownloadIcon className="h-4 w-4 mr-1" />
            Download
          </a>
        </Button>
      </div>
    </div>
  );
}
