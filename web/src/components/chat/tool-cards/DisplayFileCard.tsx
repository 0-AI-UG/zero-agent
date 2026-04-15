import { useNavigate } from "react-router";
import { ExternalLinkIcon } from "lucide-react";
import {
  Artifact,
  ArtifactHeader,
  ArtifactTitle,
  ArtifactContent,
  ArtifactActions,
  ArtifactAction,
} from "@/components/chat-ui/Artifact";
import { usePresignedUrl } from "@/hooks/use-presigned-url";
import { useFileContent } from "@/hooks/use-file-content";
import type { FileItem } from "@/hooks/use-files";

interface DisplayFileCardProps {
  fileId: string;
  filename: string;
  mimeType: string;
  projectId: string;
  caption?: string;
}

type Kind = "image" | "html" | "other";

function getKind(filename: string, mimeType: string): Kind {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType === "text/html" || filename.endsWith(".html")) return "html";
  return "other";
}

export function DisplayFileCard({
  fileId,
  filename,
  mimeType,
  projectId,
  caption,
}: DisplayFileCardProps) {
  const navigate = useNavigate();
  const { data: urlData } = usePresignedUrl(projectId, fileId);
  const url = urlData?.url;
  const thumbnailUrl = urlData?.thumbnailUrl ?? url;

  const kind = getKind(filename, mimeType);

  return (
    <Artifact className="my-2 max-w-md">
      <ArtifactHeader>
        <ArtifactTitle>{filename}</ArtifactTitle>
        <ArtifactActions>
          <ArtifactAction
            icon={ExternalLinkIcon}
            tooltip="Open in Files"
            onClick={() => navigate(`/projects/${projectId}/files?fileId=${fileId}`)}
          />
        </ArtifactActions>
      </ArtifactHeader>
      {kind === "image" && thumbnailUrl && (
        <ArtifactContent>
          <img
            src={thumbnailUrl}
            alt={filename}
            className="rounded max-h-[320px] w-full object-contain bg-muted/30"
          />
          {caption && <p className="text-xs text-muted-foreground mt-2">{caption}</p>}
        </ArtifactContent>
      )}
      {kind === "html" && (
        <ArtifactContent className="p-0">
          <HtmlIframe projectId={projectId} fileId={fileId} filename={filename} mimeType={mimeType} />
          {caption && <p className="text-xs text-muted-foreground px-4 py-2">{caption}</p>}
        </ArtifactContent>
      )}
      {kind === "other" && caption && (
        <ArtifactContent>
          <p className="text-xs text-muted-foreground">{caption}</p>
        </ArtifactContent>
      )}
    </Artifact>
  );
}

function HtmlIframe({
  projectId,
  fileId,
  filename,
  mimeType,
}: {
  projectId: string;
  fileId: string;
  filename: string;
  mimeType: string;
}) {
  const file = {
    id: fileId,
    filename,
    mimeType,
    projectId,
    sizeBytes: 0,
    folderPath: "/",
    createdAt: "",
  } satisfies FileItem;
  const { data: content } = useFileContent(projectId, file);
  return (
    <iframe
      srcDoc={content ?? ""}
      sandbox="allow-scripts"
      title={filename}
      className="w-full h-[300px] rounded border bg-white"
    />
  );
}
