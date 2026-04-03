import { log } from "@/lib/logger.ts";

const cbLog = log.child({ module: "circuit-breaker" });

type CircuitState = "closed" | "open" | "half-open";

interface CircuitBreakerOptions {
  /** Number of consecutive failures before opening the circuit */
  failureThreshold?: number;
  /** Time in ms to keep the circuit open before trying half-open */
  resetTimeoutMs?: number;
}

class CircuitBreaker {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private lastFailureTime = 0;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30_000;
  }

  getState(): CircuitState {
    if (this.state === "open" && Date.now() - this.lastFailureTime >= this.resetTimeoutMs) {
      this.state = "half-open";
      cbLog.info("circuit breaker half-open, allowing test request");
    }
    return this.state;
  }

  isOpen(): boolean {
    return this.getState() === "open";
  }

  recordSuccess(): void {
    if (this.state === "half-open") {
      cbLog.info("circuit breaker closed after successful test request");
    }
    this.state = "closed";
    this.consecutiveFailures = 0;
  }

  recordFailure(): void {
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();

    if (this.state === "half-open") {
      // Failed during test request, re-open
      this.state = "open";
      cbLog.warn("circuit breaker re-opened after half-open failure");
      return;
    }

    if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = "open";
      cbLog.warn("circuit breaker opened", {
        consecutiveFailures: this.consecutiveFailures,
        resetTimeoutMs: this.resetTimeoutMs,
      });
    }
  }
}

/** Singleton circuit breaker for LLM API calls */
export const llmCircuitBreaker = new CircuitBreaker();

export class CircuitBreakerOpenError extends Error {
  constructor() {
    super("Circuit breaker is open — LLM API is temporarily unavailable");
    this.name = "CircuitBreakerOpenError";
  }
}
