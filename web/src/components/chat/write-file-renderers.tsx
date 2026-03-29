import { useState, useEffect } from "react";
import type { LucideIcon } from "lucide-react";
import {
  BarChart3Icon,
  PresentationIcon,
  DownloadIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  MaximizeIcon,
  Loader2Icon,
} from "lucide-react";
import { usePresignedUrl } from "@/hooks/use-presigned-url";
import { useFilesStore } from "@/stores/files-store";
import { useConvertSlides, useSlidePreviews } from "@/api/slides";

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
      icon: BarChart3Icon,
    },
  },
  {
    match: (f) => f.endsWith(".slides"),
    component: SlidePreview,
    loading: {
      label: "Built presentation",
      activeLabel: "Building presentation",
      icon: PresentationIcon,
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
// VizPreview — full-width, no card wrapper
// ---------------------------------------------------------------------------

function VizPreview({ fileId, projectId, filename }: WriteFileRendererProps) {
  const { htmlContent, loading, url } = useHtmlContent(projectId, fileId);
  const { openFilePreview } = useFilesStore();

  if (loading || !htmlContent) {
    return (
      <div
        className="w-full my-2 flex items-center justify-center bg-muted/30 rounded-lg"
        style={{ height: 700 }}
      >
        <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="w-full my-2">
      <iframe
        srcDoc={htmlContent}
        sandbox="allow-scripts"
        title={filename}
        className="w-full rounded-lg border-none"
        style={{ height: 700 }}
      />
      <div className="flex items-center gap-1.5 mt-1.5 px-0.5 text-xs text-muted-foreground">
        <BarChart3Icon className="size-3 shrink-0" />
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

// ---------------------------------------------------------------------------
// SlidePreview — slide navigator with prev/next
// ---------------------------------------------------------------------------

function SlidePreview({ fileId, projectId, filename }: WriteFileRendererProps) {
  const { openFilePreview } = useFilesStore();
  const convertSlides = useConvertSlides(projectId);
  const { data, isLoading } = useSlidePreviews(projectId, fileId);
  const [currentSlide, setCurrentSlide] = useState(0);

  const totalSlides = data?.slideCount ?? 0;

  const prev = () => setCurrentSlide((c) => Math.max(0, c - 1));
  const next = () => setCurrentSlide((c) => Math.min(totalSlides - 1, c + 1));

  const handleDownloadPptx = () => {
    convertSlides.mutate(fileId, {
      onSuccess: (data) => {
        window.open(data.pptxUrl);
      },
    });
  };

  if (isLoading || !data) {
    return (
      <div className="w-full my-2">
        <div
          className="w-full flex items-center justify-center bg-black/50 rounded-lg"
          style={{ aspectRatio: "16/9" }}
        >
          <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  if (totalSlides === 0) {
    return (
      <div className="w-full my-2">
        <div
          className="w-full flex items-center justify-center bg-black/50 rounded-lg text-muted-foreground text-xs"
          style={{ aspectRatio: "16/9" }}
        >
          No slides found
        </div>
      </div>
    );
  }

  return (
    <div className="w-full my-2">
      <div
        className="relative overflow-hidden bg-black rounded-lg"
        style={{ aspectRatio: "16/9" }}
      >
        <img
          src={data.urls[currentSlide]}
          alt={`${filename} — slide ${currentSlide + 1}`}
          className="w-full h-full object-contain"
        />
      </div>
      <div className="flex items-center justify-between mt-2 px-0.5 text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <PresentationIcon className="size-3 shrink-0" />
          <span className="truncate">{filename}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={prev}
            disabled={currentSlide === 0}
            className="p-1 rounded hover:bg-muted disabled:opacity-30 transition-colors"
          >
            <ChevronLeftIcon className="size-3.5" />
          </button>
          <span className="min-w-[48px] text-center tabular-nums">
            {currentSlide + 1} / {totalSlides}
          </span>
          <button
            onClick={next}
            disabled={currentSlide === totalSlides - 1}
            className="p-1 rounded hover:bg-muted disabled:opacity-30 transition-colors"
          >
            <ChevronRightIcon className="size-3.5" />
          </button>
          <div className="w-px h-3 bg-border mx-1" />
          <button
            onClick={() => openFilePreview(fileId)}
            className="p-1 rounded hover:bg-muted transition-colors"
            title="Full preview"
          >
            <MaximizeIcon className="size-3" />
          </button>
          <button
            onClick={handleDownloadPptx}
            disabled={convertSlides.isPending}
            className="p-1 rounded hover:bg-muted disabled:opacity-50 transition-colors"
            title="Download PPTX"
          >
            {convertSlides.isPending ? (
              <Loader2Icon className="size-3 animate-spin" />
            ) : (
              <DownloadIcon className="size-3" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
