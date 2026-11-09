// Cron schedules for scheduled tasks (croner): five-field expressions evaluated in an IANA
// timezone. Pure functions; callers turn the problems they report into user-facing errors.
import { Cron } from "croner";

// ---------- constants ----------
/** Classic five fields only: minute hour day-of-month month day-of-week. */
const CRON_MODE = "5-part" as const;
/** croner prefixes its messages with the class that threw ("CronPattern: …"). */
const CRONER_MESSAGE_PREFIX = /^Cron\w*:\s*/;
const TIMEZONE_PROBE_LOCALE = "en-US";

// ---------- cron ----------
/** The canonical IANA name (`asia/kolkata` → `Asia/Kolkata`), or null when it isn't a timezone. */
export function canonicalTimezone(name: string): string | null {
  try {
    const format = new Intl.DateTimeFormat(TIMEZONE_PROBE_LOCALE, { timeZone: name });
    return format.resolvedOptions().timeZone;
  } catch {
    // RangeError: not a timezone this runtime knows; the caller reports it as invalid
    return null;
  }
}

/** Why `schedule` isn't a usable five-field cron expression; null when it is. */
export function cronProblem(schedule: string): string | null {
  try {
    const job = new Cron(schedule, { mode: CRON_MODE, paused: true });
    return job.nextRun() ? null : "it never fires (no date matches it)";
  } catch (e) {
    return String((e as Error).message).replace(CRONER_MESSAGE_PREFIX, "");
  }
}

/**
 * The first time `schedule` fires strictly after `after`, as wall-clock time in `timezone`;
 * null when it never fires again. Throws on an invalid expression or timezone.
 */
export function nextCronRun(schedule: string, timezone: string, after: Date): Date | null {
  const job = new Cron(schedule, { mode: CRON_MODE, timezone, paused: true });
  return job.nextRun(after);
}
