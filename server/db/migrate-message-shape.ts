import type Database from "better-sqlite3";
import { checkpointEntriesToMessages, isCanonicalMessage, legacyUiMessageToMessage } from "@/lib/messages/converters.ts";
import type { Message } from "@/lib/messages/types.ts";
import { log } from "@/lib/utils/logger.ts";

const migrationLog = log.child({ module: "db:migrate-message-shape" });
const MIGRATION_KEY = "message_shape_canonical_v1";

interface StoredMessageRow {
  id: string;
  role: string;
  content: string;
}

interface StoredCheckpointRow {
  run_id: string;
  messages: string;
}

export function runMessageShapeMigration(db: Database.Database): void {
  const done = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(MIGRATION_KEY) as { value?: string } | undefined;
  if (done?.value === "done") return;

  const messageRows = db.prepare("SELECT id, role, content FROM messages").all() as StoredMessageRow[];
  const checkpointRows = db
    .prepare("SELECT run_id, messages FROM agent_checkpoints")
    .all() as StoredCheckpointRow[];

  const updateMessage = db.prepare("UPDATE messages SET role = ?, content = ? WHERE id = ?");
  const updateCheckpoint = db.prepare("UPDATE agent_checkpoints SET messages = ? WHERE run_id = ?");
  const markDone = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );

  let updatedMessages = 0;
  let updatedCheckpoints = 0;
  let failures = 0;

  db.transaction(() => {
    for (const row of messageRows) {
      const parsed = safeJsonParse(row.content);
      if (parsed == null) {
        failures += 1;
        migrationLog.warn("message row has invalid JSON", { messageId: row.id });
        continue;
      }

      const canonical = normalizeStoredMessage(parsed);
      if (!canonical) {
        failures += 1;
        migrationLog.warn("message row could not be converted", {
          messageId: row.id,
          role: row.role,
        });
        continue;
      }

      const nextContent = JSON.stringify(canonical);
      if (nextContent !== row.content || canonical.role !== row.role) {
        updateMessage.run(canonical.role, nextContent, row.id);
        updatedMessages += 1;
      }
    }

    for (const row of checkpointRows) {
      const parsed = safeJsonParse(row.messages);
      const canonical = checkpointEntriesToMessages(parsed);
      if (!Array.isArray(parsed)) {
        failures += 1;
        migrationLog.warn("checkpoint payload is not an array", { runId: row.run_id });
        continue;
      }
      if (parsed.length > 0 && canonical.length === 0) {
        failures += 1;
        migrationLog.warn("checkpoint payload could not be converted", {
          runId: row.run_id,
          entryCount: parsed.length,
        });
        continue;
      }

      const nextMessages = JSON.stringify(canonical);
      if (nextMessages !== row.messages) {
        updateCheckpoint.run(nextMessages, row.run_id);
        updatedCheckpoints += 1;
      }
    }

    if (failures === 0) {
      markDone.run(MIGRATION_KEY, "done");
    }
  })();

  if (updatedMessages || updatedCheckpoints || failures) {
    migrationLog.info("message-shape migration checked", {
      updatedMessages,
      updatedCheckpoints,
      failures,
      complete: failures === 0,
    });
  }
}

function normalizeStoredMessage(value: unknown): Message | null {
  if (isCanonicalMessage(value)) return value;
  return legacyUiMessageToMessage(value);
}

function safeJsonParse(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
