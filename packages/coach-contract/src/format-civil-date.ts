export function formatCivilDate(value: string, options?: Intl.DateTimeFormatOptions): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return "Unknown date";
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value)
    return "Unknown date";
  return new Intl.DateTimeFormat("en-GB", {
    ...(options ?? { day: "numeric", month: "short", year: "numeric" }),
    timeZone: "UTC",
  }).format(date);
}
