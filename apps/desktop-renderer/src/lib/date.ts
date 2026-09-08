const CIVIL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

function civilDate(value: string): Date | null {
  if (!CIVIL_DATE_PATTERN.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}

export function formatCivilDate(value: string, options?: Intl.DateTimeFormatOptions): string {
  const date = civilDate(value);
  if (date === null) return "Unknown date";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: options === undefined ? "medium" : undefined,
    ...options,
    timeZone: "UTC",
  }).format(date);
}

export function formatInstantDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown date and time";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function formatOffsetWallTime(
  startEpochSeconds: number,
  timezoneOffsetSeconds: number | null,
): string | null {
  if (timezoneOffsetSeconds === null) return null;
  const date = new Date((startEpochSeconds + timezoneOffsetSeconds) * 1_000);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
}
