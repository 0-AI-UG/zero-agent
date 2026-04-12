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
