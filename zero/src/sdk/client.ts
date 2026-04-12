/**
 * HTTP client used by both the SDK and the CLI. Auth resolution happens
 * here exactly once: the client reads ZERO_PROXY_URL from the environment.
 * The runner injects this env var at container create time. Containers
 * never hold a server credential - the runner stamps the verified
 * (projectId, userId) onto the request before forwarding to the server.
 *
 * Transport: ZERO_PROXY_URL is `unix:<path>` (e.g. `unix:/run/zero/sock`).
 * Each managed container gets its own bind-mounted Unix socket; identity
 * is established by the bind-mount itself, so there is no token, no DNS,
 * and no port. A legacy `http(s)://` URL is also accepted as an escape
 * hatch for non-runner test environments.
 *
 * Timeouts: every call has a deadline. The default is 60s, overridable
 * globally via ZERO_REQUEST_TIMEOUT_MS or per-call via the `timeoutMs`
 * option. The deadline is also forwarded to the server as
 * `X-Zero-Deadline` so downstream layers can race against the same clock
 * the SDK is using and we can't end up with an outer layer slower than
 * an inner one.
 */
import { ZeroError } from "./errors.ts";
import type { ApiResponse } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 60_000;
const PROXY_PATH_PREFIX = "/v1/proxy";

export interface CallOptions {
  /** Hard deadline for the entire request, in ms. */
  timeoutMs?: number;
  /** External signal - if it aborts, so does the request. */
  signal?: AbortSignal;
}

interface ResolvedTarget {
  url: string;
  /** undici Agent, used by Node's global fetch to route over a Unix socket. */
  dispatcher?: unknown;
  /** Bun's native unix-socket option on fetch. Bun ignores `dispatcher`. */
  unix?: string;
}

let cachedDispatcher: { socketPath: string; dispatcher: unknown } | null = null;

async function unixDispatcher(socketPath: string): Promise<unknown> {
  if (cachedDispatcher && cachedDispatcher.socketPath === socketPath) {
    return cachedDispatcher.dispatcher;
  }
  // undici is bundled with Node 18+ and powers global fetch.
  const { Agent } = (await import("undici")) as { Agent: new (opts: any) => unknown };
  const dispatcher = new Agent({ connect: { socketPath } });
  cachedDispatcher = { socketPath, dispatcher };
  return dispatcher;
}

async function resolveTarget(path: string): Promise<ResolvedTarget> {
  const env = process.env.ZERO_PROXY_URL;
  if (!env) {
    throw new ZeroError(
      "no_proxy_url",
      "ZERO_PROXY_URL is not set. The zero CLI/SDK only works inside a runner-managed container.",
    );
  }
  const apiPath = path.startsWith("/") ? path : `/${path}`;

  if (env.startsWith("unix:")) {
    // Accept either `unix:/path` or `unix:///path`.
    const socketPath = env.replace(/^unix:(\/\/)?/, "");
    if (!socketPath) {
      throw new ZeroError("no_proxy_url", `Invalid ZERO_PROXY_URL: ${env}`);
    }
    const url = `http://localhost${PROXY_PATH_PREFIX}${apiPath}`;
    // Bun's fetch has native unix-socket support via the `unix` option and
    // does NOT understand undici's `dispatcher`. Branch on runtime.
    if (typeof (globalThis as any).Bun !== "undefined") {
      return { url, unix: socketPath };
    }
    const dispatcher = await unixDispatcher(socketPath);
    return { url, dispatcher };
  }

  const base = env.replace(/\/+$/, "");
  return { url: `${base}${apiPath}` };
}

function envTimeout(): number {
  const raw = process.env.ZERO_REQUEST_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

/** Combines an external signal (if any) with a timeout signal. */
function deadlineSignal(timeoutMs: number, external?: AbortSignal): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!external) return { signal: timeout, cleanup: () => {} };
  // AbortSignal.any was standardised in Node 20+ / Bun.
  if (typeof (AbortSignal as any).any === "function") {
    return { signal: (AbortSignal as any).any([timeout, external]), cleanup: () => {} };
  }
  // Manual fallback.
  const ac = new AbortController();
  const onAbort = () => ac.abort(timeout.reason ?? external.reason);
  timeout.addEventListener("abort", onAbort);
  external.addEventListener("abort", onAbort);
  return {
    signal: ac.signal,
    cleanup: () => {
      timeout.removeEventListener("abort", onAbort);
      external.removeEventListener("abort", onAbort);
    },
  };
}

export async function call<T = unknown>(
  path: string,
  body: unknown = {},
  options: CallOptions = {},
): Promise<T> {
  const target = await resolveTarget(path);
  const url = target.url;
  const timeoutMs = options.timeoutMs ?? envTimeout();
  const { signal, cleanup } = deadlineSignal(timeoutMs, options.signal);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Zero-Deadline": String(timeoutMs),
      },
      body: JSON.stringify(body ?? {}),
      signal,
      // undici-specific dispatcher: routes the request over a Unix socket
      // when ZERO_PROXY_URL is `unix:...` under Node. Ignored by Bun.
      ...(target.dispatcher ? { dispatcher: target.dispatcher } : {}),
      // Bun-specific: native unix-socket fetch. Ignored by Node.
      ...(target.unix ? { unix: target.unix } : {}),
    } as any);
  } catch (err) {
    if ((err as any)?.name === "TimeoutError" || (err as any)?.name === "AbortError") {
      throw new ZeroError("timeout", `Request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw new ZeroError("network", `Request to ${url} failed: ${String(err)}`);
  } finally {
    cleanup();
  }

  let json: ApiResponse<T> | undefined;
  try {
    json = (await res.json()) as ApiResponse<T>;
  } catch {
    throw new ZeroError(
      "bad_response",
      `Non-JSON response from ${url} (status ${res.status})`,
    );
  }

  if (!json || typeof json !== "object" || !("ok" in json)) {
    throw new ZeroError("bad_response", `Malformed response from ${url}`);
  }

  if (!json.ok) {
    throw new ZeroError(json.error.code, json.error.message);
  }

  return json.data;
}
