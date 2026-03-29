import { useState, useEffect } from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  Loader2Icon,
  PresentationIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Loader } from "@/components/ai/loader";
import { useSlidePreviews, useConvertSlides } from "@/api/slides";
import { usePreviewActions } from "./preview-actions-context";
import type { FileItem } from "@/hooks/use-files";

interface SlidesPreviewProps {
  file: FileItem;
  projectId: string;
}

export function SlidesPreview({ file, projectId }: SlidesPreviewProps) {
  const { data, isLoading } = useSlidePreviews(projectId, file.id);
  const convertSlides = useConvertSlides(projectId);
  const { setActions } = usePreviewActions();
  const [currentSlide, setCurrentSlide] = useState(0);

  const totalSlides = data?.slideCount ?? 0;

  const prev = () => setCurrentSlide((c) => Math.max(0, c - 1));
  const next = () => setCurrentSlide((c) => Math.min(totalSlides - 1, c + 1));

  useEffect(() => {
    setActions(
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          convertSlides.mutate(file.id, {
            onSuccess: (data) => {
              window.open(data.pptxUrl);
            },
          });
        }}
        disabled={convertSlides.isPending}
      >
        {convertSlides.isPending ? (
          <Loader2Icon className="size-3.5 mr-1.5 animate-spin" />
        ) : (
          <DownloadIcon className="size-3.5 mr-1.5" />
        )}
        Download PPTX
      </Button>,
    );
    return () => setActions(null);
  }, [file.id, convertSlides.isPending]);

  if (isLoading || !data) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader size={20} />
      </div>
    );
  }

  if (totalSlides === 0) {
    return (
      <div className="flex items-center justify-center p-12 text-muted-foreground text-sm">
        No slides found
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 min-h-0 flex items-center justify-center bg-muted p-4">
        <img
          src={data.urls[currentSlide]}
          alt={`${file.filename} — slide ${currentSlide + 1}`}
          className="max-w-full max-h-full object-contain"
          style={{ aspectRatio: "16/9" }}
        />
      </div>
      <div className="flex items-center justify-between px-4 py-2 border-t text-sm text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <PresentationIcon className="size-3.5 shrink-0" />
          <span className="truncate">{file.filename}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={prev}
            disabled={currentSlide === 0}
            className="p-1 rounded hover:bg-muted disabled:opacity-30"
          >
            <ChevronLeftIcon className="size-4" />
          </button>
          <span className="min-w-[48px] text-center tabular-nums">
            {currentSlide + 1} / {totalSlides}
          </span>
          <button
            onClick={next}
            disabled={currentSlide === totalSlides - 1}
            className="p-1 rounded hover:bg-muted disabled:opacity-30"
          >
            <ChevronRightIcon className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
