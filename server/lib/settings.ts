import { db } from "@/db/index.ts";

export function getSetting(key: string): string | null {
  const row = db.query<{ value: string }, [string]>(
    "SELECT value FROM settings WHERE key = ?"
  ).get(key);
  if (row) return row.value;

  // Fall back to env var (convert key format: "openrouter_api_key" -> "OPENROUTER_API_KEY")
  const envKey = key.toUpperCase();
  return process.env[envKey] ?? null;
}

export function setSetting(key: string, value: string): void {
  db.run(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value]
  );
}

export function getAllSettings(): Record<string, string> {
  const rows = db.query<{ key: string; value: string }, []>(
    "SELECT key, value FROM settings"
  ).all();
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

export function deleteSetting(key: string): void {
  db.run("DELETE FROM settings WHERE key = ?", [key]);
}
