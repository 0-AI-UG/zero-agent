/** `zero email` — list, read, send, reply, search the project's mailbox. */
import { email } from "../../sdk/email.ts";
import { hasFlag, printJson } from "../format.ts";

const HELP = `zero email - manage the project's mailbox

Usage:
  zero email list   [--unread] [--from <addr>] [--since <iso>] [--thread <key>] [--limit <n>] [--json]
  zero email read   <id> [--json]
  zero email send   --to <addr,addr> --subject <s> --body <text> [--context <text>] [--json]
  zero email reply  <id> --body <text> [--json]
  zero email search <query> [--limit <n>] [--json]

Each project has its own inbound address (see Project → Settings → Email).
Send works for cold outreach too — you don't need a prior inbound thread.

--context <text>   Background for the agent that will respond when the
                   recipient replies (what this email is about, prior
                   conversation, who the recipient is). Stored on the
                   outbound row and surfaced as context on the first reply.
`;

function value(args: string[], flag: string): string | null {
  const i = args.indexOf(flag);
  if (i === -1) return null;
  const v = args[i + 1];
  return !v || v.startsWith("--") ? null : v;
}

function positional(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      // skip flag value if it takes one
      if (["--to", "--subject", "--body", "--context", "--from", "--since", "--thread", "--limit"].includes(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

export async function emailCommand(args: string[]): Promise<number> {
  const [action, ...rest] = args;
  if (!action || action === "--help" || action === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  const json = hasFlag(rest, "--json");

  switch (action) {
    case "list": {
      const limit = value(rest, "--limit");
      const result = await email.list({
        unread: hasFlag(rest, "--unread") || undefined,
        from: value(rest, "--from") ?? undefined,
        since: value(rest, "--since") ?? undefined,
        threadKey: value(rest, "--thread") ?? undefined,
        limit: limit ? Number(limit) : undefined,
      });
      if (json) { printJson(result); return 0; }
      if (result.messages.length === 0) { process.stdout.write("(no messages)\n"); return 0; }
      for (const m of result.messages) {
        const arrow = m.direction === "in" ? "←" : "→";
        process.stdout.write(`${m.id}  ${arrow} ${m.from}  ${m.receivedAt}\n    ${m.subject}\n`);
      }
      return 0;
    }
    case "read": {
      const id = positional(rest)[0];
      if (!id) { process.stderr.write("zero email read: missing <id>\n"); return 2; }
      const msg = await email.read(id);
      if (json) { printJson(msg); return 0; }
      process.stdout.write(`From: ${msg.from}\nTo: ${msg.to.join(", ")}\nSubject: ${msg.subject}\nDate: ${msg.receivedAt}\n`);
      if (msg.attachments.length > 0) {
        process.stdout.write(`Attachments:\n${msg.attachments.map((a) => `  - ${a.path} (${a.mime}, ${a.sizeBytes} B)`).join("\n")}\n`);
      }
      process.stdout.write(`\n${msg.bodyText ?? "(no text body)"}\n`);
      return 0;
    }
    case "send": {
      const toRaw = value(rest, "--to");
      const subject = value(rest, "--subject");
      const body = value(rest, "--body");
      if (!toRaw || !subject || !body) {
        process.stderr.write("zero email send: --to, --subject and --body are required\n");
        return 2;
      }
      const to = toRaw.split(",").map((s) => s.trim()).filter(Boolean);
      const context = value(rest, "--context") ?? undefined;
      const result = await email.send({ to, subject, body, context });
      if (json) { printJson(result); return result.ok ? 0 : 1; }
      if (result.ok) process.stdout.write("email sent successfully\n");
      else process.stderr.write(`failed: ${result.error ?? "unknown"}\n`);
      return result.ok ? 0 : 1;
    }
    case "reply": {
      const id = positional(rest)[0];
      const body = value(rest, "--body");
      if (!id || !body) {
        process.stderr.write("zero email reply: <id> and --body are required\n");
        return 2;
      }
      const result = await email.reply(id, body);
      if (json) { printJson(result); return result.ok ? 0 : 1; }
      if (result.ok) process.stdout.write("email sent successfully\n");
      else process.stderr.write(`failed: ${result.error ?? "unknown"}\n`);
      return result.ok ? 0 : 1;
    }
    case "search": {
      const q = positional(rest)[0];
      if (!q) { process.stderr.write("zero email search: missing <query>\n"); return 2; }
      const limit = value(rest, "--limit");
      const result = await email.search(q, limit ? Number(limit) : undefined);
      if (json) { printJson(result); return 0; }
      if (result.messages.length === 0) { process.stdout.write("(no matches)\n"); return 0; }
      for (const m of result.messages) {
        process.stdout.write(`${m.id}  ${m.from}  ${m.receivedAt}\n    ${m.subject}\n`);
      }
      return 0;
    }
    default:
      process.stderr.write(`zero email: unknown action "${action}"\n${HELP}`);
      return 2;
  }
}
