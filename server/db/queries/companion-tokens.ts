import { randomBytes, createHash } from "node:crypto";
import { db, generateId } from "@/db/index.ts";
import type { CompanionTokenRow } from "@/db/types.ts";

/**
 * Companion tokens authenticate a user-run `zero` companion (laptop-side
 * client) to a single project. Unlike the 7-day session JWT or the per-turn
 * Pi token, these are long-lived (30 days), project-scoped, and individually
 * revocable — the credential a companion presents to open its control tunnel
 * and to drive the project's control plane.
 *
 * The raw `cmp_…` value is the bearer secret and is shown to the user exactly
 * once, at creation. We never persist it: the DB stores only its SHA-256 hash
 * (so a DB/backup leak yields no usable credentials) plus a short display
 * prefix. Lookups hash the presented token and match on the hash.
 */

const TOKEN_PREFIX = "cmp_";

/** A freshly minted token, returned once at creation. `token` is the raw secret. */
export interface MintedCompanionToken extends CompanionTokenRow {
  token: string;
}

function generateTokenValue(): string {
  return TOKEN_PREFIX + randomBytes(24).toString("base64url");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Masked form for display, e.g. `cmp_AbCd…`. Derived from the raw token. */
function maskCompanionToken(token: string): string {
  const body = token.startsWith(TOKEN_PREFIX) ? token.slice(TOKEN_PREFIX.length) : token;
  return `${TOKEN_PREFIX}${body.slice(0, 4)}…`;
}

export function isCompanionToken(token: string): boolean {
  return token.startsWith(TOKEN_PREFIX);
}

const insertStmt = db.prepare(
  "INSERT INTO companion_tokens (id, user_id, project_id, token_hash, token_prefix, name) VALUES (?, ?, ?, ?, ?, ?) RETURNING *",
);

const byHashStmt = db.prepare(
  "SELECT * FROM companion_tokens WHERE token_hash = ?",
);

const byUserStmt = db.prepare(
  "SELECT * FROM companion_tokens WHERE user_id = ? ORDER BY created_at DESC",
);

const byIdStmt = db.prepare(
  "SELECT * FROM companion_tokens WHERE id = ?",
);

const touchStmt = db.prepare(
  "UPDATE companion_tokens SET last_connected_at = datetime('now') WHERE id = ?",
);

const deleteStmt = db.prepare(
  "DELETE FROM companion_tokens WHERE id = ? AND user_id = ?",
);

export function createCompanionToken(
  userId: string,
  projectId: string,
  name: string = "default",
): MintedCompanionToken {
  const id = generateId();
  const token = generateTokenValue();
  const row = insertStmt.get(
    id,
    userId,
    projectId,
    hashToken(token),
    maskCompanionToken(token),
    name,
  ) as CompanionTokenRow;
  return { ...row, token };
}

/**
 * Look up by raw token value (hashing it first). Returns null if unknown.
 * Expiry is NOT checked here. The hash match is exact, so the only timing
 * signal is over the 256-bit hash space — not exploitable.
 */
export function getCompanionTokenByValue(token: string): CompanionTokenRow | null {
  return (byHashStmt.get(hashToken(token)) as CompanionTokenRow | undefined) ?? null;
}

export function getCompanionTokenById(id: string): CompanionTokenRow | null {
  return (byIdStmt.get(id) as CompanionTokenRow | undefined) ?? null;
}

export function listCompanionTokensByUser(userId: string): CompanionTokenRow[] {
  return byUserStmt.all(userId) as CompanionTokenRow[];
}

export function touchCompanionToken(id: string): void {
  touchStmt.run(id);
}

/** Revoke a token, scoped to its owner. Returns true if a row was deleted. */
export function revokeCompanionToken(id: string, userId: string): boolean {
  return deleteStmt.run(id, userId).changes > 0;
}

/** True if the token's expiry is in the past. */
export function isCompanionTokenExpired(row: CompanionTokenRow): boolean {
  return new Date(`${row.expires_at}Z`).getTime() < Date.now();
}
