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
import { tasksCommand } from "./commands/tasks.ts";
import { imageCommand } from "./commands/image.ts";
import { credsCommand } from "./commands/creds.ts";
import { browserCommand } from "./commands/browser.ts";
import { appsCommand } from "./commands/apps.ts";
import { llmCommand } from "./commands/llm.ts";
import { notificationCommand } from "./commands/notification.ts";
import { embedCommand } from "./commands/embed.ts";
import { searchCommand } from "./commands/search.ts";
import { emailCommand } from "./commands/email.ts";
import { canvasCommand } from "./commands/canvas.ts";
import { authCommand } from "./commands/auth.ts";
import { projectsCommand } from "./commands/projects.ts";
import { companionCommand } from "./commands/companion.ts";
import { loadConfig } from "../sdk/config.ts";

const HELP = `zero - agent toolkit CLI

Usage:
  zero <group> <action> [...args] [--json]

Groups:
  login            Connect this machine to a zero server (browser device flow)
  logout           Disconnect this machine
  whoami           Show the connected server / project
  health           Check that the runner→server proxy is reachable
  web              search, fetch
  image            generate
  tasks            add (with --schedule, --event, or --script), ls, update, rm
  creds            ls, get, set, rm
  browser          open, snapshot, click, fill, screenshot, evaluate, wait, extract, status, setup, connect
  companion        run the local companion (drive the agent's browser with your Chrome)
  apps             create, delete, list
  llm              generate
  notification     send (with --respond to wait for a reply)
  email            list, read, send, reply, search the project's mailbox
  embed            generate vector embeddings (single text or --batch)
  search           vector search over project files and messages
  canvas           get, set, arrow, draw, rm, clear on the project whiteboard

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

  // Laptop mode: when not running inside a runner container (no ZERO_PROXY_URL)
  // but the user has logged in, point the SDK transport at the remote server's
  // proxy and authenticate with the companion token. This makes the FULL CLI
  // toolset work from the user's own machine through the very same
  // /v1/proxy/zero/* surface the in-container agent uses — no per-command
  // remote plumbing. (`zero browser connect` stays separate: it's a persistent
  // tunnel, not a request/response call.)
  if (!process.env.ZERO_PROXY_URL) {
    const cfg = loadConfig();
    if (cfg) {
      process.env.ZERO_PROXY_URL = `${cfg.baseUrl.replace(/\/+$/, "")}/v1/proxy`;
      process.env.ZERO_PROXY_TOKEN = cfg.token;
    } else if (group !== "login" && group !== "logout" && group !== "whoami") {
      // Laptop, no runner socket, and no saved login: every proxy command
      // would otherwise fail deep in the SDK with a confusing "only works
      // inside a container" error. Point the user at `zero login` instead.
      process.stderr.write(
        "zero: not logged in. Run `zero login --url <server>` first " +
          "(approve the device in the web app under Settings → Companion).\n",
      );
      return 2;
    }
  }

  try {
    switch (group) {
      case "login":
      case "logout":
      case "whoami":
        return await authCommand(group, rest);
      case "health": {
        const data = await call("/zero/health", {});
        printJson(data);
        return 0;
      }
      case "web":
        return await webCommand(rest);
      case "tasks":
        return await tasksCommand(rest);
      case "projects":
        return await projectsCommand(rest);
      case "image":
        return await imageCommand(rest);
      case "creds":
        return await credsCommand(rest);
      case "browser":
        return await browserCommand(rest);
      case "companion":
        return await companionCommand(rest);
      case "apps":
        return await appsCommand(rest);
      case "llm":
        return await llmCommand(rest);
      case "notification":
        return await notificationCommand(rest);
      case "email":
        return await emailCommand(rest);
      case "embed":
        return await embedCommand(rest);
      case "search":
        return await searchCommand(rest);
      case "canvas":
        return await canvasCommand(rest);
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
