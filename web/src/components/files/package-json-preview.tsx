import { useEffect } from "react";
import { CopyIcon, PlayIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { usePreviewActions } from "./preview-actions-context";
import { CodePreview } from "./code-preview";
import type { FileItem } from "@/hooks/use-files";

interface PackageJson {
  name?: string;
  version?: string;
  description?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface PackageJsonPreviewProps {
  file: FileItem;
  content: string;
  projectId: string;
}

export function PackageJsonPreview({ file, content, projectId }: PackageJsonPreviewProps) {
  let parsed: PackageJson;
  try {
    parsed = JSON.parse(content);
  } catch {
    return <CodePreview file={file} content={content} projectId={projectId} />;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return <CodePreview file={file} content={content} projectId={projectId} />;
  }

  return <PackageJsonStructured file={file} content={content} parsed={parsed} projectId={projectId} />;
}

function PackageJsonStructured({
  file,
  content,
  parsed,
  projectId,
}: {
  file: FileItem;
  content: string;
  parsed: PackageJson;
  projectId: string;
}) {
  const { setActions } = usePreviewActions();

  useEffect(() => {
    setActions(
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => {
          navigator.clipboard.writeText(content).then(() => {
            toast.success("Copied to clipboard");
          });
        }}
      >
        <CopyIcon className="h-4 w-4" />
      </Button>
    );
    return () => setActions(null);
  }, [content]);

  return (
    <div className="p-4 space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold">
          {parsed.name ?? "unnamed"}
          {parsed.version && (
            <span className="text-muted-foreground font-normal ml-2">v{parsed.version}</span>
          )}
        </h2>
        {parsed.description && (
          <p className="text-sm text-muted-foreground mt-1">{parsed.description}</p>
        )}
      </div>

      {/* Scripts */}
      {parsed.scripts && Object.keys(parsed.scripts).length > 0 && (
        <Section title="Scripts">
          <div className="space-y-1">
            {Object.entries(parsed.scripts).map(([name, command]) => (
              <div key={name} className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-mono">
                <PlayIcon className="h-3.5 w-3.5 text-green-500 shrink-0" />
                <span className="font-medium">{name}</span>
                <span className="text-muted-foreground truncate">{command}</span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Dependencies */}
      {parsed.dependencies && Object.keys(parsed.dependencies).length > 0 && (
        <Section title="Dependencies">
          <DepsTable deps={parsed.dependencies} />
        </Section>
      )}

      {/* Dev Dependencies */}
      {parsed.devDependencies && Object.keys(parsed.devDependencies).length > 0 && (
        <Section title="Dev Dependencies">
          <DepsTable deps={parsed.devDependencies} />
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-sm font-medium text-muted-foreground mb-2">{title}</h3>
      {children}
    </div>
  );
}

function DepsTable({ deps }: { deps: Record<string, string> }) {
  return (
    <div className="rounded-md border overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50">
            <th className="text-left px-3 py-1.5 font-medium">Package</th>
            <th className="text-left px-3 py-1.5 font-medium">Version</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(deps).map(([pkg, version]) => (
            <tr key={pkg} className="border-b last:border-b-0">
              <td className="px-3 py-1.5 font-mono">{pkg}</td>
              <td className="px-3 py-1.5 font-mono text-muted-foreground">{version}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
