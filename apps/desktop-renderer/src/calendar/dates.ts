export type FirstDayOfWeek = 1 | 2 | 3 | 4 | 5 | 6 | 7;

const DAY_MS = 86_400_000;

function epochDay(dateKey: number): number {
  const year = Math.floor(dateKey / 10_000);
  const month = Math.floor((dateKey % 10_000) / 100);
  const day = dateKey % 100;
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

function fromEpochDay(value: number): number {
  const date = new Date(value * DAY_MS);
  return date.getUTCFullYear() * 10_000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
}

export function addDays(dateKey: number, days: number): number {
  return fromEpochDay(epochDay(dateKey) + days);
}

export function daysBetween(from: number, to: number): number {
  return epochDay(to) - epochDay(from);
}

export function isoWeekday(dateKey: number): FirstDayOfWeek {
  const weekday = new Date(epochDay(dateKey) * DAY_MS).getUTCDay();
  const iso = weekday === 0 ? 7 : weekday;
  if (iso === 1 || iso === 2 || iso === 3 || iso === 4) return iso;
  if (iso === 5 || iso === 6) return iso;
  return 7;
}

export function rowStart(dateKey: number, firstDay: FirstDayOfWeek): number {
  return addDays(dateKey, -((isoWeekday(dateKey) - firstDay + 7) % 7));
}

export function dateOf(dateKey: number): Date {
  return new Date(epochDay(dateKey) * DAY_MS);
}

export function weekdayOrder(firstDay: FirstDayOfWeek): readonly FirstDayOfWeek[] {
  return Array.from({ length: 7 }, (_, offset) => {
    const day = ((firstDay - 1 + offset) % 7) + 1;
    return day === 1 || day === 2 || day === 3 || day === 4 || day === 5 || day === 6 ? day : 7;
  });
}
