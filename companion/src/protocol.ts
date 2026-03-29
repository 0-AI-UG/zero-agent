// Mirror of api/src/lib/browser/protocol.ts — kept in sync manually.

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

export type BrowserResult =
  | { type: "snapshot"; url: string; title: string; content: string }
  | { type: "screenshot"; url: string; title: string; base64: string }
  | { type: "evaluate"; value: unknown }
  | { type: "tabs"; tabs: Array<{ index: number; url: string; title: string; active: boolean }> }
  | { type: "done"; url: string; title: string; message?: string; snapshot?: string };

export interface BrowserCommand {
  id: string;
  action: BrowserAction;
  sessionId?: string;
  /** When true, use human-like mouse movement and typing delays for bot detection avoidance. */
  stealth?: boolean;
}

export interface BrowserResponse {
  id: string;
  result?: BrowserResult;
  error?: string;
}

export type WebAuthnSubCommand =
  | { type: "enable"; commandId: string }
  | { type: "addAuthenticator"; commandId: string; options: {
      protocol: "ctap2"; transport: "internal";
      hasResidentKey: true; hasUserVerification: true; isUserVerified: true } }
  | { type: "addCredential"; commandId: string; authenticatorId: string;
      credential: { credentialId: string; rpId: string; privateKey: string;
                    userHandle: string; signCount: number } }
  | { type: "getCredentials"; commandId: string; authenticatorId: string }
  | { type: "removeAuthenticator"; commandId: string; authenticatorId: string };

export type CompanionControl =
  | { type: "ping" }
  | { type: "command"; command: BrowserCommand }
  | { type: "createSession"; sessionId: string; label?: string }
  | { type: "destroySession"; sessionId: string }
  | { type: "createWorkspace"; workspaceId: string; manifest: Record<string, string> }
  | { type: "syncWorkspace"; workspaceId: string; manifest: Record<string, string> }
  | { type: "runBash"; workspaceId: string; commandId: string; command: string; timeout?: number }
  | { type: "destroyWorkspace"; workspaceId: string }
  | { type: "webauthn"; subCommand: WebAuthnSubCommand };

export type CompanionMessage =
  | { type: "pong" }
  | { type: "status"; url?: string; title?: string }
  | { type: "response"; response: BrowserResponse }
  | { type: "sessionCreated"; sessionId: string }
  | { type: "sessionDestroyed"; sessionId: string }
  | { type: "sessionError"; sessionId: string; error: string }
  | { type: "workspaceCreated"; workspaceId: string }
  | { type: "workspaceSynced"; workspaceId: string }
  | { type: "bashResult"; commandId: string; workspaceId: string; stdout: string; stderr: string; exitCode: number; changedFiles?: Array<{ path: string; data: string; sizeBytes: number }>; deletedFiles?: string[] }
  | { type: "workspaceDestroyed"; workspaceId: string }
  | { type: "workspaceError"; workspaceId: string; commandId?: string; error: string }
  | { type: "webauthnResult"; commandId: string; result: unknown }
  | { type: "webauthnError"; commandId: string; error: string };
