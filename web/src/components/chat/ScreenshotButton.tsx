import { useRef } from "react";
import { ImageIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export interface ImageAttachment {
  file: File;
  dataUrl: string;
  mediaType: string;
}

interface ImageUploadButtonProps {
  attachment: ImageAttachment | null;
  onAttach: (attachment: ImageAttachment) => void;
  onRemove: () => void;
}

export function ImageUploadButton({ attachment, onAttach, onRemove }: ImageUploadButtonProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (!selected) return;
    const reader = new FileReader();
    reader.onload = () => {
      onAttach({
        file: selected,
        dataUrl: reader.result as string,
        mediaType: selected.type || "image/png",
      });
    };
    reader.readAsDataURL(selected);
    e.target.value = "";
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={`h-7 w-7 px-0 ${attachment ? "text-primary" : "text-muted-foreground hover:text-foreground"}`}
            onClick={() => attachment ? onRemove() : fileInputRef.current?.click()}
          >
            {attachment ? <XIcon className="h-4 w-4" /> : <ImageIcon className="h-4 w-4" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={8}>
          {attachment ? "Remove image" : "Attach image"}
        </TooltipContent>
      </Tooltip>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileSelect}
      />
    </>
  );
}
