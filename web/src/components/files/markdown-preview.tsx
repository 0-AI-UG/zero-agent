import { useState, useEffect, useRef } from "react";
import {
  MDXEditor,
  headingsPlugin,
  listsPlugin,
  quotePlugin,
  thematicBreakPlugin,
  linkPlugin,
  linkDialogPlugin,
  tablePlugin,
  toolbarPlugin,
  markdownShortcutPlugin,
  codeBlockPlugin,
  frontmatterPlugin,
  BoldItalicUnderlineToggles,
  ListsToggle,
  BlockTypeSelect,
  CreateLink,
  InsertTable,
  UndoRedo,
  type MDXEditorMethods,
} from "@mdxeditor/editor";
import "@mdxeditor/editor/style.css";
import { CopyIcon, SaveIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useTheme } from "next-themes";
import { useUpdateFileContent } from "@/hooks/use-update-file-content";
import { usePreviewActions } from "./preview-actions-context";
import type { FileItem } from "@/hooks/use-files";

interface MarkdownPreviewProps {
  file: FileItem;
  content: string;
  projectId: string;
}

export function MarkdownPreview({ file, content, projectId }: MarkdownPreviewProps) {
  const editorRef = useRef<MDXEditorMethods>(null);
  const { resolvedTheme } = useTheme();
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

  return (
    <div className="mdxeditor-wrapper p-4">
      <MDXEditor
        key={file.id}
        ref={editorRef}
        className={resolvedTheme === "dark" ? "dark-theme" : ""}
        markdown={content}
        onChange={setEditContent}
        contentEditableClassName="prose prose-sm dark:prose-invert max-w-none min-h-[300px] focus:outline-none"
        plugins={[
          headingsPlugin(),
          listsPlugin(),
          quotePlugin(),
          thematicBreakPlugin(),
          linkPlugin(),
          linkDialogPlugin(),
          tablePlugin(),
          codeBlockPlugin(),
          frontmatterPlugin(),
          markdownShortcutPlugin(),
          toolbarPlugin({
            toolbarContents: () => (
              <>
                <UndoRedo />
                <BlockTypeSelect />
                <BoldItalicUnderlineToggles />
                <ListsToggle />
                <CreateLink />
                <InsertTable />
              </>
            ),
          }),
        ]}
      />
    </div>
  );
}
