/**
 * The `zero` SDK. Import named groups from this module inside scripts
 * the agent writes:
 *
 *   import { web, browser, creds } from "zero";
 *   const results = await web.search("hello");
 *
 * Each group's functions are 1:1 with the corresponding CLI subcommand.
 * Both forms call the same HTTP client in `client.ts`, so auth and
 * configuration happen exactly once.
 */
export { ZeroError } from "./errors.ts";
export { call as _call } from "./client.ts";
export { web } from "./web.ts";
export type { WebSearchResponse, WebSearchResult, WebFetchResponse } from "./web.ts";
export { chat } from "./chat.ts";
export type { ChatSearchHit } from "./chat.ts";
export { telegram } from "./telegram.ts";
export type { TelegramSendResult } from "./telegram.ts";
export { schedule } from "./schedule.ts";
export type { ScheduledTask, AddTaskInput, UpdateTaskInput } from "./schedule.ts";
export { image } from "./image.ts";
export type { GenerateImageResult } from "./image.ts";
export { creds } from "./creds.ts";
export type { CredentialSummary, CredGetResult, SetCredentialInput } from "./creds.ts";
export { browser } from "./browser.ts";
export type { BrowserResult } from "./browser.ts";
export { ports } from "./ports.ts";
export type { ForwardPortResult } from "./ports.ts";
