/** `zero message send <text>` — send a message to the user across all channels. */
import { message } from "../../sdk/message.ts";
import { hasFlag, printJson } from "../format.ts";

const HELP = `zero message — send a message to the user

Usage:
  zero message send <text> [--respond] [--timeout <duration>] [--json]

Options:
  --respond              Wait for a reply from the user.
  --timeout <duration>   How long to wait for a reply. Default 5m.
                         Formats: 30s, 5m, 1h. Min 5s, max 30m.
  --json                 Print raw JSON.

Delivers to all configured channels (Telegram, WebSocket toast, Web Push).
With --respond, the first reply from any channel wins and is returned.
`;

function parseDuration(raw: string): number | null {
  const m = raw.match(/^(\d+)(ms|s|m|h)?$/i);
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  const unit = (m[2] ?? "ms").toLowerCase();
  switch (unit) {
    case "ms":
      return n;
    case "s":
      return n * 1_000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 60 * 60_000;
  }
  return null;
}

function extractFlagValue(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag);
  if (idx === -1) return null;
  const val = args[idx + 1];
  if (!val || val.startsWith("--")) return null;
  return val;
}

export async function messageCommand(args: string[]): Promise<number> {
  const [action, ...rest] = args;
  if (!action || action === "--help" || action === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  if (action !== "send") {
    process.stderr.write(`zero message: unknown action "${action}"\n${HELP}`);
    return 2;
  }

  // Flags with values we need to skip in the free-text collection.
  const timeoutRaw = extractFlagValue(rest, "--timeout");
  const respond = hasFlag(rest, "--respond");
  const asJson = hasFlag(rest, "--json");

  // Free-text = everything that isn't a flag or a flag value.
  const textParts: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      if (a === "--timeout") {
        i++; // skip the value
      }
      continue;
    }
    textParts.push(a);
  }
  const text = textParts.join(" ");
  if (!text) {
    process.stderr.write("zero message send: missing text\n");
    return 2;
  }

  let timeoutMs: number | undefined;
  if (timeoutRaw) {
    const parsed = parseDuration(timeoutRaw);
    if (parsed == null) {
      process.stderr.write(`zero message send: invalid --timeout "${timeoutRaw}"\n`);
      return 2;
    }
    if (parsed < 5_000 || parsed > 30 * 60_000) {
      process.stderr.write(`zero message send: --timeout must be between 5s and 30m\n`);
      return 2;
    }
    timeoutMs = parsed;
  }

  const sendResult = await message.send(text, { respond, timeoutMs });

  if (!respond) {
    if (asJson) printJson(sendResult);
    else if (sendResult.delivered.length > 0) {
      process.stdout.write(`delivered to: ${sendResult.delivered.join(", ")}\n`);
    } else {
      process.stdout.write("delivered to: no channels\n");
      if (sendResult.diagnostics?.length) {
        // Aggregate per-channel reasons across users so the message stays
        // short for single-user projects but still surfaces per-user
        // detail when the project has multiple members.
        const lines: string[] = [];
        for (const d of sendResult.diagnostics) {
          const parts: string[] = [];
          for (const ch of ["ws", "push", "telegram"] as const) {
            const skip = d.skipped.find((s) => s.channel === ch);
            const failed = d.failed.includes(ch);
            const available = d.availability[ch];
            const label =
              ch === "ws" ? "in-app" : ch === "push" ? "push" : "telegram";
            if (failed) parts.push(`${label}: delivery failed`);
            else if (skip?.reason === "opted-out")
              parts.push(`${label}: opted out`);
            else if (skip?.reason === "unavailable")
              parts.push(
                `${label}: ${
                  ch === "ws"
                    ? "no live websocket connection"
                    : ch === "push"
                    ? "no push subscription registered"
                    : "telegram not linked"
                }`,
              );
            else if (available) parts.push(`${label}: available`);
          }
          const prefix =
            sendResult.diagnostics.length === 1
              ? "  "
              : `  user ${d.userId.slice(0, 8)}: `;
          lines.push(prefix + parts.join(", "));
        }
        process.stdout.write(lines.join("\n") + "\n");
      }
    }
    return 0;
  }

  if (!sendResult.groupId) {
    // No project members = nothing to poll. Surface that clearly.
    if (asJson) printJson({ ...sendResult, response: null, timedOut: false });
    else process.stdout.write(`no targets to notify\n`);
    return 0;
  }

  const response = await message.awaitResponse(sendResult.groupId);
  if (asJson) {
    printJson({
      delivered: sendResult.delivered,
      groupId: sendResult.groupId,
      response,
    });
  } else if (response.timedOut) {
    process.stdout.write(`timed out waiting for reply\n`);
    return 1;
  } else if (response.cancelled) {
    process.stdout.write(`cancelled\n`);
    return 1;
  } else {
    process.stdout.write(`${response.text}\n`);
  }
  return 0;
}
