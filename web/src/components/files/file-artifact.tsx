import { CopyIcon, DownloadIcon, ExternalLinkIcon } from "lucide-react";
import {
  Artifact,
  ArtifactHeader,
  ArtifactTitle,
  ArtifactContent,
  ArtifactActions,
  ArtifactAction,
} from "@/components/ai/artifact";
import { usePresignedUrl } from "@/hooks/use-presigned-url";
import { useFilesStore } from "@/stores/files-store";
import { FileTypeIcon } from "./file-type-icon";

interface FileArtifactProps {
  fileId: string;
  filename: string;
  mimeType: string;
  projectId: string;
}

export function FileArtifact({
  fileId,
  filename,
  mimeType,
  projectId,
}: FileArtifactProps) {
  const { openFileInDrawer } = useFilesStore();
  const { data: urlData } = usePresignedUrl(projectId, fileId);
  const url = urlData?.url;
  const displayUrl = urlData?.thumbnailUrl ?? url;

  return (
    <Artifact className="my-2 max-w-sm">
      <ArtifactHeader>
        <ArtifactTitle>{filename}</ArtifactTitle>
        <ArtifactActions>
          <ArtifactAction
            icon={ExternalLinkIcon}
            tooltip="View in Files"
            onClick={() => openFileInDrawer(fileId)}
          />
          <ArtifactAction
            icon={CopyIcon}
            tooltip="Copy"
            onClick={() => {
              if (url) {
                navigator.clipboard.writeText(url);
              }
            }}
          />
          {url && (
            <ArtifactAction
              icon={DownloadIcon}
              tooltip="Download"
              onClick={() => window.open(url)}
            />
          )}
        </ArtifactActions>
      </ArtifactHeader>
      <ArtifactContent>
        {mimeType.startsWith("image/") && displayUrl ? (
          <img
            src={displayUrl}
            alt={filename}
            className="rounded max-h-[200px] w-full object-cover"
          />
        ) : (
          <div className="flex items-center gap-2">
            <FileTypeIcon mimeType={mimeType} />
            <span className="text-sm truncate">{filename}</span>
          </div>
        )}
      </ArtifactContent>
    </Artifact>
  );
}
