"use client"

import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
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
      dismissible
      gap={8}
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
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
          success: "!border-l-4 !border-l-emerald-500",
          error: "!border-l-4 !border-l-red-500",
          warning: "!border-l-4 !border-l-amber-500",
          info: "!border-l-4 !border-l-blue-500",
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
