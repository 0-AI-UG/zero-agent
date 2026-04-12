/**
 * `zero ports forward` - expose a workspace port to a browser-accessible URL.
 *
 * Call this after starting a server with e.g. `zero bash ... &` or any
 * background process that listens on the given port. The handler
 * auto-detects the start command via /proc inspection inside the container.
 */
import { ports } from "../../sdk/ports.ts";
import { hasFlag, getOption, printJson } from "../format.ts";

const HELP = `zero ports - manage forwarded ports

Usage:
  zero ports forward <port> [--label <label>] [--json]

Forwards the given workspace port to /app/<slug> and prints the URL.
If the port is already forwarded, returns the existing URL (idempotent).
`;

export async function portsCommand(args: string[]): Promise<number> {
  const [action, ...rest] = args;
  if (!action || action === "--help" || action === "-h") {
    process.stdout.write(HELP);
    return 0;
  }

  if (action === "forward") {
    const positional = rest.filter((a, i) => !a.startsWith("--") && rest[i - 1] !== "--label");
    const portStr = positional[0];
    if (!portStr) {
      process.stderr.write("zero ports forward: missing port number\n");
      return 2;
    }
    const port = Number(portStr);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      process.stderr.write(`zero ports forward: invalid port "${portStr}"\n`);
      return 2;
    }
    const label = getOption(rest, "--label");
    const data = await ports.forward({ port, ...(label ? { label } : {}) });
    if (hasFlag(rest, "--json")) printJson(data);
    else process.stdout.write(`${data.url}\n`);
    return 0;
  }

  process.stderr.write(`zero ports: unknown action "${action}"\n${HELP}`);
  return 2;
}
