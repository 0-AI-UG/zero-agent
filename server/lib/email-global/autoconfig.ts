/**
 * Best-effort IMAP/SMTP host discovery via Thunderbird's ISPDB.
 *
 * We probe the standard well-known endpoints; the first one that returns a
 * usable answer wins. If everything fails, the admin can fill in the hosts
 * manually under "Advanced".
 */
import { log } from "@/lib/utils/logger.ts";

const acLog = log.child({ module: "email/autoconfig" });

export type SecurityMode = "tls" | "starttls";

export interface DiscoveredEndpoint {
  host: string;
  port: number;
  secure: SecurityMode;
}

export interface DiscoveredConfig {
  imap: DiscoveredEndpoint | null;
  smtp: DiscoveredEndpoint | null;
  source: string;
}

export async function autoconfigure(emailAddress: string, signal?: AbortSignal): Promise<DiscoveredConfig | null> {
  const at = emailAddress.lastIndexOf("@");
  if (at < 0) return null;
  const domain = emailAddress.slice(at + 1).toLowerCase();
  if (!domain) return null;

  // Order matters: the ISPDB usually has the answer; the domain-hosted
  // autoconfig is sometimes wrong; common defaults are a last resort.
  const candidates = [
    { name: "ispdb", url: `https://autoconfig.thunderbird.net/v1.1/${encodeURIComponent(domain)}` },
    { name: "domain-autoconfig", url: `https://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(emailAddress)}` },
    { name: "well-known", url: `https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(emailAddress)}` },
  ];

  for (const c of candidates) {
    try {
      const res = await fetch(c.url, { signal, redirect: "follow" });
      if (!res.ok) continue;
      const xml = await res.text();
      const parsed = parseAutoconfigXml(xml, emailAddress);
      if (parsed.imap || parsed.smtp) {
        return { ...parsed, source: c.name };
      }
    } catch (err) {
      acLog.debug("autoconfig probe failed", { name: c.name, err: String(err) });
    }
  }

  // Final fallback: well-known guess for `mail.<domain>`.
  return {
    imap: { host: `mail.${domain}`, port: 993, secure: "tls" },
    smtp: { host: `mail.${domain}`, port: 465, secure: "tls" },
    source: "guess",
  };
}

/** Minimal extraction from Mozilla autoconfig XML — no DOM, just regex. */
export function parseAutoconfigXml(xml: string, emailAddress: string): { imap: DiscoveredEndpoint | null; smtp: DiscoveredEndpoint | null } {
  const imap = pickIncoming(xml, "imap", emailAddress);
  const smtp = pickOutgoing(xml, emailAddress);
  return { imap, smtp };
}

function pickIncoming(xml: string, type: "imap" | "pop3", emailAddress: string): DiscoveredEndpoint | null {
  const blockRe = new RegExp(`<incomingServer\\s+type="${type}"[\\s\\S]*?</incomingServer>`, "gi");
  for (const block of xml.matchAll(blockRe)) {
    const ep = extractEndpoint(block[0], emailAddress);
    if (ep) return ep;
  }
  return null;
}

function pickOutgoing(xml: string, emailAddress: string): DiscoveredEndpoint | null {
  const blockRe = /<outgoingServer\s+type="smtp"[\s\S]*?<\/outgoingServer>/gi;
  for (const block of xml.matchAll(blockRe)) {
    const ep = extractEndpoint(block[0], emailAddress);
    if (ep) return ep;
  }
  return null;
}

function extractEndpoint(block: string, emailAddress: string): DiscoveredEndpoint | null {
  const host = matchTag(block, "hostname");
  const portStr = matchTag(block, "port");
  const socketType = matchTag(block, "socketType")?.toLowerCase() ?? null;
  if (!host || !portStr) return null;
  const port = Number(portStr);
  if (!Number.isFinite(port)) return null;
  const secure: SecurityMode = socketType === "ssl" || socketType === "tls" || port === 993 || port === 465 ? "tls" : "starttls";
  return {
    host: substituteAddress(host, emailAddress),
    port,
    secure,
  };
}

function matchTag(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}>([^<]+)</${tag}>`, "i"));
  return m ? m[1]!.trim() : null;
}

function substituteAddress(template: string, emailAddress: string): string {
  const at = emailAddress.lastIndexOf("@");
  const local = at >= 0 ? emailAddress.slice(0, at) : emailAddress;
  const domain = at >= 0 ? emailAddress.slice(at + 1) : "";
  return template.replace(/%EMAILADDRESS%/g, emailAddress).replace(/%EMAILLOCALPART%/g, local).replace(/%EMAILDOMAIN%/g, domain);
}
