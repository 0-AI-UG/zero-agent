/**
 * Project email address helpers.
 *
 * Each project gets a unique URL-safe token. Inbound recipients land at
 * `<localPart>+<token>@<domain>` (RFC-5233 subaddressing); outbound mail
 * sets From/Reply-To to the same address so replies route back.
 */
import { nanoid } from "nanoid";

const TOKEN_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"; // no 0/1/o/l

export function mintProjectToken(): string {
  // 10 chars from a 32-char alphabet ≈ 50 bits — plenty for routing.
  let out = "";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  for (const b of bytes) out += TOKEN_ALPHABET[b % TOKEN_ALPHABET.length];
  return out;
}

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

/** Build the per-project address from the mailbox address + project token. */
export function buildProjectAddress(mailbox: string, token: string): string | null {
  const parts = splitAddress(mailbox);
  if (!parts) return null;
  // Strip any existing +tag on the configured mailbox so we don't compound.
  const base = parts.localPart.split("+", 1)[0]!;
  return `${base}+${token}@${parts.domain}`;
}

/** Extract a `+<token>` suffix from a single address. Returns null if none. */
export function parseToToken(addr: string): string | null {
  const parts = splitAddress(addr);
  if (!parts) return null;
  const plus = parts.localPart.indexOf("+");
  if (plus < 0) return null;
  const token = parts.localPart.slice(plus + 1);
  if (!token) return null;
  // Token shape: at least 6 url-safe chars; reject obvious non-tokens.
  if (!/^[a-z0-9_-]{4,}$/.test(token)) return null;
  return token;
}

/**
 * Find the first recipient address in the list that carries a `+token`
 * suffix on the configured local-part. Recipients lists from mailparser may
 * include To, Cc and a delivered-to hint.
 */
export function extractProjectToken(recipients: string[], mailbox: string | null): string | null {
  const baseLocal = mailbox ? splitAddress(mailbox)?.localPart.split("+", 1)[0] ?? null : null;
  const baseDomain = mailbox ? splitAddress(mailbox)?.domain ?? null : null;
  for (const r of recipients) {
    const parts = splitAddress(r);
    if (!parts) continue;
    if (baseDomain && parts.domain !== baseDomain) continue;
    const plus = parts.localPart.indexOf("+");
    if (plus < 0) continue;
    const local = parts.localPart.slice(0, plus);
    if (baseLocal && local !== baseLocal) continue;
    const token = parts.localPart.slice(plus + 1);
    if (/^[a-z0-9_-]{4,}$/.test(token)) return token;
  }
  return null;
}

/** Random nanoid suitable for an outbound Message-ID — not the project token. */
export function newMessageIdLocalPart(): string {
  return nanoid(24);
}
