import {
  ImageIcon,
  FileTextIcon,
  FileCodeIcon,
  BookOpenIcon,
  FileIcon,
  TableIcon,
  GlobeIcon,
  BracesIcon,
  BarChart3Icon,
  PackageIcon,
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
  if (filename?.endsWith(".xlsx") || filename?.endsWith(".xls") || mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" || mimeType === "application/vnd.ms-excel") {
    return { icon: TableIcon, color: "text-emerald-500", extension: filename?.endsWith(".xls") ? "XLS" : "XLSX" };
  }
  if (filename?.endsWith(".py") || mimeType === "text/x-python") {
    return { icon: FileCodeIcon, color: "text-yellow-500", extension: "PY" };
  }
  if (filename?.endsWith(".js") || filename?.endsWith(".mjs") || filename?.endsWith(".cjs") || mimeType === "application/javascript") {
    return { icon: FileCodeIcon, color: "text-yellow-400", extension: "JS" };
  }
  if (filename?.endsWith(".ts") || mimeType === "application/typescript") {
    return { icon: FileCodeIcon, color: "text-blue-400", extension: "TS" };
  }
  if (filename?.endsWith(".jsx")) {
    return { icon: FileCodeIcon, color: "text-cyan-500", extension: "JSX" };
  }
  if (filename?.endsWith(".tsx")) {
    return { icon: FileCodeIcon, color: "text-cyan-400", extension: "TSX" };
  }
  if (filename?.endsWith(".css") || filename?.endsWith(".scss") || filename?.endsWith(".less")) {
    const ext = filename?.split(".").pop()?.toUpperCase() ?? "CSS";
    return { icon: FileCodeIcon, color: "text-purple-500", extension: ext };
  }
  if (filename?.endsWith(".rs")) {
    return { icon: FileCodeIcon, color: "text-orange-600", extension: "RS" };
  }
  if (filename?.endsWith(".go")) {
    return { icon: FileCodeIcon, color: "text-cyan-600", extension: "GO" };
  }
  if (filename?.endsWith(".java")) {
    return { icon: FileCodeIcon, color: "text-red-500", extension: "JAVA" };
  }
  if (filename?.endsWith(".c") || filename?.endsWith(".h") || filename?.endsWith(".cpp") || filename?.endsWith(".hpp") || filename?.endsWith(".cc")) {
    const ext = filename?.split(".").pop()?.toUpperCase() ?? "C";
    return { icon: FileCodeIcon, color: "text-blue-600", extension: ext };
  }
  if (filename?.endsWith(".php")) {
    return { icon: FileCodeIcon, color: "text-indigo-500", extension: "PHP" };
  }
  if (filename?.endsWith(".rb")) {
    return { icon: FileCodeIcon, color: "text-red-400", extension: "RB" };
  }
  if (filename?.endsWith(".swift")) {
    return { icon: FileCodeIcon, color: "text-orange-500", extension: "SWIFT" };
  }
  if (filename?.endsWith(".sh") || filename?.endsWith(".bash") || filename?.endsWith(".zsh") || mimeType === "application/x-sh") {
    const ext = filename?.split(".").pop()?.toUpperCase() ?? "SH";
    return { icon: FileCodeIcon, color: "text-green-600", extension: ext };
  }
  if (filename?.endsWith(".yaml") || filename?.endsWith(".yml")) {
    return { icon: FileCodeIcon, color: "text-red-300", extension: "YAML" };
  }
  if (filename?.endsWith(".toml")) {
    return { icon: FileCodeIcon, color: "text-gray-500", extension: "TOML" };
  }
  if (filename?.endsWith(".sql")) {
    return { icon: FileCodeIcon, color: "text-blue-500", extension: "SQL" };
  }
  if (filename?.endsWith(".xml") || filename?.endsWith(".svg")) {
    const ext = filename?.split(".").pop()?.toUpperCase() ?? "XML";
    return { icon: FileCodeIcon, color: "text-orange-400", extension: ext };
  }
  if (mimeType === "text/html+viz" || filename?.endsWith(".viz")) {
    return { icon: BarChart3Icon, color: "text-emerald-500", extension: "VIZ" };
  }
  if (mimeType === "text/html" || filename?.endsWith(".html")) {
    return { icon: GlobeIcon, color: "text-violet-500", extension: "HTML" };
  }
  if (filename === "package.json") {
    return { icon: PackageIcon, color: "text-green-500", extension: "PKG" };
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
