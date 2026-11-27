import type { PlanCalendarRide } from "@enduragent/coach-contract";
import { usePhrasebook } from "@enduragent/i18n/react";
import { useCalendarText, type CalendarText } from "../calendar/calendar-text";

export interface ReviewText extends CalendarText {
  rideName(ride: PlanCalendarRide): string;
  rideKind(ride: PlanCalendarRide): string;
  rideLength(ride: PlanCalendarRide): string;
  startLine(ride: PlanCalendarRide): string;
  distance(metres: number): string;
  watts(value: number): string;
  bpm(value: number): string;
  exertion(value: number | null): string;
  load(value: number): string;
  clock(ms: number): string;
}

export function useReviewText(): ReviewText {
  const { say, format } = usePhrasebook();
  const text = useCalendarText();
  const rideKind = (ride: PlanCalendarRide): string => {
    switch (ride.kind) {
      case "road":
        return say("activity.review.kind.road");
      case "indoor":
        return say("activity.review.kind.indoor");
      case "mountain":
        return say("activity.review.kind.mountain");
      case "gravel":
        return say("activity.review.kind.gravel");
      case "other":
        return say("activity.review.kind.other");
    }
  };
  const time = (ride: PlanCalendarRide): string | null =>
    ride.timezoneOffsetSeconds === null
      ? null
      : format.date(new Date((ride.startEpochSeconds + ride.timezoneOffsetSeconds) * 1000), {
          hour: "numeric",
          minute: "2-digit",
          timeZone: "UTC",
        });
  return {
    ...text,
    rideName: (ride) => ride.name ?? say("activity.review.untitled"),
    rideKind,
    rideLength: (ride) =>
      ride.durationS === null
        ? (ride.name ?? say("activity.review.untitled"))
        : say("activity.review.list.ride", {
            name: ride.name ?? say("activity.review.untitled"),
            duration: text.duration(ride.durationS),
          }),
    startLine(ride) {
      const values = {
        date: text.weekdayDayMonth(ride.dateKey),
        time: time(ride) ?? "",
        kind: rideKind(ride),
      };
      if (ride.timezoneOffsetSeconds === null) {
        return ride.fromIntervals
          ? say("activity.review.header.dayFromIntervals", values)
          : say("activity.review.header.day", values);
      }
      return ride.fromIntervals
        ? say("activity.review.header.timeFromIntervals", values)
        : say("activity.review.header.time", values);
    },
    distance: (metres) =>
      say("activity.review.stats.kilometres", {
        kilometres: format.number(metres / 1000, {
          minimumFractionDigits: 1,
          maximumFractionDigits: 1,
        }),
      }),
    watts: (value) =>
      say("activity.review.stats.watts", {
        watts: format.number(value, { maximumFractionDigits: 0 }),
      }),
    bpm: (value) =>
      say("activity.review.stats.bpm", { bpm: format.number(value, { maximumFractionDigits: 0 }) }),
    exertion: (value) =>
      value === null
        ? say("activity.review.stats.notGiven")
        : say("activity.review.stats.exertionValue", {
            value: format.number(value, { maximumFractionDigits: 1 }),
          }),
    load: (value) => format.number(value, { maximumFractionDigits: 0 }),
    clock: (ms) => format.date(new Date(ms), { hour: "numeric", minute: "2-digit" }),
  };
}
