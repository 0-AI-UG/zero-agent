import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const CHIP_RE = /\[file: ([^\]]+)\]|\[Triggered by: ([^\]]+)\]/g;

export function renderWithFileChips(
  text: string,
  options?: { chipClassName?: string },
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const match of text.matchAll(CHIP_RE)) {
    const start = match.index ?? 0;
    if (start > last) nodes.push(text.slice(last, start));
    if (match[1] !== undefined) {
      const path = match[1];
      const name = path.split("/").pop() || path;
      nodes.push(
        <span
          key={`chip-${i++}`}
          title={path}
          className={cn(
            "inline-flex items-center gap-0.5 rounded bg-primary/10 text-primary px-1.5 py-px text-[13px] font-medium mx-0.5 align-baseline",
            options?.chipClassName,
          )}
        >
          {name}
        </span>,
      );
    } else {
      const label = match[2]!;
      nodes.push(
        <span
          key={`chip-${i++}`}
          className={cn(
            "inline-flex items-center gap-0.5 rounded bg-muted text-muted-foreground px-1.5 py-px text-[13px] font-medium mx-0.5 align-baseline",
            options?.chipClassName,
          )}
        >
          Triggered by {label}
        </span>,
      );
    }
    last = start + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
