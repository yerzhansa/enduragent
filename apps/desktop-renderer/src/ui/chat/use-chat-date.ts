import type { CatalogKey } from "@enduragent/i18n";
import { usePhrasebook } from "@enduragent/i18n/react";

const months: readonly CatalogKey[] = [
  "chat.date.month.january",
  "chat.date.month.february",
  "chat.date.month.march",
  "chat.date.month.april",
  "chat.date.month.may",
  "chat.date.month.june",
  "chat.date.month.july",
  "chat.date.month.august",
  "chat.date.month.september",
  "chat.date.month.october",
  "chat.date.month.november",
  "chat.date.month.december",
];

export function useChatDate(): (value: string) => string {
  const { say, format, tag } = usePhrasebook();
  return (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return say("chat.date.unknown");
    const date = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value)
      return say("chat.date.unknown");
    if (tag !== "en")
      return format.date(date, {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      });
    return say("chat.date.civil", {
      day: format.number(date.getUTCDate(), { useGrouping: false }),
      month: say(months[date.getUTCMonth()]!),
      year: format.number(date.getUTCFullYear(), { useGrouping: false }),
    });
  };
}
