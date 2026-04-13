// -- Browser Action Types --

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

// -- Browser Result Types --

export type BrowserResult =
  | { type: "snapshot"; url: string; title: string; content: string }
  | { type: "screenshot"; url: string; title: string; base64: string }
  | { type: "evaluate"; url: string; title: string; value: unknown; logs?: string[]; error?: string }
  | { type: "tabs"; tabs: Array<{ index: number; url: string; title: string; active: boolean }> }
  | { type: "done"; url: string; title: string; message?: string; snapshot?: string };

// -- Exec Result --

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// -- File types --

export interface ReadFile {
  path: string;
  data: string;        // base64
  sizeBytes: number;
}

export interface DetectedChanges {
  changed: string[];
  deleted: string[];
}

// -- Container info --

export interface ContainerInfo {
  name: string;
  ip: string;
  status: string;
  created: boolean;
  createdAt: number;
  lastUsedAt: number;
}
