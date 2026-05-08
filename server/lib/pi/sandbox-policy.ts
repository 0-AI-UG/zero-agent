/**
 * Per-turn sandbox policy. One place that knows which paths/domains a
 * Pi turn may touch.
 *
 * The same struct is consumed by:
 *   1. `SandboxManager.initialize(...)` — wraps the bash tool's child
 *      shell on macOS (sandbox-exec) and Linux (bubblewrap).
 *   2. (Session 3) the path-checking tool extension that gates Pi's
 *      built-in `read`/`write`/`edit`/`grep`/`find`/`ls`. The reference
 *      sandbox extension does NOT cover those — see pi-migration.md §2.
 *
 * Project dir is the only filesystem area the agent gets read+write on.
 * `/tmp` is allowed for transient build artifacts. The per-turn unix
 * socket path is included in `allowUnixSockets` so the in-sandbox
 * `zero` CLI can reach Zero's API; on Linux the controlling factor is
 * the bwrap bind-mount, not seccomp.
 */

export interface PiSandboxPolicyInput {
  projectDir: string;
  socketDir: string;
  /** Network domains the agent's bash is allowed to reach. Default deny. */
  allowedDomains?: string[];
}

export interface PiSandboxPolicy {
  filesystem: {
    denyRead: string[];
    allowWrite: string[];
    denyWrite: string[];
  };
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
    allowUnixSockets: string[];
  };
}

/** Default network allowlist for v1: package registries + git hosts. */
export const DEFAULT_ALLOWED_DOMAINS: readonly string[] = [
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "github.com",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
  "registry-1.docker.io",
];

export function buildPiSandboxPolicy(
  input: PiSandboxPolicyInput,
): PiSandboxPolicy {
  return {
    filesystem: {
      denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
      allowWrite: [input.projectDir, input.socketDir, "/tmp"],
      denyWrite: [".env", "*.pem", "*.key"],
    },
    network: {
      allowedDomains: [...(input.allowedDomains ?? DEFAULT_ALLOWED_DOMAINS)],
      deniedDomains: [],
      allowUnixSockets: [input.socketDir],
    },
  };
}
