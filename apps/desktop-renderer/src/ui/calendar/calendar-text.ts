import { usePhrasebook } from "@enduragent/i18n/react";
import { dateOf, isoWeekday, type FirstDayOfWeek } from "../../calendar/dates";
import { usePlanDate } from "../plan/plan-date";

export interface CalendarText {
  duration(seconds: number): string;
  dayMonth(dateKey: number): string;
  weekdayDayMonth(dateKey: number): string;
  weekRange(startDateKey: number, endDateKey: number): string;
  weekday(isoDay: number): string;
  weekdayLong(dateKey: number): string;
  weekdayDay(dateKey: number): string;
  isoWeekdayOf(dateKey: number): FirstDayOfWeek;
  list(values: readonly string[]): string;
  names(values: readonly string[]): string;
  dayOfMonth(dateKey: number): string;
  kilometres(metres: number): string;
}

function isoText(dateKey: number): string {
  const text = String(dateKey).padStart(8, "0");
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

const WEEKDAY_SAMPLE = [19980105, 19980106, 19980107, 19980108, 19980109, 19980110, 19980111];

export function useCalendarText(): CalendarText {
  const { say, format, tag, locale } = usePhrasebook();
  const planDate = usePlanDate();
  const dayOfMonth = (dateKey: number): string =>
    format.number(dateKey % 100, { useGrouping: false });
  const dayMonth = (dateKey: number): string =>
    planDate(isoText(dateKey), { day: "numeric", month: "short" });
  return {
    duration(seconds) {
      const minutes = Math.round(seconds / 60);
      const hours = Math.floor(minutes / 60);
      const text =
        hours === 0
          ? say("plan.calendar.duration.minutes", { minutes })
          : say("plan.calendar.duration.hoursMinutes", { hours, minutes: minutes % 60 });
      return text.replaceAll(" ", "\u00a0");
    },
    dayMonth,
    weekdayDayMonth: (dateKey) =>
      planDate(isoText(dateKey), { weekday: "short", day: "numeric", month: "short" }),
    weekRange(startDateKey, endDateKey) {
      if (tag !== "en") {
        return new Intl.DateTimeFormat(locale, {
          day: "numeric",
          month: "short",
          timeZone: "UTC",
        }).formatRange(dateOf(startDateKey), dateOf(endDateKey));
      }
      const sameMonth = Math.floor(startDateKey / 100) === Math.floor(endDateKey / 100);
      return sameMonth
        ? say("plan.calendar.range.sameMonth", {
            startDay: dayOfMonth(startDateKey),
            end: dayMonth(endDateKey),
          })
        : say("plan.calendar.range.crossMonth", {
            start: dayMonth(startDateKey),
            end: dayMonth(endDateKey),
          });
    },
    weekday: (isoDay) =>
      planDate(isoText(WEEKDAY_SAMPLE[isoDay - 1] ?? WEEKDAY_SAMPLE[0] ?? 19980105), {
        weekday: "short",
      }),
    weekdayLong: (dateKey) => planDate(isoText(dateKey), { weekday: "long" }),
    weekdayDay: (dateKey) => planDate(isoText(dateKey), { weekday: "short", day: "numeric" }),
    isoWeekdayOf: isoWeekday,
    list: (values) => format.list(values, { type: "conjunction" }),
    names: (values) => format.list(values, { type: "unit", style: "short" }),
    dayOfMonth,
    kilometres: (metres) =>
      say("plan.calendar.distance.kilometres", {
        kilometres: format.number(Math.round(metres / 1000), { useGrouping: false }),
      }),
  };
}
