/** Minimal structured logger for the runner service. */

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  level: LogLevel;
  module?: string;
  msg: string;
  [key: string]: unknown;
}

function formatEntry(entry: LogEntry): string {
  const { level, module, msg, ...rest } = entry;
  const prefix = module ? `[${module}]` : "";
  const extra = Object.keys(rest).length > 0 ? " " + JSON.stringify(rest) : "";
  return `${new Date().toISOString()} ${level.toUpperCase()} ${prefix} ${msg}${extra}`;
}

class Logger {
  private module?: string;

  constructor(module?: string) {
    this.module = module;
  }

  child(opts: { module: string }): Logger {
    return new Logger(opts.module);
  }

  debug(msg: string, data?: Record<string, unknown>) {
    if (process.env.LOG_LEVEL === "debug") {
      console.log(formatEntry({ level: "debug", module: this.module, msg, ...data }));
    }
  }

  info(msg: string, data?: Record<string, unknown>) {
    console.log(formatEntry({ level: "info", module: this.module, msg, ...data }));
  }

  warn(msg: string, data?: Record<string, unknown>) {
    console.warn(formatEntry({ level: "warn", module: this.module, msg, ...data }));
  }

  error(msg: string, data?: Record<string, unknown>) {
    console.error(formatEntry({ level: "error", module: this.module, msg, ...data }));
  }
}

export const log = new Logger();
