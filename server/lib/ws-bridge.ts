import { events } from "@/lib/events.ts";
import { broadcastToProject, broadcastPresence, setStreamingUser, clearStreamingUser } from "@/lib/ws.ts";
import { sendPushToUser } from "@/lib/web-push.ts";
import { getProjectMembers } from "@/db/queries/members.ts";

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

/**
 * Bridge background agent events to WebSocket.
 */
export function startBackgroundBridge() {
  events.on("background.completed", ({ runId, projectId, chatId, taskName, summary }) => {
    broadcastToProject(projectId, {
      type: "background.completed",
      runId,
      chatId,
      taskName,
      summary: summary.slice(0, 500),
    });

    const members = getProjectMembers(projectId);
    for (const member of members) {
      sendPushToUser(member.user_id, {
        title: `Task completed: ${taskName}`,
        body: summary.slice(0, 200),
        url: `/projects/${projectId}/c/${chatId}`,
        tag: `bg-${runId}`,
      }).catch(() => {});
    }
  });

  events.on("background.failed", ({ runId, projectId, chatId, taskName, error }) => {
    broadcastToProject(projectId, {
      type: "background.failed",
      runId,
      chatId,
      taskName,
      error,
    });

    const members = getProjectMembers(projectId);
    for (const member of members) {
      sendPushToUser(member.user_id, {
        title: `Task failed: ${taskName}`,
        body: error.slice(0, 200),
        url: `/projects/${projectId}/c/${chatId}`,
        tag: `bg-${runId}`,
      }).catch(() => {});
    }
  });
}

/**
 * Called from chat.ts when a stream starts. Broadcasts to the project room
 * and tracks the streaming user for presence.
 */
export function notifyStreamStarted(projectId: string, chatId: string, userId: string, username: string) {
  setStreamingUser(chatId, userId, username);
  broadcastToProject(projectId, { type: "stream.started", chatId, userId, username });
  broadcastPresence(projectId);
}

/**
 * Called from chat.ts when a stream ends. Clears streaming state and notifies.
 */
export function notifyStreamEnded(projectId: string, chatId: string) {
  clearStreamingUser(chatId);
  broadcastToProject(projectId, { type: "stream.ended", chatId });
  broadcastPresence(projectId);
}
