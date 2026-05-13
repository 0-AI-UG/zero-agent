/**
 * Email threading helpers (RFC-5322 Message-ID / In-Reply-To / References).
 *
 * thread_key is the message-id at the root of the conversation — derived
 * from the deepest reference if available, otherwise from In-Reply-To, or
 * else this message's own Message-ID.
 */

export function parseReferenceIds(refsHeader: string | null | undefined): string[] {
  if (!refsHeader) return [];
  // References is whitespace-separated <id> tokens. Be lenient.
  const matches = refsHeader.match(/<[^>]+>/g) ?? [];
  return matches.map((m) => m.toLowerCase());
}

export function normaliseMessageId(id: string | null | undefined): string | null {
  if (!id) return null;
  const trimmed = id.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) return trimmed;
  return `<${trimmed.replace(/^<|>$/g, "")}>`;
}

export interface ThreadingHeaders {
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
}

export function deriveThreadKey(h: ThreadingHeaders): string {
  const refs = parseReferenceIds(h.references);
  if (refs.length > 0) return refs[0]!;
  const inReplyTo = normaliseMessageId(h.inReplyTo);
  if (inReplyTo) return inReplyTo;
  const own = normaliseMessageId(h.messageId);
  if (own) return own;
  // Fallback for truly broken mail — synth a key so the message is still indexable.
  return `<orphan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}>`;
}

/** Compose References for an outbound reply to `parent`, capped at 8 ids. */
export function buildOutboundReferences(parent: ThreadingHeaders): {
  inReplyTo: string | null;
  references: string | null;
} {
  const parentMsgId = normaliseMessageId(parent.messageId);
  const parentRefs = parseReferenceIds(parent.references);
  const chain = [...parentRefs];
  if (parentMsgId && !chain.includes(parentMsgId)) chain.push(parentMsgId);
  const capped = chain.slice(-8);
  return {
    inReplyTo: parentMsgId,
    references: capped.length > 0 ? capped.join(" ") : null,
  };
}
