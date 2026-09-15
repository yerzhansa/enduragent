// ============================================================================
// USER TIME — timezone-aware date/time helpers
// ============================================================================
//
// Ported from openclaw (`src/agents/{date-time,current-time}.ts`). Solves the
// "today is the wrong day near midnight" class of bug by:
//   1. Resolving the athlete timezone once via a tiered fallback chain.
//   2. Putting only the *timezone name* in the system prompt (cache-stable).
//   3. Appending a fresh, idempotent "Current time:" line to each user message.

const FALLBACK_TZ = "UTC";

/**
 * Resolve an IANA timezone string. Tries the configured value first, validating
 * via `Intl.DateTimeFormat`; falls back to host TZ, then "UTC". Logs a warning
 * whenever it falls back so misconfiguration is visible (vs silently UTC).
 */
export function resolveUserTimezone(configured?: string): string {
  const trimmed = configured?.trim();
  if (trimmed) {
    if (isValidTimezone(trimmed)) return trimmed;
    console.warn(`Invalid timezone "${trimmed}"; falling back to host TZ.`);
  }
  const host = Intl.DateTimeFormat().resolvedOptions().timeZone?.trim();
  if (host && isValidTimezone(host)) {
    if (!trimmed) {
      console.warn(
        `No timezone configured; using host TZ "${host}". Set COACH_TZ or session.timezone in config.yaml to silence this warning.`,
      );
    }
    return host;
  }
  console.warn(`No usable host TZ; falling back to "${FALLBACK_TZ}".`);
  return FALLBACK_TZ;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/**
 * Today's calendar date in `tz` as YYYY-MM-DD. en-CA emits ISO-style by default.
 */
export function todayInTZ(tz: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function zoneOffsetMs(instant: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  const local = Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    read("hour"),
    read("minute"),
    read("second"),
  );
  return local - Math.floor(instant / 1000) * 1000;
}

export function dayStartInTZ(date: string, tz: string): number {
  const [year, month, day] = date.split("-").map(Number);
  const utcMidnight = Date.UTC(year!, month! - 1, day!);
  const firstGuess = utcMidnight - zoneOffsetMs(utcMidnight, tz);
  const secondGuess = utcMidnight - zoneOffsetMs(firstGuess, tz);
  const onDate = [firstGuess, secondGuess].filter(
    (candidate) => todayInTZ(tz, new Date(candidate)) === date,
  );
  return Math.min(...(onDate.length === 0 ? [firstGuess] : onDate));
}

function ordinalSuffix(day: number): string {
  if (day >= 11 && day <= 13) return "th";
  switch (day % 10) {
    case 1: return "st";
    case 2: return "nd";
    case 3: return "rd";
    default: return "th";
  }
}

/**
 * Friendly local-time string: "Monday, May 3rd, 2026 - 16:55". 24-hour format.
 * Returns undefined if the platform's Intl can't format under `tz`.
 */
export function formatTimeInTZ(date: Date, tz: string): string | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const map: Record<string, string> = {};
    for (const p of parts) if (p.type !== "literal") map[p.type] = p.value;
    if (!map.weekday || !map.year || !map.month || !map.day || !map.hour || !map.minute) {
      return undefined;
    }
    const dayNum = parseInt(map.day, 10);
    return `${map.weekday}, ${map.month} ${dayNum}${ordinalSuffix(dayNum)}, ${map.year} - ${map.hour}:${map.minute}`;
  } catch {
    return undefined;
  }
}

/**
 * Compose the per-message time line: friendly local + bare UTC.
 * Example: "Current time: Sunday, May 3rd, 2026 - 20:55 (Asia/Tokyo) / 2026-05-03 11:55 UTC"
 */
export function buildCurrentTimeLine(tz: string, nowMs: number = Date.now()): string {
  const date = new Date(nowMs);
  const local = formatTimeInTZ(date, tz) ?? date.toISOString();
  const utc = date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
  return `Current time: ${local} (${tz}) / ${utc}`;
}

/**
 * Append the time line to `text`. Idempotent — safe to call repeatedly across
 * the agent's retry/compaction loop (won't double-append).
 */
export function appendCurrentTimeLine(
  text: string,
  tz: string,
  nowMs: number = Date.now(),
): string {
  const base = text.trimEnd();
  if (!base || base.includes("Current time:")) return base;
  return `${base}\n${buildCurrentTimeLine(tz, nowMs)}`;
}
