import type { RPCSchema } from "electrobun/bun";

export type ActivityEvent =
	| { type: "session:created"; sessionId: string; label?: string }
	| { type: "session:destroyed"; sessionId: string }
	| { type: "browser:action"; sessionId?: string; action: string; detail?: string }
	| { type: "browser:done"; sessionId?: string; url?: string; title?: string }
	| { type: "browser:error"; sessionId?: string; error: string }
	| { type: "workspace:created"; workspaceId: string }
	| { type: "workspace:running"; workspaceId: string }
	| { type: "workspace:completed"; workspaceId: string; exitCode: number }
	| { type: "workspace:destroyed"; workspaceId: string }
	| { type: "workspace:error"; workspaceId: string; error: string }
	| { type: "workspace:files"; workspaceId: string; files: string[] }
	| { type: "workspace:bash-started"; workspaceId: string; command: string }
	| { type: "workspace:bash-result"; workspaceId: string; stdout: string; stderr: string; exitCode: number; changedFiles?: Array<{ path: string; sizeBytes: number }>; deletedFiles?: string[]; truncated?: boolean };

export interface CompanionSessionState {
	id: string;
	url?: string;
	title?: string;
	label?: string;
}

export interface CompanionWorkspaceState {
	id: string;
	status: string;
	files: string[];
}

export type CompanionRPC = {
	bun: RPCSchema<{
		requests: {
			connect: {
				params: { token: string; server: string };
				response: { ok: boolean; error?: string };
			};
			getAutoConnect: {
				params: {};
				response: { token?: string; server?: string };
			};
			getState: {
				params: {};
				response: {
					sessions: CompanionSessionState[];
					workspaces: CompanionWorkspaceState[];
				};
			};
			checkRuntime: {
				params: {};
				response: { ready: boolean; installed: boolean; canSetup: boolean; needsWsl: boolean };
			};
			checkChrome: {
				params: {};
				response: { available: boolean; path?: string };
			};
			setupDocker: {
				params: {};
				response: { ok: boolean; error?: string };
			};
			installWsl: {
				params: {};
				response: { ok: boolean; error?: string };
			};
			getResources: {
				params: {};
				response: {
					containers: Array<{ id: string; name: string; image: string; state: string; created: string }>;
					images: Array<{ id: string; repository: string; tag: string; created: string }>;
				};
			};
			removeContainer: {
				params: { id: string };
				response: { ok: boolean; error?: string };
			};
			removeImage: {
				params: { id: string };
				response: { ok: boolean; error?: string };
			};
			pruneAll: {
				params: {};
				response: { ok: boolean; error?: string };
			};
		};
		messages: {};
	}>;
	webview: RPCSchema<{
		requests: {};
		messages: {
			status: { state: "disconnected" | "connecting" | "connected"; message?: string };
			event: ActivityEvent;
			setupProgress: { step: string; detail?: string };
		};
	}>;
};
