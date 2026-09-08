export { formatCivilDate } from "@enduragent/coach-contract";

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
