import { useState, useEffect, useRef, useCallback } from "react";
import type { LucideIcon } from "lucide-react";
import {
  PenToolIcon,
  DownloadIcon,
  Loader2Icon,
} from "lucide-react";
import { usePresignedUrl } from "@/hooks/use-presigned-url";
import { Shimmer } from "@/components/ai/shimmer";
import {
  buildVizShell,
  prepareFragment,
} from "@/lib/viz-design-system";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Registry types
// ---------------------------------------------------------------------------

export interface WriteFileRendererProps {
  fileId: string;
  projectId: string;
  filename: string;
  output: any;
  /** When provided, render directly from this content instead of fetching from S3. */
  content?: string;
  /** True while the agent is still streaming the writeFile tool input. */
  isStreaming?: boolean;
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

function useHtmlContent(projectId: string, fileId: string, enabled: boolean) {
  const { data: urlData } = usePresignedUrl(
    enabled ? projectId : "",
    enabled ? fileId : "",
  );
  const url = urlData?.url;
  const [htmlContent, setHtmlContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);

  useEffect(() => {
    if (!enabled || !url) return;
    setLoading(true);
    fetch(url)
      .then((res) => res.text())
      .then((text) => {
        setHtmlContent(text);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [url, enabled]);

  return { htmlContent, loading, url };
}

// ---------------------------------------------------------------------------
// VizPreview — single component for both streaming and complete phases.
//
// Strategy: mount the iframe ONCE. On first content chunk, call document.open()
// and write the shell (doctype/html/head with design system/body). On every
// subsequent chunk, write only the newly-appended delta — **without closing**.
// The browser's HTML parser is in incremental streaming mode, so unclosed
// `<script>` / `<style>` tags are buffered until the closing tag arrives. No
// raw source ever leaks, animations play exactly once per element, and there
// is no iframe reload between chunks.
//
// When streaming finishes (isStreaming=false with content present), we call
// document.close() once to finalize parsing.
// ---------------------------------------------------------------------------

interface VizIframeState {
  opened: boolean;
  writtenLen: number;
  closed: boolean;
  ready: boolean;
}

function VizPreview({
  fileId,
  projectId,
  filename,
  content: directContent,
  isStreaming = false,
}: WriteFileRendererProps) {
  const { resolvedTheme } = useTheme();
  const theme: "light" | "dark" = resolvedTheme === "dark" ? "dark" : "light";

  // Fetch from S3 only when we don't already have direct content and the file
  // exists (i.e. we're rendering a historical message, not an in-progress one).
  const needsFetch = !directContent && !!fileId && !isStreaming;
  const { htmlContent: fetchedContent, loading, url } = useHtmlContent(
    projectId,
    fileId,
    needsFetch,
  );

  const rawContent = directContent ?? fetchedContent ?? "";
  const fragment = rawContent ? prepareFragment(rawContent) : "";

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const stateRef = useRef<VizIframeState>({
    opened: false,
    writtenLen: 0,
    closed: false,
    ready: false,
  });
  const [iframeHeight, setIframeHeight] = useState(120);

  // --- Resize listener ------------------------------------------------------
  const handleMessage = useCallback((e: MessageEvent) => {
    if (
      e.source === iframeRef.current?.contentWindow &&
      e.data?.type === "viz-resize" &&
      typeof e.data.height === "number"
    ) {
      setIframeHeight(Math.max(80, e.data.height));
    }
  }, []);

  useEffect(() => {
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handleMessage]);

  // --- Theme toggle: flip data-theme attribute, never reload ----------------
  useEffect(() => {
    const doc = iframeRef.current?.contentDocument;
    const state = stateRef.current;
    if (!state.opened || !doc?.documentElement) return;
    doc.documentElement.dataset.theme = theme;
  }, [theme]);

  // --- Incremental streaming write ------------------------------------------
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const state = stateRef.current;
    if (!state.ready) return;
    const doc = iframe.contentDocument;
    if (!doc) return;

    // Nothing to write yet
    if (!fragment) return;

    // First write: open the document and emit the shell.
    if (!state.opened) {
      doc.open();
      doc.write(buildVizShell(theme));
      state.opened = true;
      state.writtenLen = 0;
      state.closed = false;
    }

    // Delta write. Streaming from writeFile is append-only in practice, so
    // we only need to handle two cases: grow (write the delta) or shrink
    // (rare — content was replaced; rebuild from scratch).
    const prevWritten = state.writtenLen;
    if (fragment.length >= prevWritten) {
      if (fragment.length > prevWritten) {
        doc.write(fragment.slice(prevWritten));
        state.writtenLen = fragment.length;
      }
    } else {
      doc.open();
      doc.write(buildVizShell(theme) + fragment);
      state.writtenLen = fragment.length;
      state.closed = false;
    }

    // Finalize once streaming is done.
    if (!isStreaming && !state.closed) {
      doc.close();
      state.closed = true;
    }
  }, [fragment, isStreaming, theme]);

  // Iframe onLoad — marks the about:blank document as ready to receive writes.
  const handleLoad = useCallback(() => {
    stateRef.current.ready = true;
    // Kick the write effect by forcing a re-render via height state no-op.
    setIframeHeight((h) => h);
  }, []);

  // Loading spinner when we have no content yet and are fetching from S3.
  if (!fragment && needsFetch && loading) {
    return (
      <div
        className="w-full my-1 flex items-center justify-center bg-muted/30 rounded-lg"
        style={{ height: 120 }}
      >
        <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="group w-full my-1 relative">
      <iframe
        ref={iframeRef}
        // srcDoc=" " forces a same-origin about:blank with a ready document.
        srcDoc=" "
        onLoad={handleLoad}
        sandbox="allow-scripts"
        title={filename}
        className="w-full border-none rounded-lg bg-transparent"
        style={{
          height: iframeHeight,
          transition: "height 0.3s cubic-bezier(0.16, 1, 0.3, 1)",
        }}
      />
      <div
        className={cn(
          "flex items-center gap-1.5 mt-1 px-0.5 text-xs text-muted-foreground",
          !isStreaming &&
            "opacity-0 group-hover:opacity-100 transition-opacity",
        )}
      >
        <PenToolIcon className="size-3 shrink-0" />
        {isStreaming ? (
          <Shimmer className="text-xs" duration={1.5}>
            Painting
          </Shimmer>
        ) : null}
        <span className="truncate ml-1">{filename}</span>
        {!isStreaming && url && (
          <button
            onClick={() => window.open(url)}
            className="ml-auto hover:text-foreground transition-colors"
            title="Download"
          >
            <DownloadIcon className="size-3" />
          </button>
        )}
      </div>
    </div>
  );
}

