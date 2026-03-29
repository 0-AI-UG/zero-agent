export interface SessionDetail {
	url?: string;
	title?: string;
	label?: string;
	actions: Array<{ timestamp: number; action: string; detail?: string }>;
	errors: string[];
}

export interface CodeExecution {
	timestamp: number;
	command: string;
	stdout?: string;
	stderr?: string;
	exitCode?: number;
	changedFiles?: Array<{ path: string; sizeBytes: number }>;
	deletedFiles?: string[];
	truncated?: boolean;
	status: "running" | "completed" | "error";
}

export interface WorkspaceDetail {
	status: string;
	files: string[];
	executions: CodeExecution[];
}

export type Route =
	| { view: "overview" }
	| { view: "session"; sessionId: string }
	| { view: "workspace"; workspaceId: string }
	| { view: "execution"; workspaceId: string; executionIndex: number }
	| { view: "resources" };

export type ConnectionState = "disconnected" | "connecting" | "connected";
