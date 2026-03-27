import { log } from "@/lib/logger.ts";
import { getTelegramUpdates, deleteTelegramWebhook, type TelegramUpdate } from "@/lib/telegram.ts";
import { listS3Files, readFromS3 } from "@/lib/s3.ts";

const pollLog = log.child({ module: "telegram-polling" });

type UpdateHandler = (projectId: string, update: TelegramUpdate) => Promise<void>;

interface Poller {
  running: boolean;
  abortController: AbortController;
}

const pollers = new Map<string, Poller>();

export async function startPollingForProject(
  projectId: string,
  botToken: string,
  handler: UpdateHandler,
): Promise<void> {
  // Stop existing poller if any
  stopPollingForProject(projectId);

  // Delete any existing webhook so getUpdates works
  await deleteTelegramWebhook(botToken);

  const abortController = new AbortController();
  const poller: Poller = { running: true, abortController };
  pollers.set(projectId, poller);

  pollLog.info("starting polling", { projectId });

  // Run poll loop in background
  (async () => {
    let offset: number | undefined;

    while (poller.running) {
      try {
        const updates = await getTelegramUpdates(botToken, offset, 25);

        for (const update of updates) {
          offset = update.update_id + 1;
          try {
            await handler(projectId, update);
          } catch (err) {
            pollLog.error("handler error", err, { projectId, updateId: update.update_id });
          }
        }
      } catch (err) {
        if (!poller.running) break;
        pollLog.error("polling error, retrying in 5s", err, { projectId });
        await new Promise((r) => setTimeout(r, 5000));
      }
    }

    pollLog.info("polling stopped", { projectId });
  })();
}

export function stopPollingForProject(projectId: string): void {
  const poller = pollers.get(projectId);
  if (poller) {
    poller.running = false;
    poller.abortController.abort();
    pollers.delete(projectId);
    pollLog.info("stopping polling", { projectId });
  }
}

export async function startAllPollers(handler: UpdateHandler): Promise<void> {
  pollLog.info("scanning for telegram bots to poll");

  try {
    const keys = await listS3Files("projects/");
    const credKeys = keys.filter((k) => k.endsWith("/credentials/telegram-bot.json"));

    for (const key of credKeys) {
      // Extract projectId from "projects/{projectId}/credentials/telegram-bot.json"
      const parts = key.split("/");
      const projectId = parts[1];
      if (!projectId) continue;

      try {
        const raw = await readFromS3(key);
        const cred = JSON.parse(raw);
        if (cred.botToken) {
          await startPollingForProject(projectId, cred.botToken, handler);
        }
      } catch (err) {
        pollLog.error("failed to start poller for project", err, { projectId });
      }
    }

    pollLog.info("polling startup complete", { count: pollers.size });
  } catch (err) {
    pollLog.error("failed to scan for telegram bots", err);
  }
}
