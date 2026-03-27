import { useMutation, useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/api/client";

interface ConvertSlidesResponse {
  pptxFileId: string;
  pptxUrl: string;
  pptxFilename: string;
}

export function useConvertSlides(projectId: string) {
  return useMutation({
    mutationFn: async (fileId: string) => {
      return apiFetch<ConvertSlidesResponse>(
        `/projects/${projectId}/slides/convert`,
        { method: "POST", body: JSON.stringify({ fileId }) },
      );
    },
  });
}

interface SlidePreviewsResponse {
  urls: string[];
  slideCount: number;
}

export function useSlidePreviews(projectId: string, fileId: string) {
  return useQuery({
    queryKey: ["slidePreviews", projectId, fileId],
    queryFn: () =>
      apiFetch<SlidePreviewsResponse>(
        `/projects/${projectId}/slides/previews`,
        { method: "POST", body: JSON.stringify({ fileId }) },
      ),
    enabled: !!projectId && !!fileId,
    staleTime: 10 * 60_000,
    gcTime: 30 * 60_000,
  });
}

interface ConvertSlidesPdfResponse {
  pdfFileId: string;
  pdfUrl: string;
  pdfFilename: string;
}

export function useConvertSlidesPdf(projectId: string) {
  return useMutation({
    mutationFn: async (fileId: string) => {
      return apiFetch<ConvertSlidesPdfResponse>(
        `/projects/${projectId}/slides/convert-pdf`,
        { method: "POST", body: JSON.stringify({ fileId }) },
      );
    },
  });
}
