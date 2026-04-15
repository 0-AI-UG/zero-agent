/**
 * Shared types for per-user CLI subscription authentication (Claude Code, Codex).
 */

export type CliAuthProvider = "claude" | "codex";

export type CliAuthFrame =
  | { type: "stdout"; data: string }
  | { type: "exit"; code: number }
  | { type: "error"; message: string }
  | { type: "session"; sessionId: string };

export interface CliAuthStatus {
  provider: CliAuthProvider;
  authenticated: boolean;
  expiresAt?: number;
  /** Human-readable account identifier (email / org / login) when known. */
  account?: string;
  /** Last time we successfully verified auth against the provider. */
  lastVerifiedAt?: number;
}
