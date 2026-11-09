// Dates for people: relative times, chat-list day groups, short date-times, and turning the
// simple schedule picker (daily / weekdays / weekly / hourly) into cron and back into words.

// ---------- constants ----------
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_DAYS = 7;
const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
/** Cron shapes the picker can produce: "m h * * *", "m h * * 1-5", "m h * * d", "m * * * *". */
const DAILY = /^(\d{1,2}) (\d{1,2}) \* \* \*$/;
const WEEKDAYS = /^(\d{1,2}) (\d{1,2}) \* \* 1-5$/;
const WEEKLY = /^(\d{1,2}) (\d{1,2}) \* \* ([0-6])$/;
const HOURLY = /^(\d{1,2}) \* \* \* \*$/;

// ---------- relative time ----------
export function relativeTime(ts, now = Date.now()) {
  const diff = now - ts;
  const future = diff < 0;
  const abs = Math.abs(diff);
  if (abs < MINUTE_MS) return future ? "in a moment" : "just now";
  const phrase = (n, unit) => (future ? `in ${n} ${unit}` : `${n} ${unit} ago`);
  if (abs < HOUR_MS) return phrase(Math.round(abs / MINUTE_MS), "min");
  if (abs < DAY_MS) return phrase(Math.round(abs / HOUR_MS), "h");
  if (abs < WEEK_DAYS * DAY_MS) return phrase(Math.round(abs / DAY_MS), "d");
  return shortDate(ts);
}

/** Chat-list group for a timestamp. */
export function dayGroup(ts, now = new Date()) {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= startOfToday) return "Today";
  if (ts >= startOfToday - DAY_MS) return "Yesterday";
  if (ts >= startOfToday - WEEK_DAYS * DAY_MS) return "Previous 7 days";
  return "Earlier";
}

export function shortDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "Mon, Nov 10, 8:00 AM" */
export function dateTime(ts) {
  return new Date(ts).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function localTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    // very old browsers: the server treats UTC as the safe default
    return "UTC";
  }
}

// ---------- schedules ----------
/** Picker state → cron. `time` is "HH:MM"; `day` is 0–6 (Sunday = 0). */
export function toCron({ repeat, time, day, cron }) {
  if (repeat === "custom") return cron.trim();
  const [hour, minute] = (time || "08:00").split(":").map(Number);
  if (repeat === "hourly") return `${minute} * * * *`;
  if (repeat === "weekdays") return `${minute} ${hour} * * 1-5`;
  if (repeat === "weekly") return `${minute} ${hour} * * ${day}`;
  return `${minute} ${hour} * * *`;
}

/** Cron → picker state (custom when it isn't one of the simple shapes). */
export function fromCron(cron) {
  const c = cron.trim();
  const daily = c.match(DAILY);
  if (daily) return { repeat: "daily", time: hhmm(daily[2], daily[1]), day: 1 };
  const weekdays = c.match(WEEKDAYS);
  if (weekdays) return { repeat: "weekdays", time: hhmm(weekdays[2], weekdays[1]), day: 1 };
  const weekly = c.match(WEEKLY);
  if (weekly) return { repeat: "weekly", time: hhmm(weekly[2], weekly[1]), day: Number(weekly[3]) };
  const hourly = c.match(HOURLY);
  if (hourly) return { repeat: "hourly", time: hhmm(0, hourly[1]), day: 1 };
  return { repeat: "custom", time: "08:00", day: 1, cron: c };
}

/** Cron in words, for the simple shapes; otherwise the expression itself. */
export function describeCron(cron) {
  const s = fromCron(cron);
  const at = s.repeat === "hourly" ? "" : ` at ${clock(s.time)}`;
  if (s.repeat === "daily") return `Every day${at}`;
  if (s.repeat === "weekdays") return `Weekdays${at}`;
  if (s.repeat === "weekly") return `Every ${WEEKDAY_NAMES[s.day]}${at}`;
  if (s.repeat === "hourly") return `Every hour at :${s.time.slice(3)}`;
  return `Cron ${cron}`;
}

export function weekdayNames() {
  return WEEKDAY_NAMES;
}

// ---------- helpers ----------
function hhmm(hour, minute) {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function clock(time) {
  const [h, m] = time.split(":").map(Number);
  const d = new Date(2000, 0, 1, h, m);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
