import type { Lead, LeadStatus } from "@/api/leads";
import { Badge } from "@/components/ui/badge";
import { Loader } from "@/components/ai/loader";
import { Users } from "lucide-react";

const STATUS_TABS: { value: string; label: string }[] = [
  { value: "all", label: "All" },
  { value: "new", label: "New" },
  { value: "contacted", label: "Contacted" },
  { value: "replied", label: "Replied" },
  { value: "converted", label: "Converted" },
  { value: "dropped", label: "Dropped" },
];

const STATUS_COLORS: Record<LeadStatus, string> = {
  new: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  contacted:
    "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300",
  replied:
    "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300",
  converted:
    "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
  dropped: "bg-gray-100 text-gray-700 dark:bg-gray-900 dark:text-gray-300",
};

interface LeadListProps {
  leads: Lead[] | undefined;
  isLoading: boolean;
  isError: boolean;
  statusFilter: string | undefined;
  onStatusFilterChange: (status: string | undefined) => void;
  onLeadClick: (leadId: string) => void;
  onRetry: () => void;
}

export function LeadList({
  leads,
  isLoading,
  isError,
  statusFilter,
  onStatusFilterChange,
  onLeadClick,
  onRetry,
}: LeadListProps) {
  const activeFilter = statusFilter ?? "all";

  return (
    <div className="flex flex-col">
      {/* Status filter tabs */}
      <div className="flex gap-1 px-4 py-2 overflow-x-auto">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.value}
            onClick={() =>
              onStatusFilterChange(tab.value === "all" ? undefined : tab.value)
            }
            className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              activeFilter === tab.value
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/80"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader size={24} />
        </div>
      ) : isError ? (
        <div className="text-center py-12 px-4">
          <p className="text-sm text-muted-foreground">
            Failed to load leads.
          </p>
          <button
            onClick={onRetry}
            className="text-sm text-primary underline mt-1"
          >
            Retry
          </button>
        </div>
      ) : !leads || leads.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
          <Users className="size-10 text-muted-foreground/50 mb-3" />
          <p className="text-sm text-muted-foreground">
            {statusFilter ? "No leads with this status." : "No leads yet."}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Ask the agent to save leads from your conversations.
          </p>
        </div>
      ) : (
        <div className="divide-y">
          {leads.map((lead) => (
            <button
              key={lead.id}
              onClick={() => onLeadClick(lead.id)}
              className="w-full text-left px-4 py-3 hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{lead.name}</p>
                  {lead.source && (
                    <p className="text-xs text-muted-foreground truncate mt-0.5">
                      {lead.source}
                    </p>
                  )}
                  {lead.notes && (
                    <p className="text-xs text-muted-foreground line-clamp-2 mt-1">
                      {lead.notes}
                    </p>
                  )}
                  {lead.followUpDate && (
                    <p className="text-xs text-muted-foreground mt-1">
                      Follow-up: {lead.followUpDate}
                    </p>
                  )}
                </div>
                <Badge
                  variant="secondary"
                  className={`shrink-0 text-[10px] ${STATUS_COLORS[lead.status]}`}
                >
                  {lead.status}
                </Badge>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
