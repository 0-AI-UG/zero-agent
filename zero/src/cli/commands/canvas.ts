import { canvas as canvasSdk, type DrawItem } from "../../sdk/canvas.ts";
import { getOption, printJson } from "../format.ts";

const HELP = `zero canvas - the project's collaborative whiteboard

You name every shape yourself and refer to it by that name. There are no
ids to track.

Usage:
  zero canvas get
  zero canvas set <name> [--type note|rect|ellipse|text] [--text <t>]
                         [--x N] [--y N] [--w N] [--h N] [--color <c>]
  zero canvas arrow <from> <to> [--text <t>] [--color <c>]
  zero canvas rm <name>
  zero canvas clear
  zero canvas draw '<json>'        Draw a whole diagram at once (or pipe via -)

set creates a shape the first time you use a name and updates it (patching
only the fields you pass) every time after. arrow connects two shapes by
name — the server figures out the coordinates, so you never do geometry.

Diagram in one call (shapes are {id,...}, arrows are {from,to}):
  zero canvas draw '[
    {"id":"client","type":"rect","text":"Client","x":0,"y":0},
    {"id":"server","type":"rect","text":"Server","x":320,"y":0},
    {"from":"client","to":"server","text":"request"}
  ]'

Coordinates are an unbounded plane; (0,0) is the origin. --x/--y is the
top-left, --w/--h the size. --color is a palette name: yellow, blue, green,
pink, purple, orange, gray.

Every change is saved and pushed live to teammates viewing the Canvas tab.
`;

function numOpt(args: string[], name: string): number | undefined {
  const raw = getOption(args, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Leading args before the first --flag (the positional operands). */
function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (const a of args) {
    if (a.startsWith("--")) break;
    out.push(a);
  }
  return out;
}

async function readStdin(): Promise<string> {
  const chunks: string[] = [];
  process.stdin.setEncoding("utf-8");
  for await (const chunk of process.stdin) chunks.push(chunk as string);
  return chunks.join("");
}

export async function canvasCommand(args: string[]): Promise<number> {
  const [action, ...rest] = args;
  if (!action || action === "--help" || action === "-h") {
    process.stdout.write(HELP);
    return 0;
  }

  if (action === "get") {
    printJson(await canvasSdk.get());
    return 0;
  }

  if (action === "set") {
    const [name] = positionals(rest);
    if (!name) {
      process.stderr.write("zero canvas set: a <name> is required\n");
      return 2;
    }
    const data = await canvasSdk.set({
      id: name,
      type: getOption(rest, "--type") as any,
      text: getOption(rest, "--text"),
      x: numOpt(rest, "--x"),
      y: numOpt(rest, "--y"),
      w: numOpt(rest, "--w"),
      h: numOpt(rest, "--h"),
      color: getOption(rest, "--color"),
    });
    printJson(data);
    return 0;
  }

  if (action === "arrow") {
    const [from, to] = positionals(rest);
    if (!from || !to) {
      process.stderr.write("zero canvas arrow: <from> and <to> shape names are required\n");
      return 2;
    }
    const data = await canvasSdk.arrow({
      from,
      to,
      text: getOption(rest, "--text"),
      color: getOption(rest, "--color"),
    });
    printJson(data);
    return 0;
  }

  if (action === "rm" || action === "delete") {
    const [name] = positionals(rest);
    if (!name) {
      process.stderr.write("zero canvas rm: a <name> is required\n");
      return 2;
    }
    printJson(await canvasSdk.remove(name));
    return 0;
  }

  if (action === "draw") {
    const [inline] = positionals(rest);
    const raw = inline && inline !== "-" ? inline : await readStdin();
    let items: DrawItem[];
    try {
      const parsed = JSON.parse(raw);
      items = Array.isArray(parsed) ? parsed : parsed?.items;
    } catch (err) {
      process.stderr.write(`zero canvas draw: invalid JSON (${(err as Error).message})\n`);
      return 2;
    }
    if (!Array.isArray(items) || items.length === 0) {
      process.stderr.write("zero canvas draw: expected a non-empty JSON array of items\n");
      return 2;
    }
    printJson(await canvasSdk.draw(items));
    return 0;
  }

  if (action === "clear") {
    printJson(await canvasSdk.clear());
    return 0;
  }

  process.stderr.write(`zero canvas: unknown action "${action}"\n${HELP}`);
  return 2;
}
