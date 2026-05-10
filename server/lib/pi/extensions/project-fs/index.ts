/**
 * Project-FS Extension — confines Pi's built-in `read`, `write`, `edit`,
 * `grep`, `find`, and `ls` tools to the project directory.
 *
 * The bundled sandbox extension (examples/extensions/sandbox) only wraps
 * the `bash` tool. Pi's other filesystem tools call `node:fs` directly
 * inside the Pi process, so they have access to the entire host fs.
 * Zero is multi-user / multi-project on a single host: prompt-injected or
 * misbehaving turns must not be able to read or write outside their own
 * project dir.
 *
 * Mechanism: replace each tool with a wrapper that resolves the input
 * `path` (and `realpath`s it to follow symlinks) before delegating to the
 * default tool. If the resolved path escapes the project dir, the tool
 * call fails with a clear error rather than touching disk.
 *
 * "Project dir" is `process.cwd()`, set by `runTurn` when it spawns Pi.
 *
 * Pinned at startup, mirroring the bundled sandbox extension's pattern.
 */

import { realpathSync } from "node:fs";
import path from "node:path";
import {
  createReadTool,
  createWriteTool,
  createEditTool,
  createGrepTool,
  createFindTool,
  createLsTool,
  type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";

function realpathOrParent(absPath: string): string {
  try {
    return realpathSync(absPath);
  } catch {
    // Target may not exist yet (e.g. write to a new file). Resolve the
    // nearest existing ancestor and re-attach the remaining tail. This
    // still defeats `..` escapes and symlinked-parent escapes; only the
    // basename is unresolved, which is fine for path-confinement purposes.
    const parent = path.dirname(absPath);
    if (parent === absPath) return absPath;
    return path.join(realpathOrParent(parent), path.basename(absPath));
  }
}

function ensureInProject(
  projectDir: string,
  inputPath: string,
  toolName: string,
): void {
  const abs = path.isAbsolute(inputPath)
    ? inputPath
    : path.resolve(projectDir, inputPath);
  const resolved = realpathOrParent(abs);
  if (resolved !== projectDir && !resolved.startsWith(projectDir + path.sep)) {
    throw new Error(
      `${toolName}: path "${inputPath}" escapes project dir (${projectDir})`,
    );
  }
}

export default function (pi: ExtensionAPI) {
  // Pinned at extension load. runTurn sets cwd = projectDir before spawning
  // Pi, so process.cwd() here is the project root.
  const projectDir = realpathSync(process.cwd());

  const read = createReadTool(projectDir);
  const write = createWriteTool(projectDir);
  const edit = createEditTool(projectDir);
  const grep = createGrepTool(projectDir);
  const find = createFindTool(projectDir);
  const ls = createLsTool(projectDir);

  pi.registerTool({
    ...read,
    label: "read (project-scoped)",
    async execute(id, params, signal, onUpdate, _ctx) {
      ensureInProject(projectDir, params.path, "read");
      return read.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...write,
    label: "write (project-scoped)",
    async execute(id, params, signal, onUpdate, _ctx) {
      ensureInProject(projectDir, params.path, "write");
      return write.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...edit,
    label: "edit (project-scoped)",
    async execute(id, params, signal, onUpdate, _ctx) {
      ensureInProject(projectDir, params.path, "edit");
      return edit.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...grep,
    label: "grep (project-scoped)",
    async execute(id, params, signal, onUpdate, _ctx) {
      if (params.path) ensureInProject(projectDir, params.path, "grep");
      return grep.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...find,
    label: "find (project-scoped)",
    async execute(id, params, signal, onUpdate, _ctx) {
      if (params.path) ensureInProject(projectDir, params.path, "find");
      return find.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...ls,
    label: "ls (project-scoped)",
    async execute(id, params, signal, onUpdate, _ctx) {
      if (params.path) ensureInProject(projectDir, params.path, "ls");
      return ls.execute(id, params, signal, onUpdate);
    },
  });
}
