import { useCallback } from "react";
import { useDropzone } from "react-dropzone";
import { UploadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUploadFiles } from "@/hooks/use-upload-files";

interface UploadButtonProps {
  projectId: string;
  currentPath: string;
  compact?: boolean;
}

export function UploadButton({ projectId, currentPath, compact }: UploadButtonProps) {
  const { upload, isUploading } = useUploadFiles(projectId);

  const onDrop = useCallback(
    (files: File[]) => {
      void upload(files, currentPath);
    },
    [upload, currentPath],
  );

  // noDrag/noClick: this component only opens the picker. Page-level drop is
  // wired up separately so it covers the whole file explorer including folders.
  const { getInputProps, open } = useDropzone({
    onDrop,
    noDrag: true,
    noClick: true,
    noKeyboard: true,
    multiple: true,
  });

  return (
    <>
      <Button
        variant="outline"
        size={compact ? "icon" : "sm"}
        className={compact ? "h-8 w-8" : undefined}
        onClick={open}
        disabled={isUploading}
        title="Upload files (drop folders onto the file list to upload recursively)"
      >
        <UploadIcon className={compact ? "h-4 w-4" : "h-4 w-4 mr-1"} />
        {!compact && (isUploading ? "Uploading..." : "Upload")}
      </Button>
      <input {...getInputProps()} />
    </>
  );
}
