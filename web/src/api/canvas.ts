import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/api/client";
import { queryKeys } from "@/lib/query-keys";

export type CanvasShapeType = "rect" | "ellipse" | "text" | "arrow";

export interface CanvasShape {
  id: string;
  type: CanvasShapeType;
  x: number;
  y: number;
  w?: number;
  h?: number;
  x2?: number;
  y2?: number;
  text?: string;
  color?: string;
}

export interface CanvasDoc {
  shapes: CanvasShape[];
  updatedAt: number;
}

export type CanvasOp =
  | { kind: "add"; shape: CanvasShape }
  | { kind: "update"; id: string; props: Partial<Omit<CanvasShape, "id" | "type">> }
  | { kind: "delete"; id: string }
  | { kind: "clear" };

/**
 * Initial load of the project's whiteboard. Kept fresh thereafter by the
 * WebSocket op stream (see CanvasPage), so we never auto-refetch.
 */
export function useCanvas(projectId: string) {
  return useQuery({
    queryKey: queryKeys.canvas.byProject(projectId),
    queryFn: async () => {
      const res = await apiFetch<{ doc: CanvasDoc }>(`/projects/${projectId}/canvas`);
      return res.doc;
    },
    enabled: !!projectId,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

/** Mirror of the server's op application, for optimistic/remote ops. */
export function applyOpToShapes(
  shapes: Record<string, CanvasShape>,
  op: CanvasOp,
): Record<string, CanvasShape> {
  switch (op.kind) {
    case "add":
      return { ...shapes, [op.shape.id]: op.shape };
    case "update": {
      const prev = shapes[op.id];
      if (!prev) return shapes;
      return { ...shapes, [op.id]: { ...prev, ...op.props } };
    }
    case "delete": {
      if (!shapes[op.id]) return shapes;
      const next = { ...shapes };
      delete next[op.id];
      return next;
    }
    case "clear":
      return {};
    default:
      return shapes;
  }
}
