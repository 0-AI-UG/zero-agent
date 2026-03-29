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
			getState: {
				params: {};
				response: {
					sessions: CompanionSessionState[];
					workspaces: CompanionWorkspaceState[];
				};
			};
		};
		messages: {};
	}>;
	webview: RPCSchema<{
		requests: {};
		messages: {
			status: { state: "disconnected" | "connecting" | "connected"; message?: string };
			event: ActivityEvent;
		};
	}>;
};
