import { useState, useEffect, useRef, useCallback } from "react";
import type { LucideIcon } from "lucide-react";
import {
  PenToolIcon,
  DownloadIcon,
  MaximizeIcon,
  Loader2Icon,
} from "lucide-react";
import { usePresignedUrl } from "@/hooks/use-presigned-url";
import { useFilesStore } from "@/stores/files-store";

// ---------------------------------------------------------------------------
// Registry types
// ---------------------------------------------------------------------------

export interface WriteFileRendererProps {
  fileId: string;
  projectId: string;
  filename: string;
  output: any;
}

export interface WriteFileRendererEntry {
  match: (filename: string) => boolean;
  component: React.ComponentType<WriteFileRendererProps>;
  loading: { label: string; activeLabel: string; icon: LucideIcon };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const writeFileRenderers: WriteFileRendererEntry[] = [
  {
    match: (f) => f.endsWith(".viz"),
    component: VizPreview,
    loading: {
      label: "Created visualization",
      activeLabel: "Creating visualization",
      icon: PenToolIcon,
    },
  },
];

export function findWriteFileRenderer(
  filename: string,
): WriteFileRendererEntry | undefined {
  return writeFileRenderers.find((r) => r.match(filename));
}

// ---------------------------------------------------------------------------
// Shared hook: fetch HTML content via presigned URL
// ---------------------------------------------------------------------------

function useHtmlContent(projectId: string, fileId: string) {
  const { data: urlData } = usePresignedUrl(projectId, fileId);
  const url = urlData?.url;
  const [htmlContent, setHtmlContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!url) return;
    setLoading(true);
    fetch(url)
      .then((res) => res.text())
      .then((text) => {
        setHtmlContent(text);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [url]);

  return { htmlContent, loading, url };
}

// ---------------------------------------------------------------------------
// Resize script injected into viz HTML for dynamic height
// ---------------------------------------------------------------------------

const RESIZE_SCRIPT = `<script>
(function(){
  var last=0,tid=0;
  function post(){
    var h=document.documentElement.scrollHeight;
    if(h!==last){last=h;window.parent.postMessage({type:'viz-resize',height:h},'*');}
  }
  new ResizeObserver(function(){clearTimeout(tid);tid=setTimeout(post,80);}).observe(document.body);
  setTimeout(post,0);
  setTimeout(post,300);
})();
</script>`;

function injectResizeScript(html: string): string {
  const idx = html.lastIndexOf("</body>");
  if (idx !== -1) {
    return html.slice(0, idx) + RESIZE_SCRIPT + html.slice(idx);
  }
  return html + RESIZE_SCRIPT;
}

// ---------------------------------------------------------------------------
// VizPreview — dynamic height, canvas feel
// ---------------------------------------------------------------------------

function VizPreview({ fileId, projectId, filename }: WriteFileRendererProps) {
  const { htmlContent, loading, url } = useHtmlContent(projectId, fileId);
  const { openFilePreview } = useFilesStore();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iframeHeight, setIframeHeight] = useState(300);

  const handleMessage = useCallback((e: MessageEvent) => {
    if (
      e.source === iframeRef.current?.contentWindow &&
      e.data?.type === "viz-resize" &&
      typeof e.data.height === "number"
    ) {
      setIframeHeight(Math.max(100, e.data.height));
    }
  }, []);

  useEffect(() => {
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handleMessage]);

  if (loading || !htmlContent) {
    return (
      <div
        className="w-full my-1 flex items-center justify-center bg-muted/30 rounded-lg"
        style={{ height: 200 }}
      >
        <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="group w-full my-1 relative">
      <iframe
        ref={iframeRef}
        srcDoc={injectResizeScript(htmlContent)}
        sandbox="allow-scripts"
        title={filename}
        className="w-full border-none"
        style={{
          height: iframeHeight,
          transition: "height 0.15s ease",
        }}
      />
      <div className="flex items-center gap-1.5 mt-1 px-0.5 text-xs text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">
        <PenToolIcon className="size-3 shrink-0" />
        <span className="truncate">{filename}</span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => openFilePreview(fileId)}
            className="hover:text-foreground transition-colors"
            title="Full preview"
          >
            <MaximizeIcon className="size-3" />
          </button>
          {url && (
            <button
              onClick={() => window.open(url)}
              className="hover:text-foreground transition-colors"
              title="Download"
            >
              <DownloadIcon className="size-3" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
