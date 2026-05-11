// AES-256-GCM encryption for credential secrets at rest.

function loadRawSecret(): string {
  const raw = process.env.CREDENTIALS_KEY;
  if (!raw || raw.length < 32) {
    throw new Error(
      "CREDENTIALS_KEY must be set to a string of at least 32 characters. Refusing to boot.",
    );
  }
  return raw;
}

const _buf = new TextEncoder().encode(loadRawSecret());
const keyMaterial = new Uint8Array(
  await crypto.subtle.digest("SHA-256", _buf.buffer.slice(_buf.byteOffset, _buf.byteOffset + _buf.byteLength) as ArrayBuffer),
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
