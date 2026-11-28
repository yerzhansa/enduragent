import type { PlanCalendarFtpLine, PlanCalendarRideFtp } from "@enduragent/coach-contract";
import { usePhrasebook } from "@enduragent/i18n/react";
import { useCalendarText } from "../calendar/calendar-text";

type KnownRideFtp = Extract<PlanCalendarRideFtp, { kind: "known" }>;

export interface FtpText {
  watts(value: number): string;
  source(line: Pick<PlanCalendarFtpLine, "dateKey" | "source">): string;
  rideSource(ftp: KnownRideFtp): string;
  historySource(line: Pick<PlanCalendarFtpLine, "source">): string;
  dayMonth(dateKey: number): string;
  weekdayDayMonth(dateKey: number): string;
  time(ms: number): string;
}

export function useFtpText(): FtpText {
  const { say, format } = usePhrasebook();
  const text = useCalendarText();
  const watts = (value: number) => format.number(value, { maximumFractionDigits: 0 });
  return {
    watts,
    source(line) {
      switch (line.source) {
        case "first-sync":
          return say("activity.review.ftp.sourceInIntervals");
        case "intervals":
          return say("activity.review.ftp.sourceYou", { date: text.dayMonth(line.dateKey) });
        case "coach-test":
        case "coach-estimate":
          return say("activity.review.ftp.sourceCoach", { date: text.dayMonth(line.dateKey) });
      }
    },
    rideSource(ftp) {
      if (ftp.setBy === "unknown" || ftp.setOnDateKey === null) {
        return say("activity.review.ftp.sourceFromIntervals");
      }
      return ftp.setBy === "you"
        ? say("activity.review.ftp.sourceYou", { date: text.dayMonth(ftp.setOnDateKey) })
        : say("activity.review.ftp.sourceCoach", { date: text.dayMonth(ftp.setOnDateKey) });
    },
    historySource(line) {
      switch (line.source) {
        case "first-sync":
          return say("activity.review.ftp.historyFirstSync");
        case "intervals":
          return say("activity.review.ftp.historyYou");
        case "coach-test":
          return say("activity.review.ftp.historyCoachTest");
        case "coach-estimate":
          return say("activity.review.ftp.historyCoachEstimate");
      }
    },
    dayMonth: text.dayMonth,
    weekdayDayMonth: text.weekdayDayMonth,
    time: (ms) => format.date(new Date(ms), { hour: "numeric", minute: "2-digit" }),
  };
}
