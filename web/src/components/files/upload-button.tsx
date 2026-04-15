import { useRef } from "react";
import { FolderUpIcon, FileUpIcon, UploadIcon, ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  entriesFromFileList,
  useUploadFiles,
} from "@/hooks/use-upload-files";

interface UploadButtonProps {
  projectId: string;
  currentPath: string;
  compact?: boolean;
}

export function UploadButton({ projectId, currentPath, compact }: UploadButtonProps) {
  const filesInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const { upload, isUploading } = useUploadFiles(projectId);

  function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const list = e.target.files;
    if (!list || list.length === 0) return;
    void upload(entriesFromFileList(list), currentPath);
    e.target.value = "";
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size={compact ? "icon" : "sm"}
            className={compact ? "h-8 w-8" : undefined}
            disabled={isUploading}
            title="Upload"
          >
            <UploadIcon className={compact ? "h-4 w-4" : "h-4 w-4 mr-1"} />
            {!compact && (isUploading ? "Uploading..." : "Upload")}
            {!compact && <ChevronDownIcon className="h-3.5 w-3.5 ml-1 opacity-60" />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => filesInputRef.current?.click()}>
            <FileUpIcon className="h-4 w-4 mr-2" />
            Upload files
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => folderInputRef.current?.click()}>
            <FolderUpIcon className="h-4 w-4 mr-2" />
            Upload folder
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <input
        ref={filesInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFiles}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFiles}
        // Non-standard attrs for folder picking — cast via any-like approach
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
      />
    </>
  );
}
