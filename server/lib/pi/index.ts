/**
 * Public surface of the Pi orchestration module. Chat handlers and tests
 * import from here; nothing else under `server/lib/pi/` is part of the
 * stable interface yet — those files are free to be reshuffled while the
 * `useNewExecution` flag is opt-in.
 */
export type { PiCliContext } from "./cli-context.ts";
export type { PiEventEnvelope, RunTurnOptions, TurnResult } from "./run-turn.ts";
export {
  runTurn,
  projectDirFor,
  sessionsDirFor,
} from "./run-turn.ts";
export {
  buildPiSandboxPolicy,
  DEFAULT_ALLOWED_DOMAINS,
  type PiSandboxPolicy,
  type PiSandboxPolicyInput,
} from "./sandbox-policy.ts";
export {
  startPiSocketServer,
  registerPiTurnToken,
  resolvePiTurnToken,
  type PiSocketServer,
} from "./cli-socket.ts";
export {
  createPiSandboxExtension,
  checkToolCall,
  type SandboxExtensionOptions,
} from "./sandbox-extension.ts";
export {
  checkReadAccess,
  checkWriteAccess,
  resolveToolPath,
  expandHome,
  pathIsUnder,
  matchesGlob,
} from "./path-policy.ts";
