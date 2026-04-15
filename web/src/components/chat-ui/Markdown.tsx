import { memo, type ComponentProps } from "react";
import { Streamdown } from "streamdown";
import { cn } from "@/lib/utils";

export type MarkdownProps = ComponentProps<typeof Streamdown>;

export const Markdown = memo(
  function Markdown({ className, ...props }: MarkdownProps) {
    return (
      <Streamdown
        className={cn("size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", className)}
        {...props}
      />
    );
  },
  (prev, next) => prev.children === next.children,
);
