import { call, type CallOptions } from "./client.ts";
import {
  BrowserOpenInput,
  BrowserClickInput,
  BrowserFillInput,
  BrowserScreenshotInput,
  BrowserEvaluateInput,
  BrowserWaitInput,
  BrowserSnapshotInput,
  BrowserExtractInput,
} from "./schemas.ts";

/** Result shape mirrors the runner browser backend output. */
export type BrowserResult = any;

// Browser actions can stall on slow pages, so give them a longer
// per-call deadline than the SDK default.
const BROWSER_DEFAULT: CallOptions = { timeoutMs: 90_000 };

export const browser = {
  open(url: string, options?: CallOptions): Promise<BrowserResult> {
    return call("/zero/browser/open", BrowserOpenInput.parse({ url }), { ...BROWSER_DEFAULT, ...options });
  },
  click(ref: string, options?: CallOptions): Promise<BrowserResult> {
    return call("/zero/browser/click", BrowserClickInput.parse({ ref }), { ...BROWSER_DEFAULT, ...options });
  },
  fill(ref: string, text: string, opts?: { submit?: boolean }, options?: CallOptions): Promise<BrowserResult> {
    return call(
      "/zero/browser/fill",
      BrowserFillInput.parse({ ref, text, submit: opts?.submit }),
      { ...BROWSER_DEFAULT, ...options },
    );
  },
  screenshot(options?: CallOptions): Promise<BrowserResult> {
    return call("/zero/browser/screenshot", BrowserScreenshotInput.parse({}), { ...BROWSER_DEFAULT, ...options });
  },
  evaluate(script: string, opts?: { awaitPromise?: boolean }, options?: CallOptions): Promise<BrowserResult> {
    return call(
      "/zero/browser/evaluate",
      BrowserEvaluateInput.parse({ script, awaitPromise: opts?.awaitPromise }),
      { ...BROWSER_DEFAULT, ...options },
    );
  },
  wait(ms: number, options?: CallOptions): Promise<BrowserResult> {
    return call("/zero/browser/wait", BrowserWaitInput.parse({ ms }), { ...BROWSER_DEFAULT, ...options });
  },
  snapshot(opts?: { mode?: "interactive" | "full"; selector?: string }, options?: CallOptions): Promise<BrowserResult> {
    return call(
      "/zero/browser/snapshot",
      BrowserSnapshotInput.parse(opts ?? {}),
      { ...BROWSER_DEFAULT, ...options },
    );
  },
  /**
   * Pull only the paragraphs most relevant to `query` out of the currently
   * loaded page. Token-efficient alternative to dumping a full snapshot or
   * outerHTML when you're hunting for a specific fact on a content-heavy page.
   */
  extract(
    query: string,
    opts?: { maxExcerpts?: number },
    options?: CallOptions,
  ): Promise<BrowserResult> {
    return call(
      "/zero/browser/extract",
      BrowserExtractInput.parse({ query, maxExcerpts: opts?.maxExcerpts }),
      { ...BROWSER_DEFAULT, ...options },
    );
  },
  /** status() is an alias for snapshot() — returns current page state. */
  status(options?: CallOptions): Promise<BrowserResult> {
    return call("/zero/browser/snapshot", BrowserSnapshotInput.parse({}), { ...BROWSER_DEFAULT, ...options });
  },
};
