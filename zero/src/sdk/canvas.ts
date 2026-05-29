import { call, type CallOptions } from "./client.ts";
import {
  CanvasGetInput,
  CanvasSetInput,
  CanvasArrowInput,
  CanvasDrawInput,
  CanvasRemoveInput,
  CanvasClearInput,
  type CanvasSetInputT,
  type CanvasArrowInputT,
  type CanvasDrawInputT,
} from "./schemas.ts";

export type CanvasShapeType = "note" | "rect" | "ellipse" | "text" | "arrow";

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

/** One shape you name yourself (`id`). Re-using a name patches that shape. */
export type SetShapeInput = CanvasSetInputT;
export type ArrowInput = CanvasArrowInputT;
export type DrawItem = CanvasDrawInputT["items"][number];

/**
 * The project's collaborative whiteboard. You name every shape yourself and
 * address it by that name — there are no server ids to track. Every change
 * is persisted and pushed live to teammates viewing the Canvas tab.
 */
export const canvas = {
  /** Read every shape currently on the board. */
  get(options?: CallOptions): Promise<{ shapes: CanvasShape[] }> {
    return call<{ shapes: CanvasShape[] }>("/zero/canvas/get", CanvasGetInput.parse({}), options);
  },
  /**
   * Create or update a shape by name. First call with a name creates it;
   * later calls with the same name patch only the fields you pass.
   */
  set(input: SetShapeInput, options?: CallOptions): Promise<{ shape: CanvasShape }> {
    return call<{ shape: CanvasShape }>("/zero/canvas/set", CanvasSetInput.parse(input), options);
  },
  /**
   * Connect two shapes by name with an arrow. The server anchors it
   * edge-to-edge — you never compute coordinates.
   */
  arrow(input: ArrowInput, options?: CallOptions): Promise<{ shape: CanvasShape }> {
    return call<{ shape: CanvasShape }>("/zero/canvas/arrow", CanvasArrowInput.parse(input), options);
  },
  /**
   * Draw a whole diagram in one call. Each item is a shape (`{id,...}`) or
   * an arrow (`{from,to}`); arrows resolve to shapes by name, in any order.
   */
  draw(items: DrawItem[], options?: CallOptions): Promise<{ shapes: CanvasShape[] }> {
    return call<{ shapes: CanvasShape[] }>("/zero/canvas/draw", CanvasDrawInput.parse({ items }), options);
  },
  /** Remove a shape by name. */
  remove(id: string, options?: CallOptions): Promise<{ success: boolean }> {
    return call<{ success: boolean }>("/zero/canvas/remove", CanvasRemoveInput.parse({ id }), options);
  },
  /** Remove every shape from the board. */
  clear(options?: CallOptions): Promise<{ success: boolean }> {
    return call<{ success: boolean }>("/zero/canvas/clear", CanvasClearInput.parse({}), options);
  },
};
