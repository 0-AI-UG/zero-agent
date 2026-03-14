import { useState, useCallback } from "react";
import { CopyIcon, PencilIcon, SaveIcon, XIcon } from "lucide-react";
import CodeMirror from "@uiw/react-codemirror";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useUpdateFileContent } from "@/hooks/use-update-file-content";
import type { FileItem } from "@/hooks/use-files";
import type { Extension } from "@codemirror/state";

function getLanguageExtension(filename: string): Extension[] {
  if (filename.endsWith(".py")) return [python()];
  if (filename.endsWith(".json")) return [json()];
  return [];
}

interface CodePreviewProps {
  file: FileItem;
  content: string;
  projectId: string;
}

export function CodePreview({ file, content, projectId }: CodePreviewProps) {
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

  const onChange = useCallback((value: string) => {
    setEditContent(value);
  }, []);

  const extensions = getLanguageExtension(file.filename);

  return (
    <div className="p-4">
      <h3 className="text-base font-semibold mb-4">{file.filename}</h3>
      <div className="rounded-md border overflow-hidden">
        <CodeMirror
          value={isEditing ? editContent : content}
          extensions={extensions}
          onChange={isEditing ? onChange : undefined}
          editable={isEditing}
          readOnly={!isEditing}
          theme="dark"
          basicSetup={{
            lineNumbers: true,
            foldGutter: true,
            highlightActiveLine: isEditing,
          }}
          minHeight="200px"
          maxHeight="70vh"
        />
      </div>
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
