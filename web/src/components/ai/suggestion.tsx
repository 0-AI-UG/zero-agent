
import type { ComponentProps, ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

export type SuggestionsProps = ComponentProps<typeof ScrollArea>

export const Suggestions = ({ className, children, ...props }: SuggestionsProps) => (
  <ScrollArea className="w-full overflow-x-auto whitespace-nowrap" {...props}>
    <div className={cn("flex flex-nowrap items-center gap-2", className)}>{children}</div>
    <ScrollBar className="hidden" orientation="horizontal" />
  </ScrollArea>
)

export type SuggestionProps = Omit<ComponentProps<typeof Button>, "onClick"> & {
  suggestion: string
  icon?: ReactNode
  description?: string
  onClick?: (suggestion: string) => void
}

export const Suggestion = ({
  suggestion,
  icon,
  description,
  onClick,
  className,
  variant = "outline",
  size = "sm",
  children,
  ...props
}: SuggestionProps) => {
  const handleClick = () => {
    onClick?.(suggestion)
  }

  if (icon || description) {
    return (
      <Button
        className={cn(
          "cursor-pointer rounded-xl px-4 py-3 h-auto text-left grid gap-0.5 overflow-hidden",
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
          <span className="text-[10px] text-muted-foreground font-normal truncate">{description}</span>
        )}
      </Button>
    )
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
  )
}
