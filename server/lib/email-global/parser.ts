/**
 * mailparser wrapper — turns a raw RFC-5322 message into the normalised
 * shape the email ChatProvider expects.
 */
import { simpleParser, type ParsedMail, type Attachment } from "mailparser";

export interface ParsedInbound {
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  subject: string;
  from: string; // display address e.g. "Name <addr>"
  fromAddr: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  text: string;
  html: string | null;
  attachments: ParsedAttachment[];
  date: Date;
  /** Single recipient candidate strings — used for token extraction (To+Cc+Delivered-To). */
  deliveryRecipients: string[];
}

export interface ParsedAttachment {
  filename: string;
  mime: string;
  sizeBytes: number;
  content: Buffer;
  contentId: string | null;
}

export async function parseRfc822(source: Buffer | string): Promise<ParsedInbound> {
  const parsed: ParsedMail = await simpleParser(source);
  const fromAddrs = addressList(parsed.from);
  const to = addressList(parsed.to);
  const cc = addressList(parsed.cc);
  const bcc = addressList(parsed.bcc);

  const deliveryRecipients = new Set<string>([...to, ...cc]);
  const deliveredTo = parsed.headers.get("delivered-to");
  if (typeof deliveredTo === "string") deliveryRecipients.add(deliveredTo.toLowerCase());
  else if (Array.isArray(deliveredTo)) for (const x of deliveredTo) if (typeof x === "string") deliveryRecipients.add(x.toLowerCase());

  return {
    messageId: parsed.messageId ?? null,
    inReplyTo: typeof parsed.inReplyTo === "string" ? parsed.inReplyTo : null,
    references: Array.isArray(parsed.references) ? parsed.references.join(" ") : (parsed.references as string | undefined) ?? null,
    subject: parsed.subject ?? "(no subject)",
    from: parsed.from?.text ?? "",
    fromAddr: fromAddrs[0] ?? null,
    to,
    cc,
    bcc,
    text: parsed.text ?? "",
    html: typeof parsed.html === "string" ? parsed.html : null,
    attachments: parsed.attachments.map(toAttachment),
    date: parsed.date ?? new Date(),
    deliveryRecipients: [...deliveryRecipients],
  };
}

function addressList(field: ParsedMail["from"]): string[] {
  if (!field) return [];
  const items = Array.isArray(field) ? field : [field];
  const out: string[] = [];
  for (const grp of items) {
    for (const v of grp.value ?? []) {
      if (v.address) out.push(v.address.toLowerCase());
    }
  }
  return out;
}

function toAttachment(a: Attachment): ParsedAttachment {
  return {
    filename: a.filename ?? "attachment.bin",
    mime: a.contentType ?? "application/octet-stream",
    sizeBytes: a.size ?? a.content.length,
    content: a.content,
    contentId: a.contentId ?? null,
  };
}

/**
 * Strip quoted reply chains from a plain-text body so the model sees only
 * the user's new text. Lossy but acceptable — full body is still archived.
 */
export function stripQuotedReply(text: string): string {
  if (!text) return "";
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // "On Mon, 5 May 2026 12:34, Someone <x@y> wrote:" — Gmail/Apple/Outlook
    if (/^\s*On\s.+wrote:\s*$/i.test(line)) break;
    // "-----Original Message-----" — Outlook
    if (/^-----\s*Original Message\s*-----/i.test(line)) break;
    // First run of >-prefixed lines after blank line — generic quoted block.
    if (/^>/.test(line) && out.length > 0 && out[out.length - 1]!.trim() === "") break;
    out.push(line);
  }
  return out.join("\n").trimEnd();
}
