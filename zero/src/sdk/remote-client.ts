/**
 * Remote-mode HTTP client for the laptop companion. Unlike `client.ts` (which
 * POSTs to the in-container `/v1/proxy/*` unix socket and unwraps an {ok,data}
 * envelope), this hits the server's public `/api/*` REST surface with a
 * companion-token bearer and parses the raw JSON shape those routes return,
 * using HTTP status for success/failure.
 */
import { ZeroError } from "./errors.ts";
import { requireConfig, type CompanionConfig } from "./config.ts";

const DEFAULT_TIMEOUT_MS = 60_000;

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

export interface RemoteCallOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Override the config-resolved base URL/token (used by `zero login` probes). */
  config?: CompanionConfig;
}

function envTimeout(): number {
  const raw = process.env.ZERO_REQUEST_TIMEOUT_MS;
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

/**
 * Issue a request against the zero server's /api surface.
 *
 * `path` is the API path beginning with `/api/` (e.g. `/api/projects`).
 * Returns the parsed JSON body. On non-2xx, throws a ZeroError carrying the
 * server's `{ error }` message when present.
 */
export async function apiRequest<T = unknown>(
  method: HttpMethod,
  path: string,
  body?: unknown,
  options: RemoteCallOptions = {},
): Promise<T> {
  const cfg = options.config ?? requireConfig();
  const base = cfg.baseUrl.replace(/\/+$/, "");
  const apiPath = path.startsWith("/") ? path : `/${path}`;
  const url = `${base}${apiPath}`;
  const timeoutMs = options.timeoutMs ?? envTimeout();

  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal
    ? (AbortSignal as any).any?.([timeout, options.signal]) ?? timeout
    : timeout;

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.token}`,
      },
      body: body !== undefined && method !== "GET" ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    if ((err as any)?.name === "TimeoutError" || (err as any)?.name === "AbortError") {
      throw new ZeroError("timeout", `Request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw new ZeroError("network", `Request to ${url} failed: ${String(err)}`);
  }

  const text = await res.text();
  let json: any = undefined;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      if (!res.ok) {
        throw new ZeroError("http_error", `HTTP ${res.status} from ${url}`);
      }
      throw new ZeroError("bad_response", `Non-JSON response from ${url}`);
    }
  }

  if (!res.ok) {
    const message = json?.error ?? `HTTP ${res.status}`;
    const code = res.status === 401 || res.status === 403 ? "unauthorized" : "http_error";
    throw new ZeroError(code, typeof message === "string" ? message : JSON.stringify(message));
  }

  return json as T;
}

/** Resolve the project id to act on: explicit arg wins, else the bound project. */
export function resolveProjectId(explicit?: string): string {
  if (explicit) return explicit;
  return requireConfig().projectId;
}
