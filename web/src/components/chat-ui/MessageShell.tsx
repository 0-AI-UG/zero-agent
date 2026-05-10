import type { ComponentProps, HTMLAttributes, ReactNode } from "react";
import { Button } from "@/components/ui/button";

type Role = "user" | "assistant" | "toolResult" | "system";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Message bubble shell. Role drives alignment + styling.
 * Matches the div tree the previous Message+MessageContent pair produced.
 */
export function MessageShell({
  role,
  children,
  className,
  contentClassName,
  header,
}: {
  role: Role;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  header?: ReactNode;
}) {
  const isUser = role === "user";
  return (
    <div
      className={cn(
        "relative flex w-full max-w-[95%] flex-col gap-2",
        isUser ? "is-user ml-auto justify-end" : "is-assistant",
        className,
      )}
    >
      {header}
      <div
        className={cn(
          "is-user:dark flex max-w-full min-w-0 flex-col gap-2 overflow-hidden text-sm",
          isUser
            ? "w-fit ml-auto rounded-lg bg-secondary px-4 py-3 text-foreground"
            : "w-full text-foreground",
          contentClassName,
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function MessageActionButton({
  tooltip,
  children,
  className,
  ...props
}: ComponentProps<typeof Button> & { tooltip?: string }) {
  const button = (
    <Button
      className={cn("text-muted-foreground/40 hover:text-muted-foreground", className)}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children}
      {tooltip && <span className="sr-only">{tooltip}</span>}
    </Button>
  );
  if (!tooltip) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent>
        <p>{tooltip}</p>
      </TooltipContent>
    </Tooltip>
  );
}

export const MessageActionRow = ({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex items-center gap-1", className)} {...props} />
);
