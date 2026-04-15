import { PencilIcon } from "lucide-react";
import { FileArtifact } from "@/components/files/file-artifact";

interface WriteFileOutput {
  s3Key?: string;
  path?: string;
  fileId?: string;
  mimeType?: string;
}

export function WriteFileCard({ output, projectId }: { output: WriteFileOutput; projectId?: string }) {
  const filename =
    (output.s3Key ? output.s3Key.split("/").pop() : output.path?.split("/").pop()) ?? "file";
  const mimeType =
    output.mimeType ??
    (filename.endsWith(".md")
      ? "text/markdown"
      : filename.endsWith(".json")
        ? "application/json"
        : "application/octet-stream");

  if (!output.fileId || !projectId) {
    return (
      <div className="rounded-lg border bg-card p-3 max-w-md">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
          <PencilIcon className="size-3" />
          <span>Created file</span>
        </div>
        <p className="text-sm font-medium">{filename}</p>
      </div>
    );
  }

  return (
    <FileArtifact
      fileId={output.fileId}
      filename={filename}
      mimeType={mimeType}
      projectId={projectId}
    />
  );
}
