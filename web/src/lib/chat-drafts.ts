const PREFIX = "chat-draft:";

export function draftKey(chatId: string): string {
  return `${PREFIX}${chatId}`;
}

export function readDraft(chatId: string): string {
  if (typeof localStorage === "undefined") return "";
  return localStorage.getItem(draftKey(chatId)) ?? "";
}

export function writeDraft(chatId: string, value: string): void {
  if (typeof localStorage === "undefined") return;
  if (value) localStorage.setItem(draftKey(chatId), value);
  else localStorage.removeItem(draftKey(chatId));
}

export function clearDraft(chatId: string): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(draftKey(chatId));
}

/** Remove drafts whose chatId isn't in `liveChatIds`. */
export function pruneDrafts(liveChatIds: Iterable<string>): void {
  if (typeof localStorage === "undefined") return;
  const live = new Set(liveChatIds);
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(PREFIX)) continue;
    const id = key.slice(PREFIX.length);
    if (!live.has(id)) localStorage.removeItem(key);
  }
}
