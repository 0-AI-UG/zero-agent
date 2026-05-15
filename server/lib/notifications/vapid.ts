import { getSetting, setSetting } from "@/lib/settings.ts";
// @ts-ignore - web-push has no type declarations
import webpush from "web-push";

let cached: { publicKey: string; privateKey: string } | null = null;

export function getVapidKeys(): { publicKey: string; privateKey: string } {
  if (cached) return cached;

  const pub = getSetting("vapid_public_key");
  const priv = getSetting("vapid_private_key");

  if (pub && priv) {
    cached = { publicKey: pub, privateKey: priv };
    return cached;
  }

  const keys = webpush.generateVAPIDKeys();
  setSetting("vapid_public_key", keys.publicKey);
  setSetting("vapid_private_key", keys.privateKey);
  cached = { publicKey: keys.publicKey, privateKey: keys.privateKey };
  return cached;
}

/**
 * Resolve the VAPID JWT `sub` claim. Apple's APNs WebPush gateway rejects
 * subjects containing `localhost` (silent 403), so prefer:
 *   1. `vapid_subject` setting, if it's a real-looking mailto:/https: URI
 *   2. derived from `APP_URL` env (`mailto:admin@<host>`)
 *   3. fallback `mailto:admin@example.com` — still bad, but at least valid
 *      enough that Apple won't reject on the subject alone
 */
export function getVapidSubject(): string {
  const setting = (getSetting("vapid_subject") || "").trim();
  if (isValidVapidSubject(setting)) return setting;

  const appUrl = (process.env.APP_URL || "").trim();
  if (appUrl) {
    try {
      const host = new URL(appUrl).hostname;
      if (host && host !== "localhost" && !host.startsWith("127.")) {
        return `mailto:admin@${host}`;
      }
    } catch { /* fall through */ }
  }

  return "mailto:admin@example.com";
}

function isValidVapidSubject(value: string): boolean {
  if (!value) return false;
  if (value.includes("localhost") || value.includes("127.0.0.1")) return false;
  if (value.startsWith("mailto:") && /@[^@\s]+\.[^@\s]+$/.test(value)) return true;
  if (value.startsWith("https://")) {
    try { new URL(value); return true; } catch { return false; }
  }
  return false;
}
