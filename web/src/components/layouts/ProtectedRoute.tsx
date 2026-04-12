import { Navigate, Outlet, useLocation } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useAuthStore } from "@/stores/auth";
import { getSetupStatus } from "@/api/setup";
import { useModels } from "@/api/models";
import { setModelsCache } from "@/stores/model";
import { postSyncVerdict } from "@/api/sync";
import {
  usePendingApprovalsStore,
  type SyncUiStatus,
} from "@/stores/pending-approvals";

export function ProtectedRoute() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const location = useLocation();

  const { data: setupStatus, isLoading } = useQuery({
    queryKey: ["setup", "status"],
    queryFn: getSetupStatus,
  });

  if (isLoading) {
    return null;
  }

  if (setupStatus && !setupStatus.setupComplete) {
    return <Navigate to="/setup" replace />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <ModelsCacheSync />;
}

function ModelsCacheSync() {
  const { data: models } = useModels();
  if (models) setModelsCache(models);
  useSyncActionParam();
  return <Outlet />;
}

/**
 * Consume a `?syncv=<id>:<approve|reject>` query param set by the service
 * worker when the user tapped a sync-approval action button on a push
 * notification. Post the verdict, seed the pending-approvals store with the
 * echoed state, and strip the param so a reload doesn't re-submit.
 */
function useSyncActionParam() {
  const location = useLocation();
  useEffect(() => {
    const url = new URL(window.location.href);
    const param = url.searchParams.get("syncv");
    if (!param) return;
    const [id, verdict] = param.split(":");
    if (!id || (verdict !== "approve" && verdict !== "reject")) return;

    url.searchParams.delete("syncv");
    window.history.replaceState(
      window.history.state,
      "",
      url.pathname + (url.search ? url.search : "") + url.hash,
    );

    postSyncVerdict(id, verdict === "approve")
      .then((result) => {
        usePendingApprovalsStore
          .getState()
          .setStatus(id, result.sync.status as SyncUiStatus);
      })
      .catch((err) => {
        console.error("push sync verdict failed", err);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);
}
