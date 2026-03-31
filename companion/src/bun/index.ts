import { BrowserWindow, BrowserView, ApplicationMenu } from "electrobun/bun";
import { startCompanion } from "../companion.ts";
import type { CompanionRPC } from "../shared/rpc.ts";
import { detectRuntime, setupDocker, installWsl, getDockerResources, removeContainer, removeImage, pruneAll } from "../container-backend.ts";
import { detectChrome } from "../chrome-discovery.ts";

let companionShutdown: (() => Promise<void>) | null = null;
let companionGetState: (() => { sessions: Array<{ id: string; url?: string; title?: string }>; workspaces: Array<{ id: string; status: string; files: string[] }> }) | null = null;

const rpc = BrowserView.defineRPC<CompanionRPC>({
	maxRequestTime: 30000,
	handlers: {
		requests: {
			getAutoConnect: async () => {
				const token = process.env.COMPANION_TOKEN;
				const server = process.env.COMPANION_SERVER;
				if (token) return { token, server };
				return {};
			},
			connect: async ({ token, server }) => {
				if (companionShutdown) {
					await companionShutdown();
					companionShutdown = null;
					companionGetState = null;
					mainWindow.webview.rpc!.send.status({ state: "disconnected" });
				}

				if (!token) {
					return { ok: true };
				}

				try {
					mainWindow.webview.rpc!.send.status({ state: "connecting" });
					const result = await startCompanion({
						token,
						server,
						onEvent: (event) => {
							try {
								mainWindow.webview.rpc!.send.event(event);
							} catch (err) {
								console.error("Failed to send event to webview:", err, event);
							}
						},
					});
					companionShutdown = result.shutdown;
					companionGetState = result.getState;
					mainWindow.webview.rpc!.send.status({ state: "connected" });
					return { ok: true };
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					mainWindow.webview.rpc!.send.status({ state: "disconnected", message });
					return { ok: false, error: message };
				}
			},
			getState: async () => {
				if (!companionGetState) {
					return { sessions: [], workspaces: [] };
				}
				return companionGetState();
			},
			checkRuntime: async () => {
				const status = detectRuntime();
				if (status.ready) return { ready: true, installed: true, canSetup: false, needsWsl: false };
				return { ready: false, installed: status.installed, canSetup: status.canSetup, needsWsl: status.needsWsl };
			},
			checkChrome: async () => {
				return detectChrome();
			},
			setupDocker: async () => {
				return setupDocker((step, detail) => {
					try {
						mainWindow.webview.rpc!.send.setupProgress({ step, detail });
					} catch {}
				});
			},
			installWsl: async () => {
				return installWsl();
			},
			getResources: async () => {
				return getDockerResources();
			},
			removeContainer: async ({ id }) => {
				return removeContainer(id);
			},
			removeImage: async ({ id }) => {
				return removeImage(id);
			},
			pruneAll: async () => {
				return pruneAll();
			},
		},
		messages: {},
	},
});

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
]);

const mainWindow = new BrowserWindow({
	title: "Zero Agent Companion",
	url: "views://mainview/index.html",
	frame: {
		width: 380,
		height: 360,
		x: 200,
		y: 200,
	},
	rpc,
});
