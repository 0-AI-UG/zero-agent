/**
 * `checkPort` — TCP connect probe used by the apps gate page to answer
 * "is anything currently listening on this loopback port?". The proxy
 * itself doesn't need this (it just `fetch`es and returns 502 on failure);
 * the gate page uses it to render a friendlier "not running" message.
 */
import { createConnection } from "node:net";

export function checkPort(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}
