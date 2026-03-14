import {
  ImageIcon,
  FileTextIcon,
  FileCodeIcon,
  BookOpenIcon,
  FileIcon,
  TableIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface FileTypeIconProps {
  mimeType: string;
  filename?: string;
  className?: string;
}

export function FileTypeIcon({ mimeType, filename, className }: FileTypeIconProps) {
  const cls = cn("h-5 w-5 text-muted-foreground", className);

  if (mimeType.startsWith("image/")) {
    return <ImageIcon className={cls} />;
  }
  if (mimeType === "text/markdown") {
    return <BookOpenIcon className={cls} />;
  }
  if (mimeType === "text/csv") {
    return <TableIcon className={cls} />;
  }
  if (filename?.endsWith(".py") || mimeType === "text/x-python") {
    return <FileCodeIcon className={cls} />;
  }
  if (mimeType.startsWith("text/") || mimeType === "application/json") {
    return <FileTextIcon className={cls} />;
  }
  return <FileIcon className={cls} />;
}
