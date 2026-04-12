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
  codeMirrorPlugin,
  frontmatterPlugin,
  diffSourcePlugin,
  BoldItalicUnderlineToggles,
  ListsToggle,
  BlockTypeSelect,
  CreateLink,
  InsertTable,
  UndoRedo,
  DiffSourceToggleWrapper,
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
        onSuccess: () => toast.success("File saved"),
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
              toast.success("Copied to clipboard");
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
          codeBlockPlugin({ defaultCodeBlockLanguage: "text" }),
          codeMirrorPlugin({
            codeBlockLanguages: {
              text: "Text",
              js: "JavaScript",
              ts: "TypeScript",
              tsx: "TSX",
              jsx: "JSX",
              css: "CSS",
              html: "HTML",
              json: "JSON",
              python: "Python",
              bash: "Bash",
              sh: "Shell",
              sql: "SQL",
              yaml: "YAML",
              xml: "XML",
              markdown: "Markdown",
              md: "Markdown",
              "": "Text",
            },
          }),
          frontmatterPlugin(),
          diffSourcePlugin({ viewMode: "rich-text" }),
          markdownShortcutPlugin(),
          toolbarPlugin({
            toolbarContents: () => (
              <DiffSourceToggleWrapper options={["rich-text", "source"]}>
                <UndoRedo />
                <BlockTypeSelect />
                <BoldItalicUnderlineToggles />
                <ListsToggle />
                <CreateLink />
                <InsertTable />
              </DiffSourceToggleWrapper>
            ),
          }),
        ]}
      />
    </div>
  );
}
