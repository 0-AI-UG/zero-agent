import { useState, type ReactNode } from "react";
import { ArrowLeftIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Loader } from "@/components/ai/loader";
import { usePresignedUrl } from "@/hooks/use-presigned-url";
import { useFileContent } from "@/hooks/use-file-content";
import { useDeleteFile } from "@/hooks/use-delete-file";
import { PreviewActionsProvider } from "./preview-actions-context";
import { ImagePreview } from "./image-preview";
import { MarkdownPreview } from "./markdown-preview";
import { TextPreview } from "./text-preview";
import { CodePreview } from "./code-preview";
import { PackageJsonPreview } from "./package-json-preview";
import { CsvPreview } from "./csv-preview";
import { XlsxPreview } from "./xlsx-preview";
import { HtmlPreview } from "./html-preview";
import { VizPreview } from "./viz-preview";
import { DownloadFallback } from "./download-fallback";
import type { FileItem } from "@/hooks/use-files";

interface FilePreviewProps {
  file: FileItem;
  projectId: string;
  onBack: () => void;
}

export function FilePreview({ file, projectId, onBack }: FilePreviewProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [actions, setActions] = useState<ReactNode>(null);
  const { data: urlData, isLoading: urlLoading } = usePresignedUrl(
    projectId,
    file.id,
  );
  const url = urlData?.url;
  const thumbnailUrl = urlData?.thumbnailUrl;
  const { data: content, isLoading: contentLoading } = useFileContent(
    projectId,
    file,
  );
  const deleteFile = useDeleteFile(projectId);

  if (urlLoading || contentLoading) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <Loader size={24} />
      </div>
    );
  }

  return (
    <PreviewActionsProvider value={{ setActions }}>
      <div className="flex flex-col h-full">
        <div className="flex items-center gap-2 border-b px-4 py-2">
          <Button variant="ghost" size="icon-sm" onClick={onBack}>
            <ArrowLeftIcon className="h-4 w-4" />
          </Button>
          <p className="text-sm font-medium truncate flex-1">{file.filename}</p>
          {actions}
          <AlertDialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive">
                <Trash2Icon className="h-4 w-4" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent size="sm">
              <AlertDialogHeader>
                <AlertDialogTitle>Delete file</AlertDialogTitle>
                <AlertDialogDescription>
                  Are you sure you want to delete "{file.filename}"? This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  disabled={deleteFile.isPending}
                  onClick={() => {
                    deleteFile.mutate(file.id, {
                      onSuccess: () => {
                        setDialogOpen(false);
                        onBack();
                      },
                    });
                  }}
                >
                  {deleteFile.isPending ? "Deleting..." : "Delete"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
        <div className="flex-1 overflow-y-auto">
          <FilePreviewContent file={file} url={url} thumbnailUrl={thumbnailUrl} content={content} projectId={projectId} />
        </div>
      </div>
    </PreviewActionsProvider>
  );
}

function isMarkdownFile(file: FileItem): boolean {
  return file.mimeType === "text/markdown" || file.filename.endsWith(".md");
}

function isVizFile(file: FileItem): boolean {
  return file.mimeType === "text/html+viz" || file.filename.endsWith(".viz");
}

function isHtmlFile(file: FileItem): boolean {
  return file.mimeType === "text/html" || file.filename.endsWith(".html");
}

function isPlainTextFile(file: FileItem): boolean {
  return (file.mimeType === "text/plain" || file.filename.endsWith(".txt")) && !isMarkdownFile(file) && !isCodeFile(file) && !isHtmlFile(file) && !isVizFile(file);
}

function isCsvFile(file: FileItem): boolean {
  return file.mimeType === "text/csv" || file.filename.endsWith(".csv");
}

function isExcelFile(file: FileItem): boolean {
  return (
    file.mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    file.mimeType === "application/vnd.ms-excel" ||
    file.filename.endsWith(".xlsx") ||
    file.filename.endsWith(".xls")
  );
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

function isCodeFile(file: FileItem): boolean {
  return CODE_EXTENSIONS.some((ext) => file.filename.endsWith(ext))
    || CODE_FILENAMES.includes(file.filename.toLowerCase())
    || file.mimeType === "application/javascript"
    || file.mimeType === "application/typescript"
    || file.mimeType === "application/x-sh";
}

function FilePreviewContent({
  file,
  url,
  thumbnailUrl,
  content,
  projectId,
}: {
  file: FileItem;
  url?: string;
  thumbnailUrl?: string;
  content?: string;
  projectId: string;
}) {
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

  if (isExcelFile(file) && url) {
    return <XlsxPreview file={file} url={url} projectId={projectId} />;
  }

  if (file.filename === "package.json" && content !== undefined) {
    return <PackageJsonPreview file={file} content={content} projectId={projectId} />;
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
