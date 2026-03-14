import { useState, useCallback, useEffect } from "react";
import { CopyIcon, SaveIcon } from "lucide-react";
import CodeMirror from "@uiw/react-codemirror";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useUpdateFileContent } from "@/hooks/use-update-file-content";
import { usePreviewActions } from "./preview-actions-context";
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
  const [editContent, setEditContent] = useState(content);
  const updateFile = useUpdateFileContent(projectId);
  const isDirty = editContent !== content;
  const { setActions } = usePreviewActions();

  const handleSave = () => {
    updateFile.mutate(
      { fileId: file.id, content: editContent },
      {
        onSuccess: () => toast("File saved"),
        onError: () => toast.error("Failed to save file"),
      },
    );
  };

  useEffect(() => {
    setActions(
      <>
        <Button
          variant="default"
          size="sm"
          onClick={handleSave}
          disabled={updateFile.isPending || !isDirty}
        >
          <SaveIcon className="h-4 w-4 mr-1" />
          {updateFile.isPending ? "Saving..." : "Save"}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => {
            navigator.clipboard.writeText(editContent).then(() => {
              toast("Copied to clipboard");
            });
          }}
        >
          <CopyIcon className="h-4 w-4" />
        </Button>
      </>
    );
    return () => setActions(null);
  }, [isDirty, updateFile.isPending, editContent]);

  const onChange = useCallback((value: string) => {
    setEditContent(value);
  }, []);

  const extensions = getLanguageExtension(file.filename);

  return (
    <div className="p-4">
      <div className="rounded-md border overflow-hidden">
        <CodeMirror
          value={editContent}
          extensions={extensions}
          onChange={onChange}
          theme="dark"
          basicSetup={{
            lineNumbers: true,
            foldGutter: true,
            highlightActiveLine: true,
          }}
          minHeight="200px"
          maxHeight="70vh"
        />
      </div>
    </div>
  );
}
