import { launchChrome } from "./chrome-launcher.ts";
import { type CdpClient, connectToPage, extractPort } from "./cdp.ts";
import { createWsClient } from "./ws-client.ts";
import { discoverChrome } from "./chrome-discovery.ts";
import { createLogger } from "./logger.ts";
import { isFirstRun, printStartupInfo } from "./first-run.ts";
import type { ActivityEvent } from "./shared/rpc.ts";

const CDP_RECONNECT_BASE = 2000;
const CDP_RECONNECT_MAX = 30000;
const CDP_HEALTH_INTERVAL = 10_000;

export interface CompanionOptions {
  token: string;
  server?: string;
  profile?: string;
  cdpUrl?: string;
  chrome?: string;
  port?: number;
  headless?: boolean;
  verbose?: boolean;
  onEvent?: (event: ActivityEvent) => void;
}

export async function startCompanion(opts: CompanionOptions) {
  const server = opts.server ?? "http://localhost:3000";
  const profile = opts.profile ?? "default";
  const headless = opts.headless ?? false;
  const verbose = opts.verbose ?? false;

  const logger = createLogger(verbose);
  const firstRun = isFirstRun(profile);

  const chromePath = opts.chrome ?? discoverChrome();

  await printStartupInfo({
    logger,
    chromePath,
    profile,
    port: opts.port,
    serverUrl: server,
    headless,
    firstRun,
  });

  let currentCdp: CdpClient | null = null;
  let cdpPort: number;
  let cdpReconnecting = false;
  let cdpHealthTimer: ReturnType<typeof setInterval> | null = null;
  let defaultRefMap = new Map<string, { role: string; name: string; backendNodeId: number }>();

  async function establishCdp(): Promise<void> {
    let cdpUrl: string;
    if (opts.cdpUrl) {
      cdpUrl = opts.cdpUrl;
      logger.debug(`Using provided CDP URL: ${cdpUrl}`);
    } else {
      logger.debug("Launching Chrome...");
      const launch = await launchChrome({
        profile,
        chromePath: opts.chrome,
        port: opts.port,
        headless,
      });
      cdpUrl = launch.cdpUrl;
      if (launch.reused) {
        logger.success("Reused existing Chrome instance");
      } else {
        logger.success("Chrome launched");
      }
    }

    cdpPort = extractPort(cdpUrl);
    logger.debug(`Connecting to Chrome CDP on port ${cdpPort}...`);
    const { cdp } = await connectToPage(cdpPort);
    logger.success("Connected to Chrome via CDP");

    cdp.onClose = () => {
      logger.error("Chrome CDP connection lost");
      currentCdp = null;
      scheduleReconnect();
    };

    currentCdp = cdp;
    startHealthCheck();
  }

  function startHealthCheck() {
    if (cdpHealthTimer) clearInterval(cdpHealthTimer);
    cdpHealthTimer = setInterval(async () => {
      if (!currentCdp || !currentCdp.connected) return;
      try {
        await currentCdp.send("Runtime.evaluate", {
          expression: "1",
          returnByValue: true,
        });
      } catch {
        logger.error("Chrome health check failed");
        currentCdp?.close();
        currentCdp = null;
        scheduleReconnect();
      }
    }, CDP_HEALTH_INTERVAL);
  }

  function scheduleReconnect() {
    if (cdpReconnecting) return;
    cdpReconnecting = true;
    if (cdpHealthTimer) {
      clearInterval(cdpHealthTimer);
      cdpHealthTimer = null;
    }

    let delay = CDP_RECONNECT_BASE;

    async function attempt() {
      logger.info(`Attempting to reconnect to Chrome in ${delay / 1000}s...`);
      await new Promise((r) => setTimeout(r, delay));

      try {
        await establishCdp();
        cdpReconnecting = false;
        logger.success("Reconnected to Chrome");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Chrome reconnect failed: ${msg}`);
        delay = Math.min(delay * 2, CDP_RECONNECT_MAX);
        attempt();
      }
    }

    attempt();
  }

  await establishCdp();

  const client = await createWsClient({
    serverUrl: server,
    token: opts.token,
    logger,
    getCdp: () => {
      if (!currentCdp || !currentCdp.connected) {
        throw new Error("Chrome is not connected (restarting/crashed). Retrying shortly...");
      }
      return currentCdp;
    },
    getDefaultRefMap: () => defaultRefMap,
    cdpPort: cdpPort!,
    onConnected: () => {
      logger.success(`Connected to ${server}. Chrome is ready. Keep this running.`);
    },
    onDisconnected: () => {
      logger.info("Disconnected from server.");
    },
    onEvent: opts.onEvent,
  });

  const shutdown = async () => {
    logger.info("\nShutting down...");
    if (cdpHealthTimer) clearInterval(cdpHealthTimer);
    client.stop();
    currentCdp?.close();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return { shutdown, getState: client.getState };
}
