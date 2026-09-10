import { msg, type Message } from "@enduragent/i18n";
import type { UnitsPreference } from "@enduragent/coach-contract";

const UTC_INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/u;

export function formatUtcTimestamp(value: string): string {
  const match = UTC_INSTANT_PATTERN.exec(value);
  if (match === null) return "Unknown sync time";
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return "Unknown sync time";
  const offsetHours = Number(match[9] ?? 0);
  const offsetMinutes = Number(match[10] ?? 0);
  if (offsetHours > 23 || offsetMinutes > 59) return "Unknown sync time";
  const offsetSign = match[8] === "-" ? -1 : 1;
  const local = new Date(milliseconds + offsetSign * (offsetHours * 60 + offsetMinutes) * 60_000);
  if (
    local.getUTCFullYear() !== Number(match[1]) ||
    local.getUTCMonth() + 1 !== Number(match[2]) ||
    local.getUTCDate() !== Number(match[3]) ||
    local.getUTCHours() !== Number(match[4]) ||
    local.getUTCMinutes() !== Number(match[5]) ||
    local.getUTCSeconds() !== Number(match[6])
  ) {
    return "Unknown sync time";
  }
  const normalized = new Date(milliseconds).toISOString();
  return `${normalized.slice(0, 10)} ${normalized.slice(11, 19)} UTC`;
}

interface NumberFormatter {
  number(value: number, options?: Intl.NumberFormatOptions): string;
}

export function formatWholeNumber(value: number, format: NumberFormatter): string {
  return format.number(Math.round(value), { useGrouping: false });
}

export function formatPercentage(value: number, format: NumberFormatter): Message {
  return msg("training.view.format.percentage", {
    value: format.number(Math.round(value * 100), { useGrouping: false }),
  });
}

export function formatSleepDuration(seconds: number, format: NumberFormatter): Message {
  const minutes = Math.round(seconds / 60);
  return msg("training.view.format.hoursMinutes", {
    hours: formatWholeNumber(Math.floor(minutes / 60), format),
    minutes: formatWholeNumber(minutes % 60, format),
  });
}

export function formatRidingDuration(seconds: number, format: NumberFormatter): Message {
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (hours === 0) {
    return msg("training.view.format.minutes", { value: formatWholeNumber(remainder, format) });
  }
  if (remainder === 0) {
    return msg("training.view.format.hours", { value: formatWholeNumber(hours, format) });
  }
  return msg("training.view.format.hoursMinutes", {
    hours: formatWholeNumber(hours, format),
    minutes: formatWholeNumber(remainder, format),
  });
}

export function formatDistance(
  value: number,
  units: UnitsPreference,
  format: NumberFormatter,
): Message {
  const converted = units === "imperial" ? value / 1_609.344 : value / 1_000;
  const rounded = Math.round(converted * 10) / 10;
  return msg(
    units === "imperial" ? "training.view.format.miles" : "training.view.format.kilometers",
    {
      value: format.number(rounded, {
        useGrouping: false,
        maximumFractionDigits: 1,
      }),
    },
  );
}
