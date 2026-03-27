import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ExternalLinkIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader } from "@/components/ai/loader";
import { useFilesStore } from "@/stores/files-store";
import { usePresignedUrl } from "@/hooks/use-presigned-url";
import { useFileContent } from "@/hooks/use-file-content";
import { PreviewActionsProvider } from "./preview-actions-context";
import { apiFetch } from "@/api/client";
import type { FileItem } from "@/hooks/use-files";
import { ImagePreview } from "./image-preview";
import { MarkdownPreview } from "./markdown-preview";
import { TextPreview } from "./text-preview";
import { CodePreview } from "./code-preview";
import { CsvPreview } from "./csv-preview";
import { HtmlPreview } from "./html-preview";
import { VizPreview } from "./viz-preview";
import { DownloadFallback } from "./download-fallback";

interface FilePreviewModalProps {
  projectId: string;
}

export function FilePreviewModal({ projectId }: FilePreviewModalProps) {
  const navigate = useNavigate();
  const { previewOpen, previewFileId, setPreviewOpen } = useFilesStore();
  const [actions, setActions] = useState<ReactNode>(null);

  const { data: fileData, isLoading: fileLoading } = useQuery({
    queryKey: ["file-detail", projectId, previewFileId],
    queryFn: () =>
      apiFetch<{ file: FileItem }>(
        `/projects/${projectId}/files/${previewFileId}/url`
      ),
    enabled: !!previewFileId,
    staleTime: 30_000,
  });

  const file = fileData?.file;

  return (
    <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
      <DialogContent className="max-w-4xl h-[85vh] flex flex-col p-0 gap-0">
        <PreviewActionsProvider value={{ setActions }}>
          <DialogHeader className="flex-row items-center justify-between gap-2 px-4 py-3 border-b space-y-0">
            <div className="min-w-0">
              <DialogTitle className="text-sm font-medium truncate">
                {file?.filename ?? "Loading..."}
              </DialogTitle>
              <DialogDescription className="sr-only">
                File preview
              </DialogDescription>
            </div>
            <div className="flex items-center gap-2 shrink-0 mr-6">
              {actions}
              {file && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setPreviewOpen(false);
                    navigate(
                      `/projects/${projectId}/files?fileId=${file.id}`
                    );
                  }}
                >
                  <ExternalLinkIcon className="size-3.5 mr-1.5" />
                  Open in File Viewer
                </Button>
              )}
            </div>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-y-auto">
            {fileLoading || !file ? (
              <div className="flex items-center justify-center p-12">
                <Loader size={20} />
              </div>
            ) : (
              <ModalPreviewContent file={file} projectId={projectId} />
            )}
          </div>
        </PreviewActionsProvider>
      </DialogContent>
    </Dialog>
  );
}

function ModalPreviewContent({
  file,
  projectId,
}: {
  file: FileItem;
  projectId: string;
}) {
  const { data: urlData, isLoading: urlLoading } = usePresignedUrl(
    projectId,
    file.id
  );
  const { data: content, isLoading: contentLoading } = useFileContent(
    projectId,
    file
  );

  if (urlLoading || contentLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader size={20} />
      </div>
    );
  }

  const url = urlData?.url;
  const thumbnailUrl = urlData?.thumbnailUrl;

  if (file.mimeType.startsWith("image/") && url) {
    return <ImagePreview file={file} url={url} thumbnailUrl={thumbnailUrl} />;
  }
  if (isVizFile(file) && content !== undefined) {
    return <VizPreview file={file} content={content} />;
  }
  if (isHtmlFile(file) && content !== undefined) {
    return <HtmlPreview file={file} content={content} />;
  }
  if (isMarkdownFile(file) && content !== undefined) {
    return <MarkdownPreview file={file} content={content} projectId={projectId} />;
  }
  if (isCsvFile(file) && content !== undefined) {
    return <CsvPreview file={file} content={content} projectId={projectId} />;
  }
  if (isCodeFile(file) && content !== undefined) {
    return <CodePreview file={file} content={content} projectId={projectId} />;
  }
  if (isPlainTextFile(file) && content !== undefined) {
    return <TextPreview file={file} content={content} projectId={projectId} />;
  }
  if (url) {
    return <DownloadFallback file={file} url={url} />;
  }
  return null;
}

function isMarkdownFile(file: FileItem) {
  return file.mimeType === "text/markdown" || file.filename.endsWith(".md");
}
function isVizFile(file: FileItem) {
  return file.mimeType === "text/html+viz" || file.filename.endsWith(".viz");
}
function isHtmlFile(file: FileItem) {
  return file.mimeType === "text/html" || file.filename.endsWith(".html");
}
function isPlainTextFile(file: FileItem) {
  return (file.mimeType === "text/plain" || file.filename.endsWith(".txt")) && !isMarkdownFile(file) && !isCodeFile(file) && !isHtmlFile(file) && !isVizFile(file);
}
function isCsvFile(file: FileItem) {
  return file.mimeType === "text/csv" || file.filename.endsWith(".csv");
}
const CODE_EXTENSIONS = [
  ".py", ".json", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
  ".css", ".scss", ".less",
  ".xml", ".svg", ".yaml", ".yml", ".toml",
  ".sql", ".rs", ".c", ".h", ".cpp", ".hpp", ".cc",
  ".java", ".php", ".go", ".rb", ".swift", ".kt",
  ".sh", ".bash", ".zsh",
  ".env", ".gitignore", ".dockerignore",
];
const CODE_FILENAMES = ["dockerfile", "makefile"];
function isCodeFile(file: FileItem) {
  return CODE_EXTENSIONS.some((ext) => file.filename.endsWith(ext))
    || CODE_FILENAMES.includes(file.filename.toLowerCase())
    || file.mimeType === "application/javascript"
    || file.mimeType === "application/typescript"
    || file.mimeType === "application/x-sh";
}
