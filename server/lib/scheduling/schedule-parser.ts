const MIN_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

const INTERVAL_RE = /^every\s+(\d+)\s*(m|h|d)$/i;

const UNIT_MS: Record<string, number> = {
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

// Simple cron: "minute hour dom month dow" (5 fields)
const CRON_RE = /^(\d+|\*)\s+(\d+|\*)\s+(\d+|\*)\s+(\d+|\*)\s+(\d+|\*)$/;

export function parseSchedule(schedule: string): { valid: boolean; error?: string } {
  const trimmed = schedule.trim();

  const intervalMatch = trimmed.match(INTERVAL_RE);
  if (intervalMatch) {
    const value = parseInt(intervalMatch[1]!, 10);
    const unit = intervalMatch[2]!.toLowerCase();
    const ms = value * UNIT_MS[unit]!;
    if (ms < MIN_INTERVAL_MS) {
      return { valid: false, error: "Minimum interval is 15 minutes" };
    }
    return { valid: true };
  }

  if (CRON_RE.test(trimmed)) {
    return { valid: true };
  }

  return { valid: false, error: "Invalid schedule format. Use 'every 30m', 'every 2h', 'every 1d', or cron syntax '0 9 * * *'" };
}

export function computeNextRun(schedule: string, from: Date = new Date()): Date {
  const trimmed = schedule.trim();

  const intervalMatch = trimmed.match(INTERVAL_RE);
  if (intervalMatch) {
    const value = parseInt(intervalMatch[1]!, 10);
    const unit = intervalMatch[2]!.toLowerCase();
    const ms = value * UNIT_MS[unit]!;
    return new Date(from.getTime() + ms);
  }

  // Cron parsing
  const cronMatch = trimmed.match(CRON_RE);
  if (cronMatch) {
    const [, minute, hour, dom, month, dow] = cronMatch;
    return nextCronOccurrence(
      minute!, hour!, dom!, month!, dow!, from,
    );
  }

  // Fallback: 2 hours from now
  return new Date(from.getTime() + 2 * 60 * 60 * 1000);
}

function nextCronOccurrence(
  minuteSpec: string,
  hourSpec: string,
  domSpec: string,
  monthSpec: string,
  dowSpec: string,
  from: Date,
): Date {
  // Simple implementation: iterate minute by minute up to 48 hours
  const maxIterations = 48 * 60;
  const candidate = new Date(from.getTime());
  // Start from next minute
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  for (let i = 0; i < maxIterations; i++) {
    const m = candidate.getUTCMinutes();
    const h = candidate.getUTCHours();
    const d = candidate.getUTCDate();
    const mo = candidate.getUTCMonth() + 1;
    const wd = candidate.getUTCDay();

    if (
      matchesCronField(minuteSpec, m) &&
      matchesCronField(hourSpec, h) &&
      matchesCronField(domSpec, d) &&
      matchesCronField(monthSpec, mo) &&
      matchesCronField(dowSpec, wd)
    ) {
      return candidate;
    }

    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }

  // Fallback
  return new Date(from.getTime() + 24 * 60 * 60 * 1000);
}

function matchesCronField(spec: string, value: number): boolean {
  if (spec === "*") return true;
  return parseInt(spec, 10) === value;
}

export function formatDateForSQLite(date: Date): string {
  return date.toISOString().replace("T", " ").replace("Z", "").split(".")[0]!;
}
