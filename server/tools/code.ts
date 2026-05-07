import { z } from "zod";
import { tool } from "ai";
import { ensureBackend } from "@/lib/execution/lifecycle.ts";
import { markActivity } from "@/lib/execution/snapshot.ts";
import { log } from "@/lib/utils/logger.ts";
import { truncateText, stripBase64 } from "@/lib/conversation/truncate-result.ts";
import path from "node:path";

const toolLog = log.child({ module: "tool:code" });

const MAX_OUTPUT_CHARS = 8_000;

/**
 * Prevent path traversal - reject paths with `..` or leading `/`. Per-dir
 * filtering of "blob dirs" (node_modules, .venv, etc.) now happens in the
 * runner via gitignore-driven detection, so it's no longer needed here.
 */
function sanitizePath(p: string): string {
  const normalized = path.normalize(p);
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
    throw new Error(`Invalid file path: ${p}`);
  }
  return normalized;
}

// Keep sanitizePath available for other potential callers in this module.
void sanitizePath;


export function createCodeTools(
  userId: string,
  projectId: string,
) {
  async function getBackend() {
    const backend = await ensureBackend();
    if (!backend?.isReady()) {
      throw new Error("Code execution is not available. Docker may not be running.");
    }
    return backend;
  }

  return {
    bash: tool({
      description:
        "Run a bash command in the project workspace. The `zero` CLI is preinstalled - run `zero --help` to discover commands. Changed files auto-sync back. Output truncated to ~8KB.",
      inputSchema: z.object({
        command: z.string().describe("The bash command to execute"),
        timeout: z.number().optional().describe("Timeout in ms (default 120000, max 300000)"),
        background: z.boolean().optional().describe("Run the command as a background process. Returns immediately with the PID. Use for long-running servers and processes that should keep running."),
      }),
      execute: async ({ command, timeout, background }) => {
        toolLog.info("bash", { userId, projectId, command, background });

        try {
          const backend = await getBackend();
          await backend.ensureContainer(userId, projectId);
          markActivity(projectId);

          const result = await backend.runBash(
            userId,
            projectId,
            command,
            timeout,
            background,
          );

          if (!result || typeof result !== "object") {
            toolLog.error("bash: backend returned invalid result", null, { userId, projectId, result });
            return { error: `Backend returned invalid result: ${JSON.stringify(result)}` };
          }
          toolLog.info("bash result", {
            userId,
            projectId,
            exitCode: result.exitCode,
            stdoutLen: result.stdout?.length ?? 0,
            stderrLen: result.stderr?.length ?? 0,
          });

          const baseOutput = {
            stdout: truncateText(stripBase64(result.stdout), MAX_OUTPUT_CHARS),
            stderr: truncateText(stripBase64(result.stderr), MAX_OUTPUT_CHARS),
            exitCode: result.exitCode,
          };

          return baseOutput;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          toolLog.error("bash failed", err, { userId });
          return { error: message };
        }
      },
    }),
  };
}
