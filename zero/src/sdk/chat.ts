import { call, type CallOptions } from "./client.ts";
import { ChatSearchInput } from "./schemas.ts";

export interface ChatSearchHit {
  chatId: string;
  role: string;
  snippet: string;
  score: number;
}

export const chat = {
  search(query: string, limit?: number, options?: CallOptions): Promise<ChatSearchHit[]> {
    const body = ChatSearchInput.parse({ query, limit });
    return call<ChatSearchHit[]>("/zero/chat/search", body, options);
  },
};
