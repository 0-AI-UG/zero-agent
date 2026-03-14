import { useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { UploadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";
import { toast } from "sonner";
import type { FileItem } from "@/hooks/use-files";

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

function defaultFolderForFile(_file: File, currentPath: string): string {
  return currentPath;
}

interface UploadButtonProps {
  projectId: string;
  currentPath: string;
}

export function UploadButton({ projectId, currentPath }: UploadButtonProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const folderPath = defaultFolderForFile(file, currentPath);

      // 1. Request presigned upload URL
      const res = await apiFetch<{
        url: string;
        s3Key: string;
        file: FileItem;
      }>(`/projects/${projectId}/files/upload`, {
        method: "POST",
        body: JSON.stringify({
          filename: file.name,
          mimeType: file.type || "application/octet-stream",
          folderPath,
          sizeBytes: file.size,
        }),
      });

      // 2. Upload directly to S3
      const uploadRes = await fetch(res.url, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });

      if (!uploadRes.ok) {
        // Clean up the pre-created file record on upload failure
        await apiFetch(`/projects/${projectId}/files/${res.file.id}`, {
          method: "DELETE",
        }).catch(() => {});
        throw new Error("S3 upload failed");
      }

      return res.file;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.files.byProject(projectId),
      });
      toast("File uploaded.");
    },
    onError: () => {
      toast.error("Upload failed. Please try again.");
    },
  });

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > MAX_FILE_SIZE) {
      toast.error("File too large. Maximum size is 50 MB.");
      return;
    }

    uploadMutation.mutate(file);

    // Reset input so the same file can be selected again
    e.target.value = "";
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => fileInputRef.current?.click()}
        disabled={uploadMutation.isPending}
      >
        <UploadIcon className="h-4 w-4 mr-1" />
        {uploadMutation.isPending ? "Uploading..." : "Upload"}
      </Button>
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={handleFileSelect}
        accept="image/*,.pdf,.csv,.txt,.json,.md"
      />
    </>
  );
}
