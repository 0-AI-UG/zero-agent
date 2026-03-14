import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useUIStore } from "@/stores/ui";
import { useLeadsStore } from "@/stores/leads-store";
import { useLeads } from "@/api/leads";
import { LeadList } from "./LeadList";
import { LeadDetail } from "./LeadDetail";

interface LeadsDrawerProps {
  projectId: string;
}

export function LeadsDrawer({ projectId }: LeadsDrawerProps) {
  const activeDrawer = useUIStore((s) => s.activeDrawer);
  const closeDrawer = useUIStore((s) => s.closeDrawer);
  const {
    selectedLeadId,
    setSelectedLeadId,
    statusFilter,
    setStatusFilter,
  } = useLeadsStore();

  const {
    data: leads,
    isLoading,
    isError,
    refetch,
  } = useLeads(projectId, statusFilter);

  const selectedLead = selectedLeadId
    ? leads?.find((l) => l.id === selectedLeadId)
    : undefined;

  return (
    <Sheet
      open={activeDrawer === "leads"}
      onOpenChange={(open) => {
        if (!open) {
          closeDrawer();
          setSelectedLeadId(null);
        }
      }}
    >
      <SheetContent
        side="right"
        className="w-[80vw] sm:w-[400px] sm:max-w-[400px] p-0 flex flex-col"
      >
        {selectedLead ? (
          <LeadDetail
            lead={selectedLead}
            projectId={projectId}
            onBack={() => setSelectedLeadId(null)}
          />
        ) : (
          <>
            <SheetHeader className="px-4 py-3 border-b space-y-0">
              <SheetTitle className="text-base">Leads</SheetTitle>
            </SheetHeader>

            <div className="flex-1 min-h-0 overflow-y-auto">
              <LeadList
                leads={leads}
                isLoading={isLoading}
                isError={isError}
                statusFilter={statusFilter}
                onStatusFilterChange={setStatusFilter}
                onLeadClick={setSelectedLeadId}
                onRetry={() => refetch()}
              />
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
