import { useState, useCallback, useEffect } from "react";
import { CopyIcon, SaveIcon } from "lucide-react";
import CodeMirror from "@uiw/react-codemirror";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";
import { javascript } from "@codemirror/lang-javascript";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { markdown } from "@codemirror/lang-markdown";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { sql } from "@codemirror/lang-sql";
import { rust } from "@codemirror/lang-rust";
import { cpp } from "@codemirror/lang-cpp";
import { java } from "@codemirror/lang-java";
import { php } from "@codemirror/lang-php";
import { go } from "@codemirror/lang-go";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useUpdateFileContent } from "@/hooks/use-update-file-content";
import { usePreviewActions } from "./preview-actions-context";
import type { FileItem } from "@/hooks/use-files";
import type { Extension } from "@codemirror/state";

const LANG_MAP: Record<string, () => Extension> = {
  ".py": () => python(),
  ".json": () => json(),
  ".js": () => javascript(),
  ".jsx": () => javascript({ jsx: true }),
  ".ts": () => javascript({ typescript: true }),
  ".tsx": () => javascript({ jsx: true, typescript: true }),
  ".mjs": () => javascript(),
  ".cjs": () => javascript(),
  ".html": () => html(),
  ".htm": () => html(),
  ".css": () => css(),
  ".scss": () => css(),
  ".less": () => css(),
  ".md": () => markdown(),
  ".mdx": () => markdown(),
  ".xml": () => xml(),
  ".svg": () => xml(),
  ".yaml": () => yaml(),
  ".yml": () => yaml(),
  ".sql": () => sql(),
  ".rs": () => rust(),
  ".c": () => cpp(),
  ".h": () => cpp(),
  ".cpp": () => cpp(),
  ".hpp": () => cpp(),
  ".cc": () => cpp(),
  ".java": () => java(),
  ".php": () => php(),
  ".go": () => go(),
  ".sh": () => javascript(), // basic highlighting fallback
  ".bash": () => javascript(),
  ".zsh": () => javascript(),
  ".toml": () => javascript(),
  ".env": () => javascript(),
  ".gitignore": () => javascript(),
  ".dockerignore": () => javascript(),
  ".dockerfile": () => javascript(),
};

function getLanguageExtension(filename: string): Extension[] {
  const lower = filename.toLowerCase();
  // Match longest suffix first (e.g. ".test.ts" still matches ".ts")
  for (const [ext, factory] of Object.entries(LANG_MAP)) {
    if (lower.endsWith(ext)) return [factory()];
  }
  // Special filenames
  if (lower === "dockerfile") return [javascript()];
  if (lower === "makefile") return [javascript()];
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
