import { randomBytes, randomInt } from "node:crypto";
import { db, generateId } from "@/db/index.ts";
import type { DeviceAuthRequestRow } from "@/db/types.ts";

/**
 * Device-authorization requests back the `zero login` device flow (RFC 8628
 * style). The CLI creates one and polls with the secret `device_code`; the user
 * approves it in the web app by typing the short `user_code` and choosing a
 * project, at which point a project-scoped companion token is minted and bound
 * to the request. Requests are short-lived (10 min) and consumed once the token
 * is delivered.
 *
 * The `device_code` is the capability the CLI holds, so it is high-entropy. The
 * `user_code` is the human-typed handle — only 6 digits — so its safety leans on
 * the short expiry plus per-user rate limiting on the lookup/approve routes.
 */

function generateDeviceCode(): string {
  return randomBytes(32).toString("base64url");
}

/** A 6-digit numeric code, zero-padded (e.g. "049281"). */
function generateUserCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

const insertStmt = db.prepare(
  "INSERT INTO device_auth_requests (id, device_code, user_code, device_name) VALUES (?, ?, ?, ?) RETURNING *",
);

const byDeviceCodeStmt = db.prepare(
  "SELECT * FROM device_auth_requests WHERE device_code = ?",
);

const byUserCodeStmt = db.prepare(
  "SELECT * FROM device_auth_requests WHERE user_code = ?",
);

const approveStmt = db.prepare(
  "UPDATE device_auth_requests SET status = 'approved', user_id = ?, project_id = ?, token_id = ?, minted_token = ? WHERE id = ?",
);

const denyStmt = db.prepare(
  "UPDATE device_auth_requests SET status = 'denied' WHERE id = ?",
);

const deleteStmt = db.prepare("DELETE FROM device_auth_requests WHERE id = ?");

const pruneExpiredStmt = db.prepare(
  "DELETE FROM device_auth_requests WHERE expires_at < datetime('now')",
);

/**
 * Create a pending request. Retries on the (vanishingly rare) user_code
 * collision so the 6-digit space never blocks a login.
 */
export function createDeviceAuthRequest(deviceName: string | null): DeviceAuthRequestRow {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return insertStmt.get(
        generateId(),
        generateDeviceCode(),
        generateUserCode(),
        deviceName,
      ) as DeviceAuthRequestRow;
    } catch (err) {
      // UNIQUE collision on user_code/device_code — try a fresh pair.
      if (attempt === 4) throw err;
    }
  }
  // Unreachable; the loop either returns or throws on the last attempt.
  throw new Error("could not allocate a device code");
}

export function getDeviceAuthByDeviceCode(deviceCode: string): DeviceAuthRequestRow | null {
  return (byDeviceCodeStmt.get(deviceCode) as DeviceAuthRequestRow | undefined) ?? null;
}

export function getDeviceAuthByUserCode(userCode: string): DeviceAuthRequestRow | null {
  return (byUserCodeStmt.get(userCode) as DeviceAuthRequestRow | undefined) ?? null;
}

export function approveDeviceAuthRequest(
  id: string,
  userId: string,
  projectId: string,
  tokenId: string,
  mintedToken: string,
): void {
  approveStmt.run(userId, projectId, tokenId, mintedToken, id);
}

export function denyDeviceAuthRequest(id: string): void {
  denyStmt.run(id);
}

/** Consume a request (after its token has been delivered to the CLI). */
export function deleteDeviceAuthRequest(id: string): void {
  deleteStmt.run(id);
}

/** Delete every expired request (pending, denied, or approved-but-never-polled). */
export function pruneExpiredDeviceAuthRequests(): number {
  return pruneExpiredStmt.run().changes;
}

/** True if the request's expiry is in the past. */
export function isDeviceAuthExpired(row: DeviceAuthRequestRow): boolean {
  return new Date(`${row.expires_at}Z`).getTime() < Date.now();
}
