// AES-256-GCM encryption for credential secrets at rest.

const rawSecret = new TextEncoder().encode(
  process.env.CREDENTIALS_KEY ??
    process.env.JWT_SECRET ??
    `zero-agent-${process.env.DB_PATH ?? "./data/app.db"}`,
);

const keyMaterial = new Uint8Array(
  await crypto.subtle.digest("SHA-256", rawSecret),
);

const aesKey = await crypto.subtle.importKey(
  "raw",
  keyMaterial,
  { name: "AES-GCM" },
  false,
  ["encrypt", "decrypt"],
);

const IV_BYTES = 12;

export async function encrypt(plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, encoded),
  );
  const combined = new Uint8Array(IV_BYTES + ciphertext.byteLength);
  combined.set(iv);
  combined.set(ciphertext, IV_BYTES);
  return btoa(String.fromCharCode(...combined));
}

export async function decrypt(encrypted: string): Promise<string> {
  const combined = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, IV_BYTES);
  const ciphertext = combined.slice(IV_BYTES);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    aesKey,
    ciphertext,
  );
  return new TextDecoder().decode(decrypted);
}
