import { useRef, useState, useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import { CameraIcon, UploadIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { parseScreenshot } from "@/api/files";
import { toast } from "sonner";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1] ?? ""); // strip data:...;base64, prefix
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

interface ScreenshotButtonProps {
  projectId: string;
  onExtracted: (text: string) => void;
}

export function ScreenshotButton({ projectId, onExtracted }: ScreenshotButtonProps) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const extractMutation = useMutation({
    mutationFn: async (imageFile: File) => {
      const base64 = await fileToBase64(imageFile);
      const mediaType = imageFile.type || "image/png";
      const result = await parseScreenshot(projectId, base64, mediaType);
      return result.text;
    },
    onSuccess: (text) => {
      onExtracted(text);
      handleClose();
      toast("Profile info extracted.");
    },
    onError: () => {
      toast.error("Failed to extract profile info.");
    },
  });

  const handleClose = useCallback(() => {
    setOpen(false);
    setPreview(null);
    setFile(null);
  }, []);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (!selected) return;
    setFile(selected);
    const reader = new FileReader();
    reader.onload = () => setPreview(reader.result as string);
    reader.readAsDataURL(selected);
    e.target.value = "";
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const dropped = e.dataTransfer.files[0];
    if (dropped?.type.startsWith("image/")) {
      setFile(dropped);
      const reader = new FileReader();
      reader.onload = () => setPreview(reader.result as string);
      reader.readAsDataURL(dropped);
    }
  }, []);

  return (
    <>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
              onClick={() => setOpen(true)}
            >
              <CameraIcon className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={8}>
            Extract profile from screenshot
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); else setOpen(true); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Extract Profile from Screenshot</DialogTitle>
            <DialogDescription>
              Upload a profile screenshot to extract profile info.
            </DialogDescription>
          </DialogHeader>

          {preview ? (
            <div className="relative rounded-lg overflow-hidden border bg-muted">
              <img src={preview} alt="Screenshot preview" className="w-full max-h-80 object-contain" />
            </div>
          ) : (
            <div
              className="flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed border-muted-foreground/25 py-10 cursor-pointer hover:border-muted-foreground/50 transition-colors"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleDrop}
            >
              <UploadIcon className="h-8 w-8 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                Drop an image here or click to select
              </p>
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleFileSelect}
          />

          <DialogFooter>
            <Button variant="outline" onClick={handleClose} disabled={extractMutation.isPending}>
              Cancel
            </Button>
            <Button
              onClick={() => file && extractMutation.mutate(file)}
              disabled={!file || extractMutation.isPending}
            >
              {extractMutation.isPending ? (
                <>
                  <Loader2Icon className="h-4 w-4 mr-1 animate-spin" />
                  Extracting...
                </>
              ) : (
                "Extract"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
