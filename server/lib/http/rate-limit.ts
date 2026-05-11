/**
 * In-memory sliding-window rate limiter.
 */

export class RateLimiter {
  private windows = new Map<string, number[]>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(
    private maxAttempts: number,
    private windowMs: number,
  ) {
    // Periodic cleanup every 5 minutes to prevent memory leaks
    this.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  /**
   * Check if a key is currently blocked. Does NOT record an attempt -
   * call `record()` separately on auth failure.
   */
  check(key: string): { allowed: boolean; retryAfterSeconds: number } {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    let timestamps = this.windows.get(key);
    if (timestamps) {
      // Remove expired entries
      timestamps = timestamps.filter((t) => t > cutoff);
      this.windows.set(key, timestamps);
    } else {
      timestamps = [];
      this.windows.set(key, timestamps);
    }

    if (timestamps.length >= this.maxAttempts) {
      const oldest = timestamps[0]!;
      const retryAfterSeconds = Math.ceil((oldest + this.windowMs - now) / 1000);
      return { allowed: false, retryAfterSeconds };
    }

    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Record a failed attempt for the given key. */
  record(key: string): void {
    const now = Date.now();
    const timestamps = this.windows.get(key) ?? [];
    timestamps.push(now);
    this.windows.set(key, timestamps);
  }

  private cleanup() {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    for (const [key, timestamps] of this.windows) {
      const valid = timestamps.filter((t) => t > cutoff);
      if (valid.length === 0) {
        this.windows.delete(key);
      } else {
        this.windows.set(key, valid);
      }
    }
  }

  destroy() {
    clearInterval(this.cleanupTimer);
  }
}

/** 10 failed attempts per 15 minutes for auth endpoints */
export const authRateLimiter = new RateLimiter(10, 15 * 60 * 1000);

const TRUST_PROXY = process.env.TRUST_PROXY === "1";

/** Extract the client IP. Only trust X-Forwarded-For when TRUST_PROXY=1. */
export function getClientIP(request: Request): string {
  if (TRUST_PROXY) {
    const xff = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    if (xff) return xff;
    const xri = request.headers.get("x-real-ip");
    if (xri) return xri;
  }
  // Without a trusted proxy, use the per-connection address surfaced by the
  // server adapter (see hono node-server integration in server/index.ts).
  return (request as any).socketIp ?? "unknown";
}

/** Record a failed auth attempt for the request's client IP. */
export function recordAuthFailure(request: Request): void {
  authRateLimiter.record(getClientIP(request));
}
