import { ExternalLinkIcon, NetworkIcon } from "lucide-react";

interface ForwardPortInput {
  port?: number;
  label?: string;
}
interface ForwardPortOutput {
  url?: string;
  error?: string;
  port?: number;
}

export function ForwardPortCard({
  input,
  output,
}: {
  input: ForwardPortInput;
  output: ForwardPortOutput;
}) {
  const port = input?.port ?? output?.port;
  const label = input?.label ?? `Port ${port}`;

  if (output.error) {
    return (
      <div className="rounded-lg border border-destructive/50 bg-card p-3 max-w-md">
        <div className="flex items-center gap-1.5 text-xs text-destructive mb-1">
          <NetworkIcon className="size-3" />
          <span>Failed to forward port {port}</span>
        </div>
        <p className="text-xs text-muted-foreground">{output.error}</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-3 max-w-md">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1">
        <NetworkIcon className="size-3" />
        <span>Port forwarded</span>
      </div>
      <p className="text-sm font-medium">{label}</p>
      {output.url && (
        <a
          href={output.url}
          target="_blank"
          rel="noopener"
          className="text-xs text-primary hover:underline inline-flex items-center gap-1 mt-1"
        >
          {output.url}
          <ExternalLinkIcon className="size-3 opacity-50 shrink-0" />
        </a>
      )}
    </div>
  );
}
