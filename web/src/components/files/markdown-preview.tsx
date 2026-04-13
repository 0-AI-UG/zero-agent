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
import { CopyIcon, SaveIcon, MoreVerticalIcon, TypeIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { useTheme } from "next-themes";
import { useUpdateFileContent } from "@/hooks/use-update-file-content";
import { usePreviewActions } from "./preview-actions-context";
import type { FileItem } from "@/hooks/use-files";
import { cn } from "@/lib/utils";

interface MarkdownPreviewProps {
  file: FileItem;
  content: string;
  projectId: string;
}

export function MarkdownPreview({ file, content, projectId }: MarkdownPreviewProps) {
  const editorRef = useRef<MDXEditorMethods>(null);
  const { resolvedTheme } = useTheme();
  const [editContent, setEditContent] = useState(content);
  const [showToolbar, setShowToolbar] = useState(false);
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

  const handleCopy = () => {
    navigator.clipboard.writeText(editContent).then(() => {
      toast.success("Copied to clipboard");
    });
  };

  useEffect(() => {
    setActions(
      <div className="flex items-center gap-1">
        {isDirty && (
          <Button
            variant="default"
            size="sm"
            onClick={handleSave}
            disabled={updateFile.isPending}
          >
            <SaveIcon className="h-3.5 w-3.5 mr-1" />
            {updateFile.isPending ? "Saving..." : "Save"}
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm">
              <MoreVerticalIcon className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setShowToolbar((v) => !v)}>
              <TypeIcon className="h-3.5 w-3.5 mr-2" />
              {showToolbar ? "Hide formatting" : "Show formatting"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={handleCopy}>
              <CopyIcon className="h-3.5 w-3.5 mr-2" />
              Copy content
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
    return () => setActions(null);
  }, [isDirty, updateFile.isPending, editContent, showToolbar]);

  return (
    <div className={cn("mdxeditor-wrapper p-4", !showToolbar && "mdxeditor-toolbar-hidden")}>
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
