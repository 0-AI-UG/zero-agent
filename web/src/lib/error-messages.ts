/**
 * Chat errors arrive from the server as raw technical strings (an exception's
 * `err.message`: stack-y SDK errors, HTTP status text, provider payloads). We
 * don't want to surface those verbatim — they're noise to the user and can leak
 * internals. This maps a raw error to a short, generic, user-facing line.
 *
 * A few broad, genuinely-actionable categories get a tailored (but still
 * non-technical) message; everything else falls back to a single generic line.
 */
const GENERIC = "Something went wrong. Please try again.";

const CATEGORIES: Array<{ match: RegExp; message: string }> = [
  {
    // Rate limits / provider overload (429, "overloaded", "capacity").
    match: /\b(429|rate.?limit|overloaded|too many requests|capacity)\b/i,
    message: "The service is busy right now. Please try again in a moment.",
  },
  {
    // Network / connectivity failures.
    match: /\b(network|fetch failed|econnrefused|enotfound|econnreset|socket|offline|dns)\b/i,
    message: "Connection problem. Please check your network and try again.",
  },
  {
    // Request took too long.
    match: /\b(timed?.?out|timeout|etimedout|deadline)\b/i,
    message: "The request timed out. Please try again.",
  },
  {
    // Conversation exceeded the model's context window.
    match: /\b(context length|context window|too many tokens|maximum.*tokens|token limit)\b/i,
    message: "This conversation is too long for the model. Try starting a new chat.",
  },
  {
    // Auth / permission issues.
    match: /\b(401|403|unauthorized|forbidden|invalid api key|authentication)\b/i,
    message: "There was an authentication problem. Please reconnect and try again.",
  },
];

/**
 * Turn a raw error string into a generic, user-facing message. Returns the
 * generic fallback when the input is empty or unrecognized.
 */
export function friendlyErrorMessage(raw?: string | null): string {
  if (!raw) return GENERIC;
  for (const { match, message } of CATEGORIES) {
    if (match.test(raw)) return message;
  }
  return GENERIC;
}
