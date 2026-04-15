/**
 * Deployment-level feature flag for the CLI inference backends
 * (Claude Code + Codex). Read once at module load.
 *
 * When `ENABLE_CLI_BACKENDS` is unset or a falsy string, CLI model rows
 * are hidden from the user-facing model list and backend dispatch for
 * those rows falls back to OpenRouter. Admin-only listings (`getAllModels`)
 * are not affected — operators can still see and edit the rows.
 *
 * This flag is independent of the per-row `enabled` column in the `models`
 * table. Fresh deployments ship with `enabled = 0` on the CLI rows as a
 * second layer of safety; the flag is the kill switch an operator flips
 * per deployment after provisioning the image (which bundles the `claude`
 * and `codex` binaries — see runner/docker/session/Dockerfile).
 */

const CLI_INFERENCE_PROVIDERS = new Set(["claude-code", "codex"]);

function readFlag(): boolean {
  const raw = process.env.ENABLE_CLI_BACKENDS;
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

const ENABLED = readFlag();

export function cliBackendsEnabled(): boolean {
  return ENABLED;
}

export function isCliInferenceProvider(id: string | null | undefined): boolean {
  return !!id && CLI_INFERENCE_PROVIDERS.has(id);
}
