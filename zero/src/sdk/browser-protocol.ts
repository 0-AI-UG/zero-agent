/**
 * Companion ⇄ server browser protocol — the laptop-side mirror of
 * `server/lib/browser/protocol.ts`. Kept as a standalone copy so the `zero`
 * package has no build dependency on the server tree. The two must stay in
 * sync; this file deliberately mirrors the same shapes.
 */

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
  | { type: "snapshot"; mode?: "interactive" | "full"; selector?: string }
  | { type: "screenshot" }
  | { type: "evaluate"; script: string; awaitPromise?: boolean; maxChars?: number }
  | { type: "tabs" }
  | { type: "switchTab"; index: number }
  | { type: "closeTab"; index?: number };

export type BrowserResult =
  | { type: "snapshot"; url: string; title: string; content: string }
  | { type: "screenshot"; url: string; title: string; base64: string }
  | { type: "evaluate"; url: string; title: string; value: unknown; logs?: string[]; error?: string }
  | { type: "tabs"; tabs: Array<{ index: number; url: string; title: string; active: boolean }> }
  | { type: "done"; url: string; title: string; message?: string; snapshot?: string };

export interface BrowserCommand {
  id: string;
  action: BrowserAction;
  sessionId?: string;
  stealth?: boolean;
}

export interface BrowserResponse {
  id: string;
  result?: BrowserResult;
  error?: string;
}

export type CompanionControl =
  | { type: "ping" }
  | { type: "command"; command: BrowserCommand }
  | { type: "createSession"; sessionId: string; label?: string }
  | { type: "destroySession"; sessionId: string }
  | { type: "createWorkspace"; workspaceId: string; manifest: Record<string, string> }
  | { type: "syncWorkspace"; workspaceId: string; manifest: Record<string, string> }
  | { type: "runBash"; workspaceId: string; commandId: string; command: string; timeout?: number }
  | { type: "destroyWorkspace"; workspaceId: string }
  | { type: "webauthn"; subCommand: unknown };

export type CompanionMessage =
  | { type: "pong" }
  | { type: "status"; url?: string; title?: string; capabilities?: { dockerInstalled: boolean; dockerRunning: boolean; chromeAvailable: boolean } }
  | { type: "response"; response: BrowserResponse }
  | { type: "sessionCreated"; sessionId: string }
  | { type: "sessionDestroyed"; sessionId: string }
  | { type: "sessionError"; sessionId: string; error: string };
