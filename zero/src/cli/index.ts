#!/usr/bin/env bun
/**
 * `zero` CLI entry point. Dispatches to subcommands. Each command file
 * is a thin shell that parses argv, calls the matching SDK function in
 * src/sdk, and prints. No business logic in cli/.
 *
 * Step 1 only ships the dispatcher and a `health` command for end-to-end
 * verification. Subsequent steps add real subcommands.
 */
import path from "node:path";
import { printError, printJson } from "./format.ts";
import { call } from "../sdk/client.ts";
import { webCommand } from "./commands/web.ts";
import { scheduleCommand } from "./commands/schedule.ts";
import { imageCommand } from "./commands/image.ts";
import { credsCommand } from "./commands/creds.ts";
import { browserCommand } from "./commands/browser.ts";
import { appsCommand } from "./commands/apps.ts";
import { llmCommand } from "./commands/llm.ts";
import { messageCommand } from "./commands/message.ts";
import { embedCommand } from "./commands/embed.ts";
import { searchCommand } from "./commands/search.ts";

// Source layout: zero/src/cli/index.ts → two levels up = zero/.
// Bundled layout: zero/dist/cli.js → one level up = zero/.
const ZERO_ROOT = path.basename(import.meta.dirname) === "dist"
  ? path.dirname(import.meta.dirname)
  : path.dirname(path.dirname(import.meta.dirname));

const HELP = `zero - agent toolkit CLI

Usage:
  zero <group> <action> [...args] [--json]

Groups (added by migration steps):
  health           Check that the runner→server proxy is reachable
  web              search, fetch
  image            generate
  schedule         add (with --schedule, --event, or --script), ls, update, rm
  creds            ls, get, set, rm
  browser          open, click, fill, screenshot, evaluate, wait, status
  apps             create, delete, list
  llm              generate
  message          send a message to the user (Telegram + push)
  embed            generate vector embeddings
  search           vector search over project files, memory, and messages

Run 'zero <group> --help' for details. All commands support --json.

Source: ${ZERO_ROOT}/src/
Full reference: ${ZERO_ROOT}/USAGE.md
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
      case "schedule":
        return await scheduleCommand(rest);
      case "image":
        return await imageCommand(rest);
      case "creds":
        return await credsCommand(rest);
      case "browser":
        return await browserCommand(rest);
      case "apps":
        return await appsCommand(rest);
      case "llm":
        return await llmCommand(rest);
      case "message":
        return await messageCommand(rest);
      case "embed":
        return await embedCommand(rest);
      case "search":
        return await searchCommand(rest);
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
