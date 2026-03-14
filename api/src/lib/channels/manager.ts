import { log } from "@/lib/logger.ts";
import { getEnabledChannels } from "@/db/queries/channels.ts";
import { TelegramAdapter } from "./adapters/telegram.ts";
import { createMessageHandler } from "./router.ts";
import type { ChannelAdapter, ChannelConfig, ChannelPlatform, ChannelStatus } from "./types.ts";
import type { ChannelRow } from "@/db/types.ts";

const mgrLog = log.child({ module: "channel-manager" });

function createAdapter(platform: ChannelPlatform): ChannelAdapter {
  switch (platform) {
    case "telegram":
      return new TelegramAdapter();
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}

function rowToConfig(row: ChannelRow): ChannelConfig {
  return {
    id: row.id,
    projectId: row.project_id,
    platform: row.platform as ChannelPlatform,
    name: row.name,
    credentials: JSON.parse(row.credentials || "{}"),
    allowedSenders: JSON.parse(row.allowed_senders || "[]"),
    enabled: row.enabled === 1,
  };
}

class ChannelManager {
  private adapters = new Map<string, ChannelAdapter>();

  async startAll(): Promise<void> {
    const channels = getEnabledChannels();
    mgrLog.info("starting all enabled channels", { count: channels.length });
    for (const channel of channels) {
      try {
        await this.startChannel(rowToConfig(channel));
      } catch (err) {
        mgrLog.error("failed to start channel", err, { channelId: channel.id, platform: channel.platform });
      }
    }
  }

  async startChannel(config: ChannelConfig): Promise<void> {
    // Stop existing adapter if running
    if (this.adapters.has(config.id)) {
      await this.stopChannel(config.id);
    }

    const adapter = createAdapter(config.platform);
    const handler = createMessageHandler(config.id, adapter);
    adapter.onMessage(handler);

    await adapter.start(config);
    this.adapters.set(config.id, adapter);
    mgrLog.info("channel started", { channelId: config.id, platform: config.platform });
  }

  async stopChannel(id: string): Promise<void> {
    const adapter = this.adapters.get(id);
    if (adapter) {
      await adapter.stop();
      this.adapters.delete(id);
      mgrLog.info("channel stopped", { channelId: id });
    }
  }

  async restartChannel(config: ChannelConfig): Promise<void> {
    await this.stopChannel(config.id);
    await this.startChannel(config);
  }

  getStatus(id: string): ChannelStatus {
    const adapter = this.adapters.get(id);
    if (!adapter) {
      return { connected: false, platform: "telegram" };
    }
    return adapter.getStatus();
  }

  getQrCode(id: string): string | null {
    const adapter = this.adapters.get(id);
    return adapter?.getQrCode?.() ?? null;
  }

  isRunning(id: string): boolean {
    return this.adapters.has(id);
  }
}

export const channelManager = new ChannelManager();
