/**
 * ChatProvider abstraction - a channel that can receive incoming user
 * messages, run them through `runAgentStepBatch`, and send replies plus
 * out-of-band notifications.
 *
 * Telegram is the first implementation. Web chat stays on its own streaming
 * path and does not implement this interface; providers here are non-web
 * surfaces that want agent parity with the chat UI.
 */
export type ChatProviderName = "telegram" | "discord" | "slack" | "email";

export interface ProviderIncomingMessage {
  /** Provider-specific update / payload object. */
  raw: unknown;
}

export interface ProviderSendContent {
  text: string;
}

export interface ProviderSendResult {
  ok: boolean;
  /** Provider-native message id (e.g. Telegram message_id). */
  messageId?: string | number;
  error?: string;
}

export interface NotificationPayload {
  pendingResponseId: string | null;
  title: string;
  body: string;
  url?: string;
  actions?: { id: string; label: string }[];
  /** Project this notification is for. Required for email delivery (per-project mailbox). */
  projectId?: string | null;
}

export interface LinkCodeResult {
  code: string;
  instructions: string;
  expiresIn: number;
}

export interface ChatProvider {
  readonly name: ChatProviderName;

  /** Whether the provider is configured/available at all (token set, etc.). */
  isAvailable(): boolean;

  /** Whether a given user has linked their account on this provider. */
  isLinkedForUser(userId: string): boolean;

  /** Webhook/poller entry point - resolve user, route commands, run agent, reply. */
  handleIncoming(msg: ProviderIncomingMessage): Promise<void>;

  /** Regular agent reply. */
  send(userId: string, content: ProviderSendContent): Promise<ProviderSendResult>;

  /** Special notification format with optional response wiring. */
  sendNotification(
    userId: string,
    payload: NotificationPayload
  ): Promise<ProviderSendResult>;

  /** Generate a short-lived link code for a user to bind their account. */
  createLinkCode?(userId: string): Promise<LinkCodeResult>;

  /** Remove a user's link with this provider. */
  unlink?(userId: string): Promise<void>;
}
