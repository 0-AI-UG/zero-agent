import { useParams } from "react-router";
import { useLeadsStore } from "@/stores/leads-store";
import { useLeads, useUpdateLead, useDeleteLead } from "@/api/leads";
import type { Lead, LeadStatus } from "@/api/leads";
import { LeadDetail } from "@/components/leads/LeadDetail";
import { useIsMobile } from "@/hooks/use-mobile";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { CalendarIcon, Trash2Icon, UsersIcon } from "lucide-react";
import { EmptyLeadsIllustration } from "@/components/ui/illustrations";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";

const STATUS_TABS: { value: string; label: string }[] = [
  { value: "all", label: "All" },
  { value: "new", label: "New" },
  { value: "contacted", label: "Contacted" },
  { value: "replied", label: "Replied" },
  { value: "converted", label: "Converted" },
  { value: "dropped", label: "Dropped" },
];

const STATUS_DOT: Record<LeadStatus, string> = {
  new: "bg-blue-500",
  contacted: "bg-amber-500",
  replied: "bg-purple-500",
  converted: "bg-emerald-500",
  dropped: "bg-zinc-400",
};

const STATUS_BADGE: Record<LeadStatus, string> = {
  new: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-300 dark:border-blue-800",
  contacted:
    "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800",
  replied:
    "bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950 dark:text-purple-300 dark:border-purple-800",
  converted:
    "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800",
  dropped:
    "bg-zinc-50 text-zinc-600 border-zinc-200 dark:bg-zinc-900 dark:text-zinc-400 dark:border-zinc-700",
};

const PIPELINE_ORDER: LeadStatus[] = ["new", "contacted", "replied", "converted", "dropped"];

function isOverdue(lead: Lead): boolean {
  if (!lead.followUpDate) return false;
  if (lead.status === "converted" || lead.status === "dropped") return false;
  return new Date(lead.followUpDate).getTime() < Date.now();
}

function PipelineBar({ leads }: { leads: Lead[] }) {
  const counts = leads.reduce(
    (acc, l) => {
      acc[l.status] = (acc[l.status] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );

  const total = leads.length;
  if (total === 0) return null;

  return (
    <div className="space-y-2">
      <div className="flex h-2 w-full rounded-full overflow-hidden bg-muted">
        {PIPELINE_ORDER.map((status) => {
          const count = counts[status] || 0;
          if (count === 0) return null;
          return (
            <TooltipProvider key={status}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div
                    className={cn("h-full transition-all", STATUS_DOT[status])}
                    style={{ width: `${(count / total) * 100}%` }}
                  />
                </TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs capitalize">
                  {status}: {count}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          );
        })}
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        {PIPELINE_ORDER.map((status) => {
          const count = counts[status] || 0;
          if (count === 0) return null;
          return (
            <div key={status} className="flex items-center gap-1.5">
              <span className={cn("size-1.5 rounded-full", STATUS_DOT[status])} />
              <span className="text-[11px] text-muted-foreground">
                <span className="font-medium text-foreground tabular-nums">{count}</span>{" "}
                <span className="capitalize">{status}</span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LeadRow({
  lead,
  isSelected,
  isChecked,
  onToggleCheck,
  onClick,
}: {
  lead: Lead;
  isSelected: boolean;
  isChecked: boolean;
  onToggleCheck: () => void;
  onClick: () => void;
}) {
  const followUpTime = lead.followUpDate ? new Date(lead.followUpDate).getTime() : 0;
  const isUpcoming =
    lead.followUpDate &&
    followUpTime > Date.now() &&
    followUpTime - Date.now() < 3 * 86400000;
  const overdue = isOverdue(lead);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } }}
      className={cn(
        "w-full text-left px-4 py-3 transition-colors border-b last:border-b-0 cursor-pointer",
        overdue && "border-l-2 border-l-destructive bg-destructive/5",
        isSelected
          ? "bg-accent"
          : "hover:bg-muted/50"
      )}
    >
      <div className="flex items-start gap-3">
        {/* Checkbox */}
        <div className="mt-1" onClick={(e) => e.stopPropagation()}>
          <Checkbox
            checked={isChecked}
            onCheckedChange={onToggleCheck}
          />
        </div>
        {/* Status dot */}
        <span
          className={cn(
            "mt-1.5 size-2 shrink-0 rounded-full",
            STATUS_DOT[lead.status]
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium truncate">{lead.name}</p>
            <Badge
              variant="outline"
              className={cn(
                "shrink-0 text-[10px] font-medium capitalize border",
                STATUS_BADGE[lead.status]
              )}
            >
              {lead.status}
            </Badge>
          </div>
          {lead.source && (
            <p className="text-xs text-muted-foreground truncate mt-0.5">
              {lead.source}
            </p>
          )}
          <div className="flex items-center gap-3 mt-1.5 flex-wrap">
            {lead.score !== null && lead.score !== undefined && (
              <span
                className={cn(
                  "text-[10px] font-semibold tabular-nums",
                  lead.score >= 70
                    ? "text-emerald-600 dark:text-emerald-400"
                    : lead.score >= 40
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-zinc-500"
                )}
              >
                {lead.score}/100
              </span>
            )}
            {lead.priority === "high" && (
              <span className="text-[10px] font-semibold text-red-500 uppercase tracking-wide">
                High priority
              </span>
            )}
            {overdue && (
              <span className="text-[10px] font-semibold text-destructive uppercase tracking-wide">
                Overdue
              </span>
            )}
            <span className="text-[11px] text-muted-foreground">
              {formatDistanceToNow(new Date(lead.updatedAt), {
                addSuffix: true,
              })}
            </span>
            {lead.followUpDate && (
              <span
                className={cn(
                  "inline-flex items-center gap-1 text-[11px]",
                  overdue
                    ? "text-destructive font-medium"
                    : isUpcoming
                      ? "text-amber-600 dark:text-amber-400 font-medium"
                      : "text-muted-foreground"
                )}
              >
                <CalendarIcon className="size-3" />
                {new Date(lead.followUpDate).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                })}
              </span>
            )}
          </div>
          {lead.tags && (
            <div className="flex items-center gap-1 mt-1.5 flex-wrap">
              {lead.tags.split(",").filter(Boolean).map((tag) => (
                <span
                  key={tag.trim()}
                  className="inline-block rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
                >
                  {tag.trim()}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function LeadRowSkeleton() {
  return (
    <div className="px-4 py-3 border-b last:border-b-0">
      <div className="flex items-start gap-3">
        <Skeleton className="size-4 mt-1 rounded" />
        <Skeleton className="size-2 mt-1.5 rounded-full" />
        <div className="flex-1 space-y-2">
          <div className="flex items-center justify-between">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
          <Skeleton className="h-3 w-48" />
          <Skeleton className="h-3 w-24" />
        </div>
      </div>
    </div>
  );
}

function BatchActionBar({
  count,
  projectId,
  selectedIds,
  onClear,
}: {
  count: number;
  projectId: string;
  selectedIds: string[];
  onClear: () => void;
}) {
  const updateLead = useUpdateLead(projectId);
  const deleteLead = useDeleteLead(projectId);

  const handleBulkStatus = (newStatus: string) => {
    for (const id of selectedIds) {
      updateLead.mutate({ leadId: id, status: newStatus as LeadStatus });
    }
    onClear();
  };

  const handleBulkDelete = () => {
    for (const id of selectedIds) {
      deleteLead.mutate(id);
    }
    onClear();
  };

  return (
    <div className="absolute bottom-4 inset-x-3 z-10 flex items-center gap-2 bg-card border rounded-lg shadow-lg px-3 py-2">
      <span className="text-xs font-medium tabular-nums shrink-0">{count} sel.</span>
      <Select onValueChange={handleBulkStatus}>
        <SelectTrigger className="h-7 w-[120px] text-xs">
          <SelectValue placeholder="Status" />
        </SelectTrigger>
        <SelectContent>
          {STATUS_TABS.filter((t) => t.value !== "all").map((tab) => (
            <SelectItem key={tab.value} value={tab.value}>
              {tab.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button variant="destructive" size="sm" className="h-7 px-2 text-xs" onClick={handleBulkDelete}>
        <Trash2Icon className="size-3.5" />
      </Button>
      <Button variant="ghost" size="sm" className="h-7 px-2 text-xs ml-auto" onClick={onClear}>
        Cancel
      </Button>
    </div>
  );
}

export function LeadsPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const isMobile = useIsMobile();
  const {
    selectedLeadId,
    setSelectedLeadId,
    statusFilter,
    setStatusFilter,
    selectedIds,
    toggleSelected,
    clearSelection,
    selectAll,
  } = useLeadsStore();

  const {
    data: leads,
    isLoading,
    isError,
    refetch,
  } = useLeads(projectId!, statusFilter);

  // Also fetch all leads for summary counts (unfiltered)
  const { data: allLeads } = useLeads(projectId!);

  const selectedLead = selectedLeadId
    ? leads?.find((l) => l.id === selectedLeadId)
    : undefined;

  const activeFilter = statusFilter ?? "all";

  // Sort overdue leads to top
  const sortedLeads = leads
    ? [...leads].sort((a, b) => {
        const aOverdue = isOverdue(a) ? 0 : 1;
        const bOverdue = isOverdue(b) ? 0 : 1;
        return aOverdue - bOverdue;
      })
    : undefined;

  // Mobile: show detail full-screen when selected
  if (isMobile && selectedLead) {
    return (
      <LeadDetail
        key={selectedLead.id}
        lead={selectedLead}
        projectId={projectId!}
        onBack={() => setSelectedLeadId(null)}
      />
    );
  }

  return (
    <div className="flex h-full">
      {/* Lead list panel */}
      <div
        className="flex flex-col border-r w-[380px] shrink-0 relative"
      >
        {/* Header */}
        <div className="shrink-0 px-5 pt-5 pb-3 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold tracking-tight font-display">Leads</h2>
            {allLeads && allLeads.length > 0 && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {allLeads.length} total
              </span>
            )}
          </div>

          {/* Pipeline bar */}
          {allLeads && allLeads.length > 0 && <PipelineBar leads={allLeads} />}

          {/* Filter tabs */}
          <div className="flex gap-1 flex-wrap">
            {STATUS_TABS.map((tab) => (
              <button
                key={tab.value}
                onClick={() =>
                  setStatusFilter(
                    tab.value === "all" ? undefined : tab.value
                  )
                }
                className={cn(
                  "shrink-0 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  activeFilter === tab.value
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* List */}
        <div className="flex-1 min-h-0 overflow-y-auto scroll-shadow">
          {isLoading ? (
            <div>
              {Array.from({ length: 5 }).map((_, i) => (
                <LeadRowSkeleton key={i} />
              ))}
            </div>
          ) : isError ? (
            <div className="text-center py-16 px-4">
              <p className="text-sm text-muted-foreground">
                Failed to load leads.
              </p>
              <button
                onClick={() => refetch()}
                className="text-sm text-primary underline mt-1"
              >
                Retry
              </button>
            </div>
          ) : !sortedLeads || sortedLeads.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
              <EmptyLeadsIllustration className="mb-3" />
              <p className="text-sm font-medium mb-1">
                {statusFilter ? "No leads match" : "No leads yet"}
              </p>
              <p className="text-xs text-muted-foreground max-w-[240px]">
                {statusFilter
                  ? "Try a different filter or ask the assistant to find leads."
                  : "Ask your sales assistant to discover and save leads from conversations."}
              </p>
            </div>
          ) : (
            <>
              {/* Select all */}
              {sortedLeads.length > 1 && (
                <div className="px-4 py-1.5 border-b flex items-center gap-2">
                  <Checkbox
                    checked={selectedIds.length === sortedLeads.length && sortedLeads.length > 0}
                    onCheckedChange={(checked) => {
                      if (checked) {
                        selectAll(sortedLeads.map((l) => l.id));
                      } else {
                        clearSelection();
                      }
                    }}
                  />
                  <span className="text-[11px] text-muted-foreground">
                    Select all
                  </span>
                </div>
              )}
              {sortedLeads.map((lead) => (
                <LeadRow
                  key={lead.id}
                  lead={lead}
                  isSelected={lead.id === selectedLeadId}
                  isChecked={selectedIds.includes(lead.id)}
                  onToggleCheck={() => toggleSelected(lead.id)}
                  onClick={() => setSelectedLeadId(lead.id)}
                />
              ))}
            </>
          )}
        </div>

        {/* Batch action bar */}
        {selectedIds.length > 0 && (
          <BatchActionBar
            count={selectedIds.length}
            projectId={projectId!}
            selectedIds={selectedIds}
            onClear={clearSelection}
          />
        )}
      </div>

      {/* Detail panel (desktop only) */}
      {!isMobile && selectedLead && (
        <div className="flex-1 min-w-0">
          <LeadDetail
            key={selectedLead.id}
            lead={selectedLead}
            projectId={projectId!}
            onBack={() => setSelectedLeadId(null)}
          />
        </div>
      )}

      {/* Empty detail state (desktop, nothing selected) */}
      {!isMobile && !selectedLead && (
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          <p className="text-sm">Select a lead to view details</p>
        </div>
      )}

    </div>
  );
}
