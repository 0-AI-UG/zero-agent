import { Command } from "commander";
import { launchChrome } from "./chrome-launcher.ts";
import { type CdpClient, connectToPage, extractPort } from "./cdp.ts";
import { createWsClient } from "./ws-client.ts";
import { discoverChrome } from "./chrome-discovery.ts";
import { createLogger } from "./logger.ts";
import { isFirstRun, printStartupInfo } from "./first-run.ts";

const CDP_RECONNECT_BASE = 2000;
const CDP_RECONNECT_MAX = 30000;
const CDP_HEALTH_INTERVAL = 10_000;

const program = new Command();

program
  .name("zero-agent-companion")
  .description("Browser companion agent for zero-agent")
  .requiredOption("--token <token>", "Companion authentication token")
  .option("--server <url>", "Server URL", "http://localhost:3000")
  .option("--profile <name>", "Browser profile name", "default")
  .option("--cdp-url <url>", "Connect to existing CDP URL instead of launching Chrome")
  .option("--chrome <path>", "Custom Chrome executable path")
  .option("--port <number>", "CDP port override (default: 18800)", parseInt)
  .option("--headless", "Launch Chrome in headless mode", false)
  .option("--verbose", "Enable verbose logging", false)
  .action(async (opts) => {
    const logger = createLogger(opts.verbose);
    const firstRun = isFirstRun(opts.profile);

    // Resolve Chrome path for display
    const chromePath = opts.chrome ?? discoverChrome();

    await printStartupInfo({
      logger,
      chromePath,
      profile: opts.profile,
      port: opts.port,
      serverUrl: opts.server,
      headless: opts.headless,
      firstRun,
    });

    // State: current CDP client (swapped on reconnection)
    let currentCdp: CdpClient | null = null;
    let cdpPort: number;
    let cdpReconnecting = false;
    let cdpHealthTimer: ReturnType<typeof setInterval> | null = null;
    // Default session ref map (for commands without sessionId — backward compat)
    let defaultRefMap = new Map<string, { role: string; name: string; backendNodeId: number }>();

    // --- CDP connection & reconnection ---

    async function establishCdp(): Promise<void> {
      let cdpUrl: string;
      if (opts.cdpUrl) {
        cdpUrl = opts.cdpUrl;
        logger.debug(`Using provided CDP URL: ${cdpUrl}`);
      } else {
        logger.debug("Launching Chrome...");
        const launch = await launchChrome({
          profile: opts.profile,
          chromePath: opts.chrome,
          port: opts.port,
          headless: opts.headless,
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

      // Watch for CDP close (Chrome crash/quit)
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
          // Lightweight probe — just check if Runtime is responsive
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
          attempt(); // retry
        }
      }

      attempt();
    }

    // --- Initial CDP connection ---
    await establishCdp();

    // --- Server WebSocket ---
    const client = createWsClient({
      serverUrl: opts.server,
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
        logger.success(`Connected to ${opts.server}. Chrome is ready. Keep this running.`);
      },
      onDisconnected: () => {
        logger.info("Disconnected from server.");
      },
    });

    // Handle shutdown
    const shutdown = async () => {
      logger.info("\nShutting down...");
      if (cdpHealthTimer) clearInterval(cdpHealthTimer);
      client.stop();
      currentCdp?.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    // Keep alive
    await new Promise(() => {});
  });

program.parse();
