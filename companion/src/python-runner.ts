import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import type { WorkerResult } from "./worker-runner.ts";
import { readCapped } from "./workspace-utils.ts";
import { ensureUv } from "./uv-manager.ts";

const MAX_OUTPUT_BYTES = 1_048_576; // 1 MB

/**
 * Python bootstrap that patches file I/O so absolute paths (e.g. "/data.csv")
 * resolve relative to the working directory instead of the real filesystem root.
 */
const PYTHON_BOOTSTRAP = `
import builtins, os, pathlib, io

_cwd = os.getcwd()
_sep = os.sep

def _rewrite(p):
    """Rewrite an absolute path to be relative to cwd."""
    if isinstance(p, pathlib.PurePath):
        if p.is_absolute():
            return pathlib.Path(_cwd) / str(p).lstrip(_sep)
        return p
    if isinstance(p, str) and os.path.isabs(p):
        return os.path.join(_cwd, p.lstrip(_sep))
    if isinstance(p, bytes) and os.path.isabs(p):
        return os.path.join(_cwd.encode(), p.lstrip(_sep.encode()))
    return p

# Patch builtins.open (covers open(), pandas.read_csv, csv.reader, etc.)
_orig_open = builtins.open
def _open(file, *a, **kw):
    return _orig_open(_rewrite(file), *a, **kw)
builtins.open = _open

# Patch io.open
_orig_io_open = io.open
def _io_open(file, *a, **kw):
    return _orig_io_open(_rewrite(file), *a, **kw)
io.open = _io_open

# Patch pathlib.Path so Path("/data.csv").read_text() works
_orig_path_new = pathlib.Path.__new__
class _PatchedPath(type(pathlib.Path())):
    def __new__(cls, *args, **kw):
        obj = super().__new__(cls, *args, **kw)
        if obj.is_absolute():
            return super().__new__(cls, _cwd, str(obj).lstrip(_sep))
        return obj
pathlib.Path = _PatchedPath

# Patch os functions that take paths
for _fn_name in ('stat', 'lstat', 'listdir', 'scandir', 'access',
                  'chmod', 'remove', 'unlink', 'rename', 'replace',
                  'mkdir', 'makedirs', 'rmdir', 'removedirs',
                  'readlink', 'symlink'):
    _orig = getattr(os, _fn_name, None)
    if _orig is not None:
        def _make_patch(fn):
            def _patched(p, *a, **kw):
                return fn(_rewrite(p), *a, **kw)
            return _patched
        setattr(os, _fn_name, _make_patch(_orig))

for _fn_name in ('exists', 'isfile', 'isdir', 'islink', 'getsize',
                  'abspath', 'realpath', 'getmtime', 'getctime', 'getatime'):
    _orig = getattr(os.path, _fn_name, None)
    if _orig is not None:
        def _make_patch(fn):
            def _patched(p, *a, **kw):
                return fn(_rewrite(p), *a, **kw)
            return _patched
        setattr(os.path, _fn_name, _make_patch(_orig))

del _orig_open, _orig_io_open, _orig_path_new
`;

export async function runCodeInPython(
  workspaceDir: string,
  timeout: number,
  entrypoint: string,
): Promise<WorkerResult> {
  const uvPath = await ensureUv();
  const cwd = path.resolve(workspaceDir);
  const entrypointAbs = path.resolve(cwd, entrypoint);

  // Write a wrapper that bootstraps path rewriting then exec's the real script
  const tmpDir = path.join(cwd, ".tmp");
  await fs.mkdir(tmpDir, { recursive: true });
  const wrapperFile = path.join(tmpDir, `_bootstrap_${Date.now()}.py`);

  const wrapperCode =
    PYTHON_BOOTSTRAP +
    `\n# Run the actual script\n` +
    `import runpy as _runpy\n` +
    `_runpy.run_path(${JSON.stringify(entrypointAbs)}, run_name="__main__")\n`;

  await fs.writeFile(wrapperFile, wrapperCode);

  const venvPath = path.join(cwd, ".venv");
  const proc = Bun.spawn([uvPath, "run", wrapperFile], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: "1",
      UV_PYTHON_PREFERENCE: "only-managed",
      UV_CACHE_DIR: path.join(os.homedir(), ".companion", "uv", "cache"),
      VIRTUAL_ENV: venvPath,
    },
  });

  const timer = setTimeout(() => {
    proc.kill();
  }, timeout);

  try {
    const [stdout, stderr] = await Promise.all([
      readCapped(proc.stdout, MAX_OUTPUT_BYTES),
      readCapped(proc.stderr, MAX_OUTPUT_BYTES),
    ]);

    const exitCode = await proc.exited;
    clearTimeout(timer);

    return { stdout, stderr, exitCode };
  } catch (err) {
    clearTimeout(timer);
    const message = err instanceof Error ? err.message : String(err);
    return { stdout: "", stderr: message, exitCode: 1 };
  } finally {
    fs.unlink(wrapperFile).catch(() => {});
  }
}
