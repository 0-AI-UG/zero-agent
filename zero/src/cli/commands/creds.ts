/**
 * `zero creds {ls,get,set,rm}` — credential management.
 *
 * SECURITY: `zero creds get` writes ONLY the secret value to stdout
 * (no JSON envelope, no extra text). This is what makes
 * `$(zero creds get foo)` shell substitution safe — the secret never
 * appears in any other tool result. We exit non-zero on miss so silent
 * empty interpolation can never happen.
 */
import { creds } from "../../sdk/creds.ts";
import { hasFlag, getOption, printJson } from "../format.ts";

const HELP = `zero creds — manage saved credentials

Usage:
  zero creds ls [--json]
  zero creds get <label-or-domain> [--field password|totp|username] [--json]
  zero creds set --label <l> --site <url> --user <u> --password <p> [--totp <secret>]
  zero creds rm <id-or-label>

The 'get' subcommand prints ONLY the resolved secret to stdout. Use it
inside shell substitution to keep secrets out of the model context:
  curl -H "Authorization: Bearer $(zero creds get github)" https://api...
`;

export async function credsCommand(args: string[]): Promise<number> {
  const [action, ...rest] = args;
  if (!action || action === "--help" || action === "-h") { process.stdout.write(HELP); return 0; }

  if (action === "ls" || action === "list") {
    const data = await creds.ls();
    if (hasFlag(rest, "--json")) printJson(data);
    else for (const c of data.credentials) {
      const flags = [c.hasPassword && "pw", c.hasTotp && "totp"].filter(Boolean).join(",");
      process.stdout.write(`${c.id}  ${c.label}  ${c.domain}  ${c.username ?? ""}  [${flags}]\n`);
    }
    return 0;
  }

  if (action === "get") {
    const positional = rest.filter((a, i) => !a.startsWith("--") && rest[i - 1] !== "--field");
    const key = positional[0];
    if (!key) { process.stderr.write("zero creds get: missing label or domain\n"); return 2; }
    const field = (getOption(rest, "--field") as "password" | "totp" | "username" | undefined) ?? "password";
    // Try as label first, fall back to siteUrl. Both are project-scoped.
    let data;
    try {
      data = await creds.get({ label: key, field });
    } catch {
      try {
        data = await creds.get({ siteUrl: key, field });
      } catch (err) {
        // Re-throw — main() will print and exit non-zero
        throw err;
      }
    }
    if (hasFlag(rest, "--json")) {
      printJson(data);
    } else {
      // CRITICAL: only the raw value, no trailing newline by default? We
      // do add a newline so terminal output is readable; shell
      // substitution `$(...)` strips trailing newlines automatically.
      process.stdout.write(data.value + "\n");
    }
    return 0;
  }

  if (action === "set") {
    const label = getOption(rest, "--label");
    const siteUrl = getOption(rest, "--site");
    const username = getOption(rest, "--user");
    const password = getOption(rest, "--password");
    const totpSecret = getOption(rest, "--totp");
    if (!label || !siteUrl || !username || !password) {
      process.stderr.write("zero creds set: --label, --site, --user, --password required\n");
      return 2;
    }
    const data = await creds.set({ label, siteUrl, username, password, totpSecret });
    if (hasFlag(rest, "--json")) printJson(data);
    else process.stdout.write(`${data.updated ? "updated" : "saved"} ${data.id}\n`);
    return 0;
  }

  if (action === "rm" || action === "remove") {
    const positional = rest.filter(a => !a.startsWith("--"));
    const key = positional[0];
    if (!key) { process.stderr.write("zero creds rm: missing id or label\n"); return 2; }
    // Try id first, then label.
    let data;
    try {
      data = await creds.rm({ id: key });
    } catch {
      data = await creds.rm({ label: key });
    }
    if (hasFlag(rest, "--json")) printJson(data);
    else process.stdout.write(`removed ${data.id}\n`);
    return 0;
  }

  process.stderr.write(`zero creds: unknown action "${action}"\n${HELP}`);
  return 2;
}
