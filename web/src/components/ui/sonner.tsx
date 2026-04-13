"use client"

import { Loader2Icon } from "lucide-react"
import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      position="top-right"
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      closeButton
      // @ts-expect-error dismissible exists at runtime but missing from types
      dismissible
      gap={8}
      icons={{
        success: <></>,
        info: <></>,
        warning: <></>,
        error: <></>,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      toastOptions={{
        classNames: {
          toast:
            "!bg-popover !text-popover-foreground !border-border/60 !shadow-lg !shadow-black/10 !rounded-xl",
          title: "!text-sm !font-semibold",
          description: "!text-[13px] !text-muted-foreground !leading-relaxed",
          closeButton:
            "!bg-popover !border-border/60 !text-muted-foreground/60 hover:!text-foreground hover:!bg-muted !rounded-md",
          success: "",
          error: "",
          warning: "",
          info: "",
        },
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "0.75rem",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
