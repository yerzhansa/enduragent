import { usePhrasebook } from "@enduragent/i18n/react";

export function usePlanDate(): (value: string, options?: Intl.DateTimeFormatOptions) => string {
  const { say, format, tag } = usePhrasebook();
  return (value, options) => {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return say("chat.date.unknown");
    const date = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value)
      return say("chat.date.unknown");
    const selected = options ?? { day: "numeric", month: "short", year: "numeric" };
    if (tag !== "en") return format.date(date, { ...selected, timeZone: "UTC" });
    const weekday =
      selected.weekday === undefined
        ? ""
        : format.date(date, { weekday: selected.weekday, timeZone: "UTC" });
    if (selected.day === undefined) return weekday;
    const day = format.number(date.getUTCDate(), { useGrouping: false });
    if (selected.month === undefined) return say("plan.view.date.weekdayDay", { weekday, day });
    const month = format.date(date, { month: selected.month, timeZone: "UTC" });
    const localizedMonth = month === "Sep" ? say("chat.date.month.september") : month;
    const dateText =
      selected.year === undefined
        ? say("plan.view.date.dayMonth", { day, month: localizedMonth })
        : say("chat.date.civil", {
            day,
            month: localizedMonth,
            year: format.number(date.getUTCFullYear(), { useGrouping: false }),
          });
    return selected.weekday === undefined
      ? dateText
      : say(
          selected.weekday === "short"
            ? "plan.view.date.shortWeekdayDate"
            : "plan.view.date.weekdayDate",
          { weekday, date: dateText },
        );
  };
}
