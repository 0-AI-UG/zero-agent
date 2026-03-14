type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? "debug";

interface LogEntry {
  level: LogLevel;
  msg: string;
  time: string;
  [key: string]: unknown;
}

type Context = Record<string, unknown>;

const isDev = process.env.BUN_ENV !== "production";

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: ANSI.gray,
  info: ANSI.cyan,
  warn: ANSI.yellow,
  error: ANSI.red,
};

function formatDev(level: LogLevel, msg: string, ctx: Context): string {
  const now = new Date();
  const time = now.toTimeString().slice(0, 8);
  const color = LEVEL_COLORS[level];
  const label = level.toUpperCase().padEnd(5);

  const { module, error, errorName, stack, ...rest } = ctx as Record<
    string,
    unknown
  >;

  let line = `${ANSI.dim}${time}${ANSI.reset} ${color}${label}${ANSI.reset}`;

  if (module) {
    line += `  ${module} ▸`;
  }

  line += ` ${msg}`;

  const pairs = Object.entries(rest);
  if (pairs.length > 0) {
    const kv = pairs.map(([k, v]) => `${k}=${v}`).join(" ");
    line += `  ${ANSI.dim}${kv}${ANSI.reset}`;
  }

  if (error) {
    line += `  ${ANSI.red}${errorName ?? "Error"}: ${error}${ANSI.reset}`;
  }
  if (stack) {
    line += `\n${ANSI.red}${stack}${ANSI.reset}`;
  }

  return line;
}

function write(level: LogLevel, msg: string, ctx: Context) {
  if (LEVELS[level] < LEVELS[currentLevel]) return;

  const entry: LogEntry = {
    level,
    msg,
    time: new Date().toISOString(),
    ...ctx,
  };

  if (isDev) {
    const line = formatDev(level, msg, ctx);
    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }
    return;
  }

  const line = JSON.stringify(entry);

  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const result: Record<string, unknown> = {
      error: err.message,
      errorName: err.name,
    };
    if (process.env.BUN_ENV !== "production") {
      result.stack = err.stack;
    }
    return result;
  }
  return { error: String(err) };
}

class Logger {
  private ctx: Context;

  constructor(ctx: Context = {}) {
    this.ctx = ctx;
  }

  child(extra: Context): Logger {
    return new Logger({ ...this.ctx, ...extra });
  }

  debug(msg: string, extra: Context = {}) {
    write("debug", msg, { ...this.ctx, ...extra });
  }

  info(msg: string, extra: Context = {}) {
    write("info", msg, { ...this.ctx, ...extra });
  }

  warn(msg: string, extra: Context = {}) {
    write("warn", msg, { ...this.ctx, ...extra });
  }

  error(msg: string, err?: unknown, extra: Context = {}) {
    const errCtx = err ? serializeError(err) : {};
    write("error", msg, { ...this.ctx, ...errCtx, ...extra });
  }
}

export const log = new Logger();
export type { Logger };
