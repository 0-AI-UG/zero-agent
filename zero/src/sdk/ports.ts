import { call, type CallOptions } from "./client.ts";
import { PortsForwardInput, type PortsForwardInputT } from "./schemas.ts";

export interface ForwardPortResult {
  portId: string;
  url: string;
  slug: string;
  port: number;
  message: string;
}

export const ports = {
  /**
   * Forward a port from the workspace container to a browser-accessible URL.
   * Idempotent: if the port is already forwarded, returns the existing record.
   */
  forward(input: PortsForwardInputT, options?: CallOptions): Promise<ForwardPortResult> {
    return call<ForwardPortResult>("/zero/ports/forward", PortsForwardInput.parse(input), options);
  },
};
