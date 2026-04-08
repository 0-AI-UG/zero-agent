#!/usr/bin/env bun
/**
 * `zero` CLI entry point. Dispatches to subcommands. Each command file
 * is a thin shell that parses argv, calls the matching SDK function in
 * src/sdk, and prints. No business logic in cli/.
 *
 * Step 1 only ships the dispatcher and a `health` command for end-to-end
 * verification. Subsequent steps add real subcommands.
 */
import { printError, printJson } from "./format.ts";
import { call } from "../sdk/client.ts";
import { webCommand } from "./commands/web.ts";
import { chatCommand } from "./commands/chat.ts";
import { telegramCommand } from "./commands/telegram.ts";
import { scheduleCommand } from "./commands/schedule.ts";
import { imageCommand } from "./commands/image.ts";
import { credsCommand } from "./commands/creds.ts";
import { browserCommand } from "./commands/browser.ts";
import { portsCommand } from "./commands/ports.ts";

const HELP = `zero — agent toolkit CLI

Usage:
  zero <group> <action> [...args] [--json]

Groups (added by migration steps):
  health           Check that the runner→server proxy is reachable
  web              search, fetch
  image            generate
  schedule         add, ls, update, rm
  chat             search
  telegram         send
  creds            ls, get, set, rm
  browser          open, click, fill, screenshot, evaluate, wait, status
  ports            forward

Run 'zero <group> --help' for details. All commands support --json.
`;

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(HELP);
    return 0;
  }

  const group = args[0]!;
  const rest = args.slice(1);

  try {
    switch (group) {
      case "health": {
        const data = await call("/zero/health", {});
        printJson(data);
        return 0;
      }
      case "web":
        return await webCommand(rest);
      case "chat":
        return await chatCommand(rest);
      case "telegram":
        return await telegramCommand(rest);
      case "schedule":
        return await scheduleCommand(rest);
      case "image":
        return await imageCommand(rest);
      case "creds":
        return await credsCommand(rest);
      case "browser":
        return await browserCommand(rest);
      case "ports":
        return await portsCommand(rest);
      default:
        process.stderr.write(`zero: unknown group "${group}"\n${HELP}`);
        return 2;
    }
  } catch (err) {
    printError(err);
    return 1;
  }
}

main(process.argv).then((code) => process.exit(code));
