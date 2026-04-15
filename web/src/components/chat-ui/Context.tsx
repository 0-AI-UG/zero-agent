import type { MessageUsage } from "@/lib/messages";
import { AlertTriangleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Progress } from "@/components/ui/progress";
import { getModelsCache } from "@/stores/model";
import { cn } from "@/lib/utils";

const WARN = 0.6;
const CRIT = 0.8;

function color(pct: number) {
  if (pct >= CRIT) return "text-destructive";
  if (pct >= WARN) return "text-amber-500";
  return "";
}

function indicator(pct: number) {
  if (pct >= CRIT) return "[&_[data-slot=progress-indicator]]:bg-destructive";
  if (pct >= WARN) return "[&_[data-slot=progress-indicator]]:bg-amber-500";
  return "";
}

function calcCost(
  modelId: string | undefined,
  t: { input?: number; output?: number; reasoning?: number; cache?: number },
): number | undefined {
  if (!modelId) return undefined;
  const m = getModelsCache().find((x) => x.id === modelId);
  if (!m) return undefined;
  const { input: inP, output: outP } = m.pricing;
  const inCost = ((t.input ?? 0) + (t.cache ?? 0)) * (inP / 1_000_000);
  const outCost = ((t.output ?? 0) + (t.reasoning ?? 0)) * (outP / 1_000_000);
  return inCost + outCost;
}

const pct = (n: number) =>
  new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 }).format(n);
const compact = (n: number) => new Intl.NumberFormat("en-US", { notation: "compact" }).format(n);
const usd = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);

function UsageRow({
  label,
  tokens,
  cost,
}: {
  label: string;
  tokens: number;
  cost: number | undefined;
}) {
  if (!tokens) return null;
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span>
        {compact(tokens)}
        {cost !== undefined && <span className="ml-2 text-muted-foreground">• {usd(cost)}</span>}
      </span>
    </div>
  );
}

function Ring({ pctUsed }: { pctUsed: number }) {
  const R = 10;
  const CIRC = 2 * Math.PI * R;
  if (pctUsed >= CRIT) return <AlertTriangleIcon className={cn("size-4", color(pctUsed))} />;
  return (
    <svg
      aria-label="Model context usage"
      className={color(pctUsed)}
      height="20"
      role="img"
      viewBox="0 0 24 24"
      width="20"
    >
      <circle cx={12} cy={12} fill="none" opacity="0.25" r={R} stroke="currentColor" strokeWidth={2} />
      <circle
        cx={12}
        cy={12}
        fill="none"
        opacity="0.7"
        r={R}
        stroke="currentColor"
        strokeDasharray={`${CIRC} ${CIRC}`}
        strokeDashoffset={CIRC * (1 - pctUsed)}
        strokeLinecap="round"
        strokeWidth={2}
        style={{ transformOrigin: "center", transform: "rotate(-90deg)" }}
      />
    </svg>
  );
}

export function Context({
  usedTokens,
  maxTokens,
  usage,
  modelId,
}: {
  usedTokens: number;
  maxTokens: number;
  usage?: MessageUsage;
  modelId?: string;
}) {
  const pctUsed = usedTokens / maxTokens;
  const c = color(pctUsed);
  const totalCost = calcCost(modelId, {
    input: usage?.inputTokens ?? 0,
    output: usage?.outputTokens ?? 0,
    reasoning: usage?.reasoningTokens ?? 0,
    cache: usage?.cachedInputTokens ?? 0,
  });

  return (
    <HoverCard closeDelay={0} openDelay={0}>
      <HoverCardTrigger asChild>
        <Button type="button" variant="ghost">
          <span className={cn("font-medium", c || "text-muted-foreground")}>{pct(pctUsed)}</span>
          <Ring pctUsed={pctUsed} />
        </Button>
      </HoverCardTrigger>
      <HoverCardContent className="min-w-60 divide-y overflow-hidden p-0">
        <div className="w-full space-y-2 p-3">
          <div className="flex items-center justify-between gap-3 text-xs">
            <p className={cn("text-muted-foreground", c)}>Context window</p>
            <p className="font-mono text-muted-foreground">
              {compact(usedTokens)} / {compact(maxTokens)}
            </p>
          </div>
          <Progress className={cn("bg-muted", indicator(pctUsed))} value={pctUsed * 100} />
        </div>
        <div className="w-full p-3 space-y-1.5">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
            Billed tokens
          </p>
          <UsageRow
            label="Input"
            tokens={usage?.inputTokens ?? 0}
            cost={calcCost(modelId, { input: usage?.inputTokens ?? 0 })}
          />
          <UsageRow
            label="Output"
            tokens={usage?.outputTokens ?? 0}
            cost={calcCost(modelId, { output: usage?.outputTokens ?? 0 })}
          />
          <UsageRow
            label="Reasoning"
            tokens={usage?.reasoningTokens ?? 0}
            cost={calcCost(modelId, { reasoning: usage?.reasoningTokens ?? 0 })}
          />
          <UsageRow
            label="Cache"
            tokens={usage?.cachedInputTokens ?? 0}
            cost={calcCost(modelId, { cache: usage?.cachedInputTokens ?? 0 })}
          />
        </div>
        <div className="flex w-full items-center justify-between gap-3 bg-secondary p-3 text-xs">
          <span className="text-muted-foreground">Total cost</span>
          <span>{usd(totalCost ?? 0)}</span>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
