// ── Browser Action Types ──

export type BrowserAction =
  | { type: "navigate"; url: string }
  | { type: "click"; ref: string }
  | { type: "type"; ref: string; text: string; submit?: boolean }
  | { type: "select"; ref: string; value: string }
  | { type: "hover"; ref: string }
  | { type: "scroll"; direction: "up" | "down"; amount?: number }
  | { type: "back" }
  | { type: "forward" }
  | { type: "reload" }
  | { type: "wait"; ms: number }
  | { type: "snapshot" }
  | { type: "screenshot" }
  | { type: "evaluate"; script: string }
  | { type: "tabs" }
  | { type: "switchTab"; index: number }
  | { type: "closeTab"; index?: number };

// ── Browser Result Types ──

export type BrowserResult =
  | { type: "snapshot"; url: string; title: string; content: string }
  | { type: "screenshot"; url: string; title: string; base64: string }
  | { type: "evaluate"; value: unknown }
  | { type: "tabs"; tabs: Array<{ index: number; url: string; title: string; active: boolean }> }
  | { type: "done"; url: string; title: string; message?: string };

// ── Command/Response Envelope ──

export interface BrowserCommand {
  id: string;
  action: BrowserAction;
  sessionId?: string;
}

export interface BrowserResponse {
  id: string;
  result?: BrowserResult;
  error?: string;
}

// ── Companion Status ──

export interface CompanionStatus {
  connected: boolean;
  lastConnectedAt?: string;
  browserUrl?: string;
  browserTitle?: string;
}

// ── Control Messages (server → companion) ──

export type CompanionControl =
  | { type: "ping" }
  | { type: "command"; command: BrowserCommand }
  | { type: "createSession"; sessionId: string }
  | { type: "destroySession"; sessionId: string }
  | { type: "createSandbox"; sandboxId: string }
  | { type: "runScript"; sandboxId: string; commandId: string; script: string; packages?: string[]; timeout?: number }
  | { type: "destroySandbox"; sandboxId: string };

// ── Companion Messages (companion → server) ──

export type CompanionMessage =
  | { type: "pong" }
  | { type: "status"; url?: string; title?: string }
  | { type: "response"; response: BrowserResponse }
  | { type: "sessionCreated"; sessionId: string }
  | { type: "sessionDestroyed"; sessionId: string }
  | { type: "sessionError"; sessionId: string; error: string }
  | { type: "sandboxCreated"; sandboxId: string; pythonVersion: string | null }
  | { type: "scriptResult"; commandId: string; sandboxId: string; stdout: string; stderr: string; exitCode: number; changedFiles?: Array<{ path: string; data: string; sizeBytes: number }>; skippedFiles?: Array<{ path: string; reason: string }> }
  | { type: "sandboxDestroyed"; sandboxId: string }
  | { type: "sandboxError"; sandboxId: string; commandId?: string; error: string };
