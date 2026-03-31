import { useState, useEffect, useCallback } from "react";
import { setHandlers, connect, getAutoConnect, getState, checkRuntime, checkChrome, setupDocker, installWsl } from "./rpc-bridge.ts";
import type { ActivityEvent } from "../shared/rpc.ts";
import type {
	SessionDetail, WorkspaceDetail, CodeExecution,
	Route, ConnectionState,
} from "./types.ts";
import { Header } from "./components/header.tsx";
import { ConnectPanel } from "./components/connect-panel.tsx";
import { Overview } from "./components/overview.tsx";
import { SessionDetailView } from "./components/session-detail.tsx";
import { WorkspaceDetailView } from "./components/workspace-detail.tsx";
import { ExecutionDetailView } from "./components/execution-detail.tsx";
import { ResourcesPanel } from "./components/resources-panel.tsx";

const MAX_ACTIONS = 100;

// ── Main App ──

export function App() {
	const [connection, setConnection] = useState<ConnectionState>("disconnected");
	const [error, setError] = useState("");
	const [route, setRoute] = useState<Route>({ view: "overview" });
	const [runtimeReady, setRuntimeReady] = useState<boolean | "checking" | "setting-up">("checking");
	const [dockerInstalled, setDockerInstalled] = useState(false);
	const [canSetup, setCanSetup] = useState(false);
	const [needsWsl, setNeedsWsl] = useState(false);
	const [chromeAvailable, setChromeAvailable] = useState<boolean | "checking">("checking");
	const [autoConnectChecked, setAutoConnectChecked] = useState(false);
	const [sessions, setSessions] = useState<Map<string, SessionDetail>>(new Map());
	const [workspaces, setWorkspaces] = useState<Map<string, WorkspaceDetail>>(new Map());

	const handleEvent = useCallback((event: ActivityEvent) => {
		// Update sessions
		setSessions((prev) => {
			const next = new Map(prev);
			switch (event.type) {
				case "session:created":
					next.set(event.sessionId, { label: event.label, actions: [], errors: [] });
					break;
				case "session:destroyed":
					next.delete(event.sessionId);
					break;
				case "browser:action":
					if (event.sessionId) {
						const s = next.get(event.sessionId);
						if (s) {
							next.set(event.sessionId, {
								...s,
								actions: [...s.actions, { timestamp: Date.now(), action: event.action, detail: event.detail }].slice(-MAX_ACTIONS),
							});
						}
					}
					break;
				case "browser:done":
					if (event.sessionId) {
						const s = next.get(event.sessionId);
						if (s) {
							next.set(event.sessionId, { ...s, url: event.url, title: event.title });
						}
					}
					break;
				case "browser:error":
					if (event.sessionId) {
						const s = next.get(event.sessionId);
						if (s) {
							next.set(event.sessionId, { ...s, errors: [...s.errors, event.error].slice(-20) });
						}
					}
					break;
			}
			return next;
		});

		// Update workspaces
		setWorkspaces((prev) => {
			const next = new Map(prev);
			switch (event.type) {
				case "workspace:created":
					next.set(event.workspaceId, { status: "ready", files: [], executions: [] });
					break;
				case "workspace:running": {
					const ws = next.get(event.workspaceId);
					if (ws) next.set(event.workspaceId, { ...ws, status: "running" });
					break;
				}
				case "workspace:completed": {
					const ws = next.get(event.workspaceId);
					if (ws) next.set(event.workspaceId, { ...ws, status: "ready" });
					break;
				}
				case "workspace:destroyed":
					next.delete(event.workspaceId);
					break;
				case "workspace:error": {
					const ws = next.get(event.workspaceId);
					if (ws) next.set(event.workspaceId, { ...ws, status: "error" });
					break;
				}
				case "workspace:files": {
					const ws = next.get(event.workspaceId);
					if (ws) next.set(event.workspaceId, { ...ws, files: event.files });
					break;
				}
				case "workspace:bash-started": {
					const ws = next.get(event.workspaceId);
					if (ws) {
						const exec: CodeExecution = {
							timestamp: Date.now(),
							command: event.command,
							status: "running",
						};
						next.set(event.workspaceId, { ...ws, executions: [...ws.executions, exec] });
					}
					break;
				}
				case "workspace:bash-result": {
					const ws = next.get(event.workspaceId);
					if (ws && ws.executions.length > 0) {
						const executions = [...ws.executions];
						// Find the last running execution to update (not just the last entry)
						let idx = executions.length - 1;
						while (idx >= 0 && executions[idx].status !== "running") idx--;
						if (idx < 0) idx = executions.length - 1; // fallback to last
						executions[idx] = {
							...executions[idx],
							stdout: event.stdout,
							stderr: event.stderr,
							exitCode: event.exitCode,
							changedFiles: event.changedFiles,
							deletedFiles: event.deletedFiles,
							truncated: event.truncated,
							status: event.exitCode === 0 ? "completed" : "error",
						};
						next.set(event.workspaceId, { ...ws, executions });
					}
					break;
				}
			}
			return next;
		});
	}, []);

	const refreshRuntimeStatus = () => {
		checkRuntime().then((r) => {
			setRuntimeReady(r.ready);
			setDockerInstalled(r.installed);
			setCanSetup(r.canSetup);
			setNeedsWsl(r.needsWsl);
		}).catch(() => setRuntimeReady(false));
		checkChrome().then((r) => {
			setChromeAvailable(r.available);
		}).catch(() => setChromeAvailable(false));
	};

	useEffect(() => {
		refreshRuntimeStatus();
	}, []);

	// Auto-connect when launched with COMPANION_TOKEN env var (desktop mode)
	useEffect(() => {
		if (autoConnectChecked) return;
		if (runtimeReady !== true || chromeAvailable !== true) return;
		if (connection !== "disconnected") return;
		setAutoConnectChecked(true);
		getAutoConnect().then((auto) => {
			if (auto.token) {
				handleConnect(auto.token, auto.server ?? "http://localhost:3000");
			}
		}).catch(() => {});
	}, [runtimeReady, chromeAvailable, connection, autoConnectChecked]);

	const handleSetup = async () => {
		setRuntimeReady("setting-up");
		setError("");
		const result = await setupDocker();
		if (result.ok) {
			setRuntimeReady(true);
		} else {
			setError(result.error ?? "Setup failed");
			setRuntimeReady("setting-up"); // stay on progress screen to show the error
		}
	};

	const handleInstallWsl = async () => {
		setRuntimeReady("checking");
		setError("");
		const result = await installWsl();
		if (result.ok) {
			// WSL install typically requires a reboot — re-check status
			refreshRuntimeStatus();
		} else {
			setError(result.error ?? "WSL installation failed");
			setRuntimeReady(false);
		}
	};

	useEffect(() => {
		setHandlers(
			(state, message) => {
				setConnection(state);
				if (state === "disconnected") {
					if (message) setError(message);
					setSessions(new Map());
					setWorkspaces(new Map());
					setRoute({ view: "overview" });
				} else if (state === "connected") {
					setError("");
					// Hydrate current state
					getState().then((s) => {
						setSessions((prev) => {
							const next = new Map(prev);
							for (const sess of s.sessions) {
								if (!next.has(sess.id)) {
									next.set(sess.id, { url: sess.url, title: sess.title, label: sess.label, actions: [], errors: [] });
								}
							}
							return next;
						});
						setWorkspaces((prev) => {
							const next = new Map(prev);
							for (const ws of s.workspaces) {
								if (!next.has(ws.id)) {
									next.set(ws.id, { status: ws.status, files: ws.files, executions: [] });
								}
							}
							return next;
						});
					}).catch(() => {});
				} else {
					setError("");
				}
			},
			handleEvent,
		);
	}, [handleEvent]);

	const handleConnect = async (token: string, server: string) => {
		setError("");
		setConnection("connecting");
		const result = await connect(token, server);
		if (!result.ok) {
			setError(result.error ?? "Connection failed");
			setConnection("disconnected");
		}
	};

	const handleDisconnect = async () => {
		await connect("", "");
	};

	const goBack = () => {
		if (route.view === "execution") {
			setRoute({ view: "workspace", workspaceId: route.workspaceId });
		} else {
			setRoute({ view: "overview" });
		}
	};

	const goToResources = () => setRoute({ view: "resources" });

	// Determine header title
	let headerTitle = "Companion";
	if (connection === "connected") {
		switch (route.view) {
			case "session": {
				const s = sessions.get(route.sessionId);
				headerTitle = s?.label ?? s?.title ?? "Session";
				break;
			}
			case "workspace":
				headerTitle = `Workspace ${route.workspaceId.slice(0, 8)}`;
				break;
			case "execution": {
				const ws = workspaces.get(route.workspaceId);
				const exec = ws?.executions[route.executionIndex];
				headerTitle = exec?.command ?? "Execution";
				break;
			}
			case "resources":
				headerTitle = "Resources";
				break;
		}
	}

	return (
		<div className="flex flex-col min-h-screen bg-background">
			<Header
				title={headerTitle}
				connection={connection}
				canGoBack={connection === "connected" && route.view !== "overview"}
				onBack={goBack}
				onDisconnect={connection === "connected" ? handleDisconnect : undefined}
				onResources={connection === "connected" && route.view !== "resources" ? goToResources : undefined}
			/>

			{connection !== "connected" ? (
				<ConnectPanel
					onConnect={handleConnect}
					error={error}
					runtimeReady={runtimeReady}
					dockerInstalled={dockerInstalled}
					canSetup={canSetup}
					needsWsl={needsWsl}
					chromeAvailable={chromeAvailable}
					onSetup={handleSetup}
					onInstallWsl={handleInstallWsl}
				/>
			) : route.view === "resources" ? (
				<ResourcesPanel onBack={goBack} />
			) : route.view === "session" ? (
				sessions.get(route.sessionId) ? (
					<SessionDetailView sessionId={route.sessionId} session={sessions.get(route.sessionId)!} />
				) : (
					<div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">Session not found</div>
				)
			) : route.view === "workspace" ? (
				workspaces.get(route.workspaceId) ? (
					<WorkspaceDetailView
						workspaceId={route.workspaceId}
						workspace={workspaces.get(route.workspaceId)!}
						onSelectExecution={(idx) => setRoute({ view: "execution", workspaceId: route.workspaceId, executionIndex: idx })}
					/>
				) : (
					<div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">Workspace not found</div>
				)
			) : route.view === "execution" ? (
				(() => {
					const ws = workspaces.get(route.workspaceId);
					const exec = ws?.executions[route.executionIndex];
					return exec ? (
						<ExecutionDetailView execution={exec} />
					) : (
						<div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">Execution not found</div>
					);
				})()
			) : (
				<Overview
					sessions={sessions}
					workspaces={workspaces}
					onSelectSession={(id) => setRoute({ view: "session", sessionId: id })}
					onSelectWorkspace={(id) => setRoute({ view: "workspace", workspaceId: id })}
				/>
			)}
		</div>
	);
}
