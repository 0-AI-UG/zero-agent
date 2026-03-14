import { CopyIcon, DownloadIcon, EyeIcon } from "lucide-react";
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
  const { openFilePreview } = useFilesStore();
  const { data: urlData } = usePresignedUrl(projectId, fileId);
  const url = urlData?.url;
  const displayUrl = urlData?.thumbnailUrl ?? url;
  const isImage = mimeType.startsWith("image/");

  return (
    <Artifact className="my-2 max-w-sm">
      <ArtifactHeader>
        <ArtifactTitle>{filename}</ArtifactTitle>
        <ArtifactActions>
          <ArtifactAction
            icon={EyeIcon}
            tooltip="Preview"
            onClick={() => openFilePreview(fileId)}
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
      {isImage && displayUrl && (
        <ArtifactContent>
          <img
            src={displayUrl}
            alt={filename}
            className="rounded max-h-[200px] w-full object-cover"
          />
        </ArtifactContent>
      )}
    </Artifact>
  );
}
