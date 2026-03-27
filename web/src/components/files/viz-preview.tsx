import type { FileItem } from "@/hooks/use-files";

interface VizPreviewProps {
  file: FileItem;
  content: string;
}

export function VizPreview({ file, content }: VizPreviewProps) {
  return (
    <div className="p-4 flex flex-col h-full">
      <iframe
        srcDoc={content}
        sandbox="allow-scripts"
        title={file.filename}
        className="w-full flex-1 min-h-[400px] rounded-md border bg-white"
      />
    </div>
  );
}
