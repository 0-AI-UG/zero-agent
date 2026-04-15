import type { ComponentProps, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Props = Omit<ComponentProps<typeof Button>, "onClick"> & {
  suggestion: string;
  icon?: ReactNode;
  description?: string;
  onClick?: (suggestion: string) => void;
};

export function Suggestion({
  suggestion,
  icon,
  description,
  onClick,
  className,
  variant = "outline",
  size = "sm",
  children,
  ...props
}: Props) {
  const handleClick = () => onClick?.(suggestion);

  if (icon || description) {
    return (
      <Button
        className={cn(
          "cursor-pointer rounded-xl px-4 py-3 h-auto grid gap-0.5 overflow-hidden items-start justify-start whitespace-normal text-left",
          className,
        )}
        onClick={handleClick}
        size={size}
        type="button"
        variant={variant}
        {...props}
      >
        {icon && <span className="text-muted-foreground mb-0.5">{icon}</span>}
        <span className="text-xs font-medium truncate">{children || suggestion}</span>
        {description && (
          <span className="text-[10px] text-muted-foreground font-normal truncate">
            {description}
          </span>
        )}
      </Button>
    );
  }

  return (
    <Button
      className={cn("cursor-pointer rounded-full px-4", className)}
      onClick={handleClick}
      size={size}
      type="button"
      variant={variant}
      {...props}
    >
      {children || suggestion}
    </Button>
  );
}
