/**
 * Canonical notification kinds. Each kind is:
 *  - the logical event being announced
 *  - a subscription axis users can opt out of
 *
 * Note: `agent_message` is never dispatched as a notification - it's a normal
 * reply from the agent in the user's chat surface. It lives here only as a
 * stable identifier for subscription-grid UIs that may want to surface it.
 */
export const NOTIFICATION_KINDS = {
  CLI_REQUEST: "cli_request",
  TASK_COMPLETED: "task_completed",
  TASK_FAILED: "task_failed",
  AGENT_MESSAGE: "agent_message",
} as const;

export type NotificationKind =
  (typeof NOTIFICATION_KINDS)[keyof typeof NOTIFICATION_KINDS];

export const DEFAULT_NOTIFIABLE_KINDS: ReadonlySet<string> = new Set([
  NOTIFICATION_KINDS.CLI_REQUEST,
  NOTIFICATION_KINDS.TASK_COMPLETED,
  NOTIFICATION_KINDS.TASK_FAILED,
]);

export function isDispatchableKind(kind: string): boolean {
  // agent_message is explicitly not a notification - regular chat delivery
  // handles it.
  return kind !== NOTIFICATION_KINDS.AGENT_MESSAGE;
}
