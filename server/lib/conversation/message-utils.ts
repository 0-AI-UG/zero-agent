import type { Message } from "@/lib/messages/types.ts";

export function extractTextFromMessage(message: Message): string {
  if (Array.isArray(message.parts)) {
    return message.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n");
  }
  return "";
}

export function extractConversationText(messages: Message[], lastN = 10): string {
  return messages
    .slice(-lastN)
    .map((m) => `${m.role}: ${extractTextFromMessage(m)}`)
    .filter((t) => t.length > 5)
    .join("\n\n");
}
