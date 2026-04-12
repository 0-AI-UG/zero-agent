import type { LanguageModelUsage } from "ai"
import { type ComponentProps, createContext, useContext } from "react"
import { AlertTriangleIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { getModelsCache } from "@/stores/model"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { Progress } from "@/components/ui/progress"
import { cn } from "@/lib/utils"

const WARNING_THRESHOLD = 0.6
const CRITICAL_THRESHOLD = 0.8

function getContextColor(usedPercent: number): string {
  if (usedPercent >= CRITICAL_THRESHOLD) return "text-destructive"
  if (usedPercent >= WARNING_THRESHOLD) return "text-amber-500"
  return ""
}

function getProgressIndicatorColor(usedPercent: number): string {
  if (usedPercent >= CRITICAL_THRESHOLD) return "bg-destructive"
  if (usedPercent >= WARNING_THRESHOLD) return "bg-amber-500"
  return ""
}

/** Calculate cost in USD using pricing from models.json (per 1M tokens) */
function calcCost(
  modelId: string | undefined,
  tokens: { input?: number; output?: number; reasoning?: number; cache?: number },
): number | undefined {
  if (!modelId) return undefined
  const model = getModelsCache().find((m) => m.id === modelId)
  if (!model) return undefined
  const { input: inputPrice, output: outputPrice } = model.pricing
  const inputCost = ((tokens.input ?? 0) + (tokens.cache ?? 0)) * (inputPrice / 1_000_000)
  const outputCost = ((tokens.output ?? 0) + (tokens.reasoning ?? 0)) * (outputPrice / 1_000_000)
  return inputCost + outputCost
}

const PERCENT_MAX = 100
const ICON_RADIUS = 10
const ICON_VIEWBOX = 24
const ICON_CENTER = 12
const ICON_STROKE_WIDTH = 2

type ModelId = string

interface ContextSchema {
  usedTokens: number
  maxTokens: number
  /** Cumulative usage across all messages - for breakdown display and cost */
  usage?: LanguageModelUsage
  modelId?: ModelId
}

const ContextContext = createContext<ContextSchema | null>(null)

const useContextValue = () => {
  const context = useContext(ContextContext)

  if (!context) {
    throw new Error("Context components must be used within Context")
  }

  return context
}

export type ContextProps = ComponentProps<typeof HoverCard> & ContextSchema

export const Context = ({ usedTokens, maxTokens, usage, modelId, ...props }: ContextProps) => (
  <ContextContext.Provider
    value={{
      usedTokens,
      maxTokens,
      usage,
      modelId,
    }}
  >
    <HoverCard closeDelay={0} openDelay={0} {...props} />
  </ContextContext.Provider>
)

const ContextIcon = () => {
  const { usedTokens, maxTokens } = useContextValue()
  const usedPercent = usedTokens / maxTokens
  const colorClass = getContextColor(usedPercent)

  if (usedPercent >= CRITICAL_THRESHOLD) {
    return <AlertTriangleIcon className={cn("size-4", colorClass)} />
  }

  const circumference = 2 * Math.PI * ICON_RADIUS
  const dashOffset = circumference * (1 - usedPercent)

  return (
    <svg
      aria-label="Model context usage"
      className={colorClass}
      height="20"
      role="img"
      style={{ color: "currentcolor" }}
      viewBox={`0 0 ${ICON_VIEWBOX} ${ICON_VIEWBOX}`}
      width="20"
    >
      <circle
        cx={ICON_CENTER}
        cy={ICON_CENTER}
        fill="none"
        opacity="0.25"
        r={ICON_RADIUS}
        stroke="currentColor"
        strokeWidth={ICON_STROKE_WIDTH}
      />
      <circle
        cx={ICON_CENTER}
        cy={ICON_CENTER}
        fill="none"
        opacity="0.7"
        r={ICON_RADIUS}
        stroke="currentColor"
        strokeDasharray={`${circumference} ${circumference}`}
        strokeDashoffset={dashOffset}
        strokeLinecap="round"
        strokeWidth={ICON_STROKE_WIDTH}
        style={{ transformOrigin: "center", transform: "rotate(-90deg)" }}
      />
    </svg>
  )
}

export type ContextTriggerProps = ComponentProps<typeof Button>

export const ContextTrigger = ({ children, ...props }: ContextTriggerProps) => {
  const { usedTokens, maxTokens } = useContextValue()
  const usedPercent = usedTokens / maxTokens
  const colorClass = getContextColor(usedPercent)
  const renderedPercent = new Intl.NumberFormat("en-US", {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(usedPercent)

  return (
    <HoverCardTrigger asChild>
      {children ?? (
        <Button type="button" variant="ghost" {...props}>
          <span className={cn("font-medium", colorClass || "text-muted-foreground")}>{renderedPercent}</span>
          <ContextIcon />
        </Button>
      )}
    </HoverCardTrigger>
  )
}

export type ContextContentProps = ComponentProps<typeof HoverCardContent>

export const ContextContent = ({ className, ...props }: ContextContentProps) => (
  <HoverCardContent className={cn("min-w-60 divide-y overflow-hidden p-0", className)} {...props} />
)

export type ContextContentHeaderProps = ComponentProps<"div">

export const ContextContentHeader = ({
  children,
  className,
  ...props
}: ContextContentHeaderProps) => {
  const { usedTokens, maxTokens } = useContextValue()
  const usedPercent = usedTokens / maxTokens
  const displayPct = new Intl.NumberFormat("en-US", {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(usedPercent)
  const used = new Intl.NumberFormat("en-US", {
    notation: "compact",
  }).format(usedTokens)
  const total = new Intl.NumberFormat("en-US", {
    notation: "compact",
  }).format(maxTokens)

  const colorClass = getContextColor(usedPercent)

  return (
    <div className={cn("w-full space-y-2 p-3", className)} {...props}>
      {children ?? (
        <>
          <div className="flex items-center justify-between gap-3 text-xs">
            <p className={cn("text-muted-foreground", colorClass)}>Context window</p>
            <p className="font-mono text-muted-foreground">
              {used} / {total}
            </p>
          </div>
          <div className="space-y-2">
            <ContextProgress value={usedPercent * PERCENT_MAX} usedPercent={usedPercent} />
          </div>
        </>
      )}
    </div>
  )
}

const ContextProgress = ({ value, usedPercent }: { value: number; usedPercent: number }) => {
  const indicatorColor = getProgressIndicatorColor(usedPercent)
  if (!indicatorColor) {
    return <Progress className="bg-muted" value={value} />
  }
  return (
    <Progress
      className={cn("bg-muted", indicatorColor === "bg-destructive" && "[&_[data-slot=progress-indicator]]:bg-destructive", indicatorColor === "bg-amber-500" && "[&_[data-slot=progress-indicator]]:bg-amber-500")}
      value={value}
    />
  )
}

export type ContextContentBodyProps = ComponentProps<"div">

export const ContextContentBody = ({ children, className, ...props }: ContextContentBodyProps) => (
  <div className={cn("w-full p-3", className)} {...props}>
    {children}
  </div>
)

export type ContextContentFooterProps = ComponentProps<"div">

export const ContextContentFooter = ({
  children,
  className,
  ...props
}: ContextContentFooterProps) => {
  const { modelId, usage } = useContextValue()
  const costUSD = calcCost(modelId, {
    input: usage?.inputTokens ?? 0,
    output: usage?.outputTokens ?? 0,
    reasoning: usage?.reasoningTokens ?? 0,
    cache: usage?.cachedInputTokens ?? 0,
  })
  const totalCost = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(costUSD ?? 0)

  return (
    <div
      className={cn(
        "flex w-full items-center justify-between gap-3 bg-secondary p-3 text-xs",
        className,
      )}
      {...props}
    >
      {children ?? (
        <>
          <span className="text-muted-foreground">Total cost</span>
          <span>{totalCost}</span>
        </>
      )}
    </div>
  )
}

export type ContextUsageSectionLabelProps = ComponentProps<"p">

export const ContextUsageSectionLabel = ({ className, children, ...props }: ContextUsageSectionLabelProps) => (
  <p className={cn("text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70", className)} {...props}>
    {children}
  </p>
)

export type ContextInputUsageProps = ComponentProps<"div">

export const ContextInputUsage = ({ className, children, ...props }: ContextInputUsageProps) => {
  const { usage, modelId } = useContextValue()
  const inputTokens = usage?.inputTokens ?? 0

  if (children) {
    return children
  }

  if (!inputTokens) {
    return null
  }

  const inputCost = calcCost(modelId, { input: inputTokens })
  const inputCostText = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(inputCost ?? 0)

  return (
    <div className={cn("flex items-center justify-between text-xs", className)} {...props}>
      <span className="text-muted-foreground">Input</span>
      <TokensWithCost costText={inputCostText} tokens={inputTokens} />
    </div>
  )
}

export type ContextOutputUsageProps = ComponentProps<"div">

export const ContextOutputUsage = ({ className, children, ...props }: ContextOutputUsageProps) => {
  const { usage, modelId } = useContextValue()
  const outputTokens = usage?.outputTokens ?? 0

  if (children) {
    return children
  }

  if (!outputTokens) {
    return null
  }

  const outputCost = calcCost(modelId, { output: outputTokens })
  const outputCostText = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(outputCost ?? 0)

  return (
    <div className={cn("flex items-center justify-between text-xs", className)} {...props}>
      <span className="text-muted-foreground">Output</span>
      <TokensWithCost costText={outputCostText} tokens={outputTokens} />
    </div>
  )
}

export type ContextReasoningUsageProps = ComponentProps<"div">

export const ContextReasoningUsage = ({
  className,
  children,
  ...props
}: ContextReasoningUsageProps) => {
  const { usage, modelId } = useContextValue()
  const reasoningTokens = usage?.reasoningTokens ?? 0

  if (children) {
    return children
  }

  if (!reasoningTokens) {
    return null
  }

  const reasoningCost = calcCost(modelId, { reasoning: reasoningTokens })
  const reasoningCostText = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(reasoningCost ?? 0)

  return (
    <div className={cn("flex items-center justify-between text-xs", className)} {...props}>
      <span className="text-muted-foreground">Reasoning</span>
      <TokensWithCost costText={reasoningCostText} tokens={reasoningTokens} />
    </div>
  )
}

export type ContextCacheUsageProps = ComponentProps<"div">

export const ContextCacheUsage = ({ className, children, ...props }: ContextCacheUsageProps) => {
  const { usage, modelId } = useContextValue()
  const cacheTokens = usage?.cachedInputTokens ?? 0

  if (children) {
    return children
  }

  if (!cacheTokens) {
    return null
  }

  const cacheCost = calcCost(modelId, { cache: cacheTokens })
  const cacheCostText = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cacheCost ?? 0)

  return (
    <div className={cn("flex items-center justify-between text-xs", className)} {...props}>
      <span className="text-muted-foreground">Cache</span>
      <TokensWithCost costText={cacheCostText} tokens={cacheTokens} />
    </div>
  )
}

const TokensWithCost = ({ tokens, costText }: { tokens?: number; costText?: string }) => (
  <span>
    {tokens === undefined
      ? "-"
      : new Intl.NumberFormat("en-US", {
          notation: "compact",
        }).format(tokens)}
    {costText ? <span className="ml-2 text-muted-foreground">• {costText}</span> : null}
  </span>
)
