import { db } from "@/db/index.ts";

export function getSetting(key: string): string | null {
  const row = db.prepare(
    "SELECT value FROM settings WHERE key = ?"
  ).get(key) as { value: string } | undefined;
  if (row) return row.value;

  // Fall back to env var (convert key format: "openrouter_api_key" -> "OPENROUTER_API_KEY")
  const envKey = key.toUpperCase();
  return process.env[envKey] ?? null;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

export function getAllSettings(): Record<string, string> {
  const rows = db.prepare(
    "SELECT key, value FROM settings"
  ).all() as { key: string; value: string }[];
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

export function deleteSetting(key: string): void {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}
