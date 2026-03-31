import Electrobun, { BrowserWindow, BrowserView, ApplicationMenu } from "electrobun/bun";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";

// ── Data directory ──
const dataDir = join(homedir(), "Library", "Application Support", "com.zero-agent.desktop");
mkdirSync(dataDir, { recursive: true });

// ── Dev vs production ──
// Dev scripts set ZERO_AGENT_DEV=1 and ZERO_AGENT_ROOT. Production builds don't.
const isDev = process.env.ZERO_AGENT_DEV === "1";
// In dev: repo root from env. In production: Resources dir is two levels up from app/bun/.
const repoRoot = isDev ? process.env.ZERO_AGENT_ROOT! : null;
const resourcesDir = isDev ? null : join(import.meta.dir, "..", "..");

const PORT = "17380";
const serverUrl = `http://localhost:${PORT}`;

// ── Track child PIDs for cleanup ──
const childPids: number[] = [];

function killChildren() {
	for (const pid of childPids) {
		try { process.kill(pid, "SIGKILL"); } catch {}
	}
}

process.on("SIGINT", () => { killChildren(); process.exit(); });
process.on("SIGTERM", () => { killChildren(); process.exit(); });
process.on("exit", killChildren);

// ── Start server ──
const serverEnv = {
	...process.env,
	DESKTOP_MODE: "1",
	DB_PATH: join(dataDir, "app.db"),
	S3_DB_PATH: join(dataDir, "storage.s3db"),
	PORT,
	NODE_ENV: "production",
};

let serverProc;
if (isDev) {
	serverProc = Bun.spawn(["bun", join(repoRoot!, "server/index.ts")], {
		cwd: repoRoot!,
		env: serverEnv,
		stdout: "inherit",
		stderr: "inherit",
	});
} else {
	serverProc = Bun.spawn([join(resourcesDir!, "zero-agent")], {
		env: serverEnv,
		stdout: "inherit",
		stderr: "inherit",
	});
}
childPids.push(serverProc.pid);

// ── Wait for server to be healthy ──
async function waitForHealth(url: string, maxRetries = 100): Promise<void> {
	for (let i = 0; i < maxRetries; i++) {
		try {
			const res = await fetch(`${url}/api/health`);
			if (res.ok) return;
		} catch {}
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error("Server failed to start");
}

await waitForHealth(serverUrl);

// ── RPC (minimal) ──
const rpc = BrowserView.defineRPC<{ requests: {}; messages: {} }>({
	maxRequestTime: 10000,
	handlers: { requests: {}, messages: {} },
});

function launchCompanion() {
	const companionEnv = {
		...process.env,
		COMPANION_TOKEN: "desktop-mode",
		COMPANION_SERVER: serverUrl,
	};

	try {
		let companionProc;
		if (isDev) {
			companionProc = Bun.spawn(["bunx", "electrobun", "dev"], {
				cwd: join(repoRoot!, "companion"),
				env: companionEnv,
				stdout: "inherit",
				stderr: "inherit",
			});
		} else {
			const companionApp = join(resourcesDir!, "zero-agent-companion.app");
			const launcherPath = join(companionApp, "Contents", "MacOS", "launcher");
			companionProc = Bun.spawn([launcherPath], {
				env: companionEnv,
				stdout: "inherit",
				stderr: "inherit",
			});
		}
		childPids.push(companionProc.pid);
	} catch (err) {
		console.warn("Companion failed to start:", err);
	}
}

ApplicationMenu.setApplicationMenu([
	{
		label: "Edit",
		submenu: [
			{ role: "cut" },
			{ role: "copy" },
			{ role: "paste" },
			{ role: "selectAll" },
		],
	},
	{
		label: "Companion",
		submenu: [
			{ label: "Launch Companion", action: "launch-companion" },
		],
	},
]);

ApplicationMenu.on("application-menu-clicked", (event: any) => {
	if (event?.data?.action === "launch-companion") {
		launchCompanion();
	}
});

// ── Create main window ──
const mainWindow = new BrowserWindow({
	title: "Zero Agent",
	url: serverUrl,
	frame: {
		width: 1200,
		height: 800,
		x: 100,
		y: 100,
	},
	rpc,
});

Electrobun.events.on("before-quit", () => {
	killChildren();
});

// ── Watchdog: if our parent (Electrobun launcher) dies, clean up ──
const parentPid = process.ppid;
const watchdog = setInterval(() => {
	try {
		process.kill(parentPid, 0);
	} catch {
		clearInterval(watchdog);
		killChildren();
		process.exit();
	}
}, 2000);
