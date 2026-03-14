export type ChannelPlatform = "telegram";

export interface ChannelConfig {
  id: string;
  projectId: string;
  platform: ChannelPlatform;
  name: string;
  credentials: Record<string, string>;
  allowedSenders: string[];
  enabled: boolean;
}

export interface ChannelStatus {
  connected: boolean;
  platform: ChannelPlatform;
  error?: string;
  lastMessageAt?: string;
}

export interface InboundMessage {
  platform: ChannelPlatform;
  externalChatId: string;
  senderIdentifier: string;
  text: string;
  mediaType?: string;
  mediaUrl?: string;
  timestamp: number;
  rawPayload?: unknown;
}

export interface OutboundMessage {
  text: string;
  mediaUrl?: string;
}

export type MessageHandler = (msg: InboundMessage) => Promise<void>;

export interface ChannelAdapter {
  platform: ChannelPlatform;
  start(config: ChannelConfig): Promise<void>;
  stop(): Promise<void>;
  send(externalChatId: string, message: OutboundMessage): Promise<void>;
  getStatus(): ChannelStatus;
  getQrCode?(): string | null;
  onMessage(handler: MessageHandler): void;
}
