import { events } from "@/lib/scheduling/events.ts";
import { broadcastToProject } from "@/lib/http/ws.ts";

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
    broadcastToProject(projectId, { type: "file.changed", path, filename, action: "created" });
  });

  events.on("file.updated", ({ projectId, path, filename }) => {
    broadcastToProject(projectId, { type: "file.changed", path, filename, action: "updated" });
  });

  events.on("file.deleted", ({ projectId, path, filename }) => {
    broadcastToProject(projectId, { type: "file.changed", path, filename, action: "deleted" });
  });
}

