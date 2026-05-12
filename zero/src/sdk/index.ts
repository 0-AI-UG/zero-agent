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
export { message } from "./message.ts";
export type { MessageSendResult } from "./message.ts";
export { schedule } from "./schedule.ts";
export type { ScheduledTask, AddTaskInput, UpdateTaskInput } from "./schedule.ts";
export { image } from "./image.ts";
export type { GenerateImageResult } from "./image.ts";
export { creds } from "./creds.ts";
export type { CredentialSummary, CredGetResult, SetCredentialInput } from "./creds.ts";
export { browser } from "./browser.ts";
export type { BrowserResult } from "./browser.ts";
export { apps } from "./apps.ts";
export type { AppRecord, CreateAppResult, DeleteAppResult, ListAppsResult } from "./apps.ts";
export { llm } from "./llm.ts";
export type { LlmGenerateResponse } from "./llm.ts";
export { embed } from "./embed.ts";
export type { EmbedResponse } from "./embed.ts";
export { search } from "./search.ts";
export type { SearchResult, SearchResponse } from "./search.ts";
export { trigger } from "./trigger.ts";
