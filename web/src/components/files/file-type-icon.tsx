import {
  ImageIcon,
  FileTextIcon,
  FileCodeIcon,
  BookOpenIcon,
  FileIcon,
  TableIcon,
  GlobeIcon,
  BracesIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface FileTypeIconProps {
  mimeType: string;
  filename?: string;
  className?: string;
}

interface FileTypeInfo {
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  extension: string;
}

export function getFileTypeInfo(mimeType: string, filename?: string): FileTypeInfo {
  if (mimeType.startsWith("image/")) {
    const ext = filename?.split(".").pop() ?? "img";
    return { icon: ImageIcon, color: "text-pink-500", extension: ext.toUpperCase() };
  }
  if (mimeType === "text/markdown" || filename?.endsWith(".md")) {
    return { icon: BookOpenIcon, color: "text-blue-500", extension: "MD" };
  }
  if (mimeType === "text/csv" || filename?.endsWith(".csv")) {
    return { icon: TableIcon, color: "text-green-500", extension: "CSV" };
  }
  if (filename?.endsWith(".py") || mimeType === "text/x-python") {
    return { icon: FileCodeIcon, color: "text-yellow-500", extension: "PY" };
  }
  if (mimeType === "text/html" || filename?.endsWith(".html")) {
    return { icon: GlobeIcon, color: "text-violet-500", extension: "HTML" };
  }
  if (mimeType === "application/json" || filename?.endsWith(".json")) {
    return { icon: BracesIcon, color: "text-orange-500", extension: "JSON" };
  }
  if (mimeType.startsWith("text/") || filename?.endsWith(".txt")) {
    return { icon: FileTextIcon, color: "text-muted-foreground", extension: "TXT" };
  }
  const ext = filename?.split(".").pop()?.toUpperCase() ?? "";
  return { icon: FileIcon, color: "text-muted-foreground", extension: ext };
}

export function FileTypeIcon({ mimeType, filename, className }: FileTypeIconProps) {
  const { icon: Icon, color } = getFileTypeInfo(mimeType, filename);
  return <Icon className={cn("h-5 w-5", color, className)} />;
}
