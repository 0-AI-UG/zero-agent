const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";

export interface Logger {
  info: (msg: string) => void;
  debug: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  success: (msg: string) => void;
  banner: (lines: string[]) => void;
}

export function createLogger(verbose: boolean): Logger {
  return {
    info: (msg: string) => console.log(msg),
    debug: (msg: string) => {
      if (verbose) console.log(`${DIM}[debug] ${msg}${RESET}`);
    },
    warn: (msg: string) => console.warn(`${YELLOW}⚠ ${msg}${RESET}`),
    error: (msg: string) => console.error(`${RED}✗ ${msg}${RESET}`),
    success: (msg: string) => console.log(`${GREEN}✓${RESET} ${msg}`),
    banner: (lines: string[]) => {
      console.log(`${CYAN}${BOLD}`);
      for (const line of lines) console.log(`  ${line}`);
      console.log(RESET);
    },
  };
}
