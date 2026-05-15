import { useState, useEffect } from "react";
import { CopyIcon, SaveIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useUpdateFileContent } from "@/hooks/use-update-file-content";
import { usePreviewActions } from "./preview-actions-context";
import type { FileItem } from "@/hooks/use-files";

interface TextPreviewProps {
  file: FileItem;
  content: string;
  projectId: string;
}

export function TextPreview({ file, content, projectId }: TextPreviewProps) {
  const [editContent, setEditContent] = useState(content);
  const updateFile = useUpdateFileContent(projectId);
  const readOnly = file.isSymlink === true;
  const isDirty = !readOnly && editContent !== content;
  const { setActions } = usePreviewActions();

  const handleSave = () => {
    updateFile.mutate(
      { fileId: file.id, content: editContent },
      {
        onSuccess: () => toast.success("File saved"),
        onError: () => toast.error("Failed to save file"),
      },
    );
  };

  useEffect(() => {
    setActions(
      <>
        {!readOnly && (
          <Button
            variant="default"
            size="sm"
            onClick={handleSave}
            disabled={updateFile.isPending || !isDirty}
          >
            <SaveIcon className="h-4 w-4 mr-1" />
            {updateFile.isPending ? "Saving..." : "Save"}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => {
            navigator.clipboard.writeText(editContent).then(() => {
              toast.success("Copied to clipboard");
            });
          }}
        >
          <CopyIcon className="h-4 w-4" />
        </Button>
      </>
    );
    return () => setActions(null);
  }, [isDirty, updateFile.isPending, editContent, readOnly]);

  return (
    <div className="p-4">
      {readOnly && (
        <div className="mb-2 text-xs text-muted-foreground">
          Read-only
        </div>
      )}
      <textarea
        value={editContent}
        onChange={(e) => setEditContent(e.target.value)}
        readOnly={readOnly}
        className="w-full min-h-[400px] p-4 rounded-md border bg-background font-mono text-sm resize-y focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60 read-only:bg-muted/30"
      />
    </div>
  );
}
