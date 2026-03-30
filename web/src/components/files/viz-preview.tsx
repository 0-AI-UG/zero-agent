import { useState, useEffect } from "react";
import { DownloadIcon, ImageIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePreviewActions } from "./preview-actions-context";
import { exportAsPng, exportAsPdf } from "@/lib/export-html";
import { injectVizDesignSystem } from "@/lib/viz-design-system";
import { useTheme } from "next-themes";
import type { FileItem } from "@/hooks/use-files";

interface VizPreviewProps {
  file: FileItem;
  content: string;
}

export function VizPreview({ file, content }: VizPreviewProps) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const { setActions } = usePreviewActions();
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    setActions(
      <div className="flex items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          disabled={exporting}
          onClick={async () => {
            setExporting(true);
            try {
              await exportAsPng(content, file.filename);
            } finally {
              setExporting(false);
            }
          }}
        >
          {exporting ? (
            <Loader2Icon className="size-3.5 mr-1.5 animate-spin" />
          ) : (
            <ImageIcon className="size-3.5 mr-1.5" />
          )}
          Export PNG
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => exportAsPdf(content, file.filename)}
        >
          <DownloadIcon className="size-3.5 mr-1.5" />
          Export PDF
        </Button>
      </div>,
    );
    return () => setActions(null);
  }, [file.filename, content, exporting]);

  return (
    <div className="p-4 flex flex-col h-full">
      <iframe
        srcDoc={injectVizDesignSystem(content, { isDark, streaming: false })}
        sandbox="allow-scripts"
        title={file.filename}
        className="w-full flex-1 rounded-md border bg-white"
      />
    </div>
  );
}
