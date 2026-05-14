import { events } from "@/lib/tasks/events.ts";
import { broadcastToProject } from "@/lib/http/ws.ts";
import { getFileByPath } from "@/db/queries/files.ts";
import { toUTC } from "@/routes/utils.ts";

// Mirror routes/files.ts:formatFile so the client can patch its cache
// directly from the WS payload (no follow-up refetch needed).
function lookupFile(projectId: string, folderPath: string, filename: string) {
  const row = getFileByPath(projectId, folderPath, filename);
  if (!row) return undefined;
  return {
    id: row.id,
    projectId: row.project_id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    folderPath: row.folder_path,
    createdAt: toUTC(row.created_at),
  };
}

/**
 * Bridges the in-memory EventBus to WebSocket broadcasts.
 * Call once at startup after the WS server is attached.
 */
export function startWsBridge() {
  events.on("chat.created", ({ chatId, projectId, title }) => {
    broadcastToProject(projectId, { type: "chat.created", chatId, title });
  });

  events.on("chat.deleted", ({ chatId, projectId }) => {
    broadcastToProject(projectId, { type: "chat.deleted", chatId });
  });

  events.on("message.received", ({ chatId, projectId, userId }) => {
    broadcastToProject(projectId, { type: "message.received", chatId, userId });
  });

  events.on("message.sent", ({ chatId, projectId }) => {
    broadcastToProject(projectId, { type: "message.sent", chatId });
  });

  events.on("file.created", ({ projectId, path, filename }) => {
    const file = lookupFile(projectId, path, filename);
    broadcastToProject(projectId, { type: "file.changed", path, filename, action: "created", file });
  });

  events.on("file.updated", ({ projectId, path, filename }) => {
    const file = lookupFile(projectId, path, filename);
    broadcastToProject(projectId, { type: "file.changed", path, filename, action: "updated", file });
  });

  events.on("file.deleted", ({ projectId, path, filename }) => {
    broadcastToProject(projectId, { type: "file.changed", path, filename, action: "deleted" });
  });
}

