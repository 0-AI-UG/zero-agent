// Codex inference provider - routes chat through the user's ChatGPT subscription
// using OAuth tokens issued by the official `openai/codex` PKCE flow.
//
// References (openai/codex on GitHub, codex-rs/):
//   - login/src/auth/manager.rs:779   pub const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
//   - login/src/auth/manager.rs:85    REFRESH_TOKEN_URL = "https://auth.openai.com/oauth/token"
//   - login/src/server.rs:468         build_authorize_url() - issuer + scopes + PKCE
//   - core/src/config/mod.rs          base URL "https://chatgpt.com/backend-api/"
//   - response-debug-context/src/lib.rs   "https://chatgpt.com/backend-api/codex/responses"
//   - backend-client/src/client.rs    sends ChatGPT-Account-Id and originator headers

import { createOpenAI } from "@ai-sdk/openai";
import { wrapLanguageModel, extractReasoningMiddleware } from "ai";
import { getSetting } from "@/lib/settings.ts";
import type { InferenceProvider, SpecializedKind } from "@/lib/providers/types.ts";
import {
  imageToolResultMiddleware,
  circuitBreakerMiddleware,
  retryFetch,
} from "@/lib/providers/middleware.ts";
import {
  CODEX_API_BASE,
  CODEX_ORIGINATOR,
  getValidTokens,
} from "@/lib/providers/codex-tokens.ts";

const DEFAULT_CODEX_MODEL = "gpt-5";

function getDefaultModelId(): string {
  return getSetting("CODEX_MODEL") ?? DEFAULT_CODEX_MODEL;
}

// Custom fetch: injects Bearer + ChatGPT-Account-Id, refreshes on 401 once.
async function codexFetchImpl(input: any, init?: any): Promise<Response> {
  let tokens = await getValidTokens(false);
  const buildHeaders = (t: typeof tokens) => {
    const h = new Headers(init?.headers ?? {});
    h.set("Authorization", `Bearer ${t.accessToken}`);
    if (t.accountId) h.set("ChatGPT-Account-Id", t.accountId);
    h.set("originator", CODEX_ORIGINATOR);
    return h;
  };
  const baseFetch = retryFetch(fetch);
  let res = await baseFetch(input, { ...init, headers: buildHeaders(tokens) });
  if (res.status === 401) {
    tokens = await getValidTokens(true);
    res = await baseFetch(input, { ...init, headers: buildHeaders(tokens) });
  }
  return res;
}

const codexFetch: typeof fetch = codexFetchImpl as typeof fetch;

let _client: ReturnType<typeof createOpenAI> | null = null;
function getCodexClient() {
  if (_client) return _client;
  _client = createOpenAI({
    apiKey: "unused-oauth",
    baseURL: CODEX_API_BASE,
    fetch: codexFetch,
  });
  return _client;
}

function wrapChatModel(modelId: string) {
  return wrapLanguageModel({
    model: getCodexClient().responses(modelId),
    middleware: [
      circuitBreakerMiddleware,
      imageToolResultMiddleware,
      extractReasoningMiddleware({ tagName: "think" }),
    ],
  });
}

export const codexProvider: InferenceProvider = {
  id: "codex",
  displayName: "ChatGPT (Codex OAuth)",
  capabilities: { chat: true, vision: true, image: false, embedding: false },

  getDefaultChatModelId() {
    return getDefaultModelId();
  },

  getChatModel(modelId?: string) {
    return wrapChatModel(modelId ?? getDefaultModelId());
  },

  getVisionModel(modelId?: string) {
    return getCodexClient().responses(modelId ?? getDefaultModelId());
  },

  getSpecializedChatModel(_kind: SpecializedKind, modelId?: string) {
    return wrapChatModel(modelId ?? getDefaultModelId());
  },

  getImageModel(): never {
    throw new Error("codex provider does not support image generation");
  },

  getEmbeddingModel(): never {
    throw new Error("codex provider does not support embeddings");
  },

  parseConfig() {
    return undefined;
  },
};
