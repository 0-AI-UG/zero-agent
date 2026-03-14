import { DownloadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FileTypeIcon } from "./file-type-icon";
import { formatBytes } from "./file-row";
import type { FileItem } from "@/hooks/use-files";

function humanMimeType(mimeType: string): string {
  const map: Record<string, string> = {
    "application/pdf": "PDF Document",
    "text/csv": "CSV Spreadsheet",
    "text/plain": "Text File",
    "text/markdown": "Markdown",
    "application/json": "JSON",
    "image/png": "PNG Image",
    "image/jpeg": "JPEG Image",
    "image/webp": "WebP Image",
  };
  return map[mimeType] ?? mimeType;
}

interface DownloadFallbackProps {
  file: FileItem;
  url: string;
}

export function DownloadFallback({ file, url }: DownloadFallbackProps) {
  return (
    <div className="flex flex-col items-center gap-4 p-8 text-center">
      <FileTypeIcon
        mimeType={file.mimeType}
        className="h-12 w-12 text-muted-foreground"
      />
      <div>
        <p className="text-sm font-medium">{file.filename}</p>
        <p className="text-xs text-muted-foreground">
          {humanMimeType(file.mimeType)} &middot; {formatBytes(file.sizeBytes)}
        </p>
      </div>
      <Button asChild>
        <a href={url} download={file.filename}>
          <DownloadIcon className="h-4 w-4 mr-1" />
          Download
        </a>
      </Button>
    </div>
  );
}
