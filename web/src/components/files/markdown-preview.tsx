import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CopyIcon, PencilIcon, SaveIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useUpdateFileContent } from "@/hooks/use-update-file-content";
import type { FileItem } from "@/hooks/use-files";

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;

function stripFrontmatter(text: string): string {
  return text.replace(FRONTMATTER_RE, "").trimStart();
}

interface MarkdownPreviewProps {
  file: FileItem;
  content: string;
  projectId: string;
}

export function MarkdownPreview({ file, content, projectId }: MarkdownPreviewProps) {
  const displayContent = stripFrontmatter(content);
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const updateFile = useUpdateFileContent(projectId);

  const handleEdit = () => {
    setEditContent(content);
    setIsEditing(true);
  };

  const handleSave = () => {
    updateFile.mutate(
      { fileId: file.id, content: editContent },
      {
        onSuccess: () => {
          toast("File saved");
          setIsEditing(false);
        },
        onError: () => {
          toast.error("Failed to save file");
        },
      },
    );
  };

  return (
    <div className="p-4">
      <h3 className="text-base font-semibold mb-4">{file.filename}</h3>
      {isEditing ? (
        <textarea
          value={editContent}
          onChange={(e) => setEditContent(e.target.value)}
          className="w-full min-h-[400px] p-4 rounded-md border bg-background font-mono text-sm resize-y focus:outline-none focus:ring-2 focus:ring-ring"
        />
      ) : (
        <div className="prose prose-sm dark:prose-invert max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{displayContent}</ReactMarkdown>
        </div>
      )}
      <div className="flex gap-2 mt-4">
        {isEditing ? (
          <>
            <Button
              variant="default"
              size="sm"
              onClick={handleSave}
              disabled={updateFile.isPending}
            >
              <SaveIcon className="h-4 w-4 mr-1" />
              {updateFile.isPending ? "Saving..." : "Save"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsEditing(false)}
              disabled={updateFile.isPending}
            >
              <XIcon className="h-4 w-4 mr-1" />
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" size="sm" onClick={handleEdit}>
              <PencilIcon className="h-4 w-4 mr-1" />
              Edit
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                navigator.clipboard.writeText(content).then(() => {
                  toast("Copied to clipboard");
                });
              }}
            >
              <CopyIcon className="h-4 w-4 mr-1" />
              Copy
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
