/**
 * Email address helpers.
 *
 * With per-project mailboxes there's no subaddressing — each project owns
 * a real address. These helpers are limited to splitting addresses and
 * minting outbound Message-IDs.
 */
import { nanoid } from "nanoid";

export interface MailboxAddress {
  localPart: string;
  domain: string;
}

/** Split user@domain into parts (lowercased). Returns null on garbage. */
export function splitAddress(addr: string): MailboxAddress | null {
  const trimmed = addr.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return null;
  return { localPart: trimmed.slice(0, at), domain: trimmed.slice(at + 1) };
}

/** Random nanoid suitable for an outbound Message-ID. */
export function newMessageIdLocalPart(): string {
  return nanoid(24);
}
