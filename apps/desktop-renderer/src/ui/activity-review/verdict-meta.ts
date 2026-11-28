import type { PlanCalendarVerdictMarker } from "@enduragent/coach-contract";
import { usePhrasebook } from "@enduragent/i18n/react";
import { localTodayDateKey } from "../../calendar/dates";
import { useReviewText } from "./review-text";

export interface VerdictMetaFacts {
  readonly writtenAtMs: number;
  readonly trigger: "opened" | "matched" | "asked";
  readonly usedPlan: boolean;
  readonly usedNote: boolean;
  readonly marker: PlanCalendarVerdictMarker;
}

export interface VerdictDays {
  readonly rideDateKey: number;
  readonly todayDateKey: number;
}

function yearOf(dateKey: number): number {
  return Math.floor(dateKey / 10_000);
}

export function useVerdictMeta(): (
  verdict: VerdictMetaFacts,
  replies: number,
  days: VerdictDays,
) => string {
  const { say } = usePhrasebook();
  const text = useReviewText();
  const before = (marker: PlanCalendarVerdictMarker): string | null => {
    switch (marker.kind) {
      case "matched-to":
        return say("activity.review.verdict.before.workout", { name: marker.name });
      case "matched-extra":
        return say("activity.review.verdict.before.extra");
      case "match-pending":
        return say("activity.review.verdict.before.pending");
      case "current":
        return null;
    }
  };
  const writtenSameDay = (verdict: VerdictMetaFacts, replies: number, time: string): string => {
    switch (verdict.trigger) {
      case "matched":
        return say("activity.review.verdict.written.matched", { time });
      case "opened":
        return replies <= 1
          ? say("activity.review.verdict.written.firstOpen", { time })
          : say("activity.review.verdict.written.opened", { time });
      case "asked":
        return verdict.usedNote
          ? say("activity.review.verdict.written.askedNote", { time })
          : say("activity.review.verdict.written.asked", { time });
    }
  };
  const writtenOn = (
    verdict: VerdictMetaFacts,
    replies: number,
    values: { readonly date: string; readonly time: string },
  ): string => {
    switch (verdict.trigger) {
      case "matched":
        return say("activity.review.verdict.written.matchedOn", values);
      case "opened":
        return replies <= 1
          ? say("activity.review.verdict.written.firstOpenOn", values)
          : say("activity.review.verdict.written.openedOn", values);
      case "asked":
        return verdict.usedNote
          ? say("activity.review.verdict.written.askedNoteOn", values)
          : say("activity.review.verdict.written.askedOn", values);
    }
  };
  return (verdict, replies, days) => {
    const time = text.clock(verdict.writtenAtMs);
    const count = say("activity.review.verdict.replies", { count: replies });
    const writeDay = localTodayDateKey(new Date(verdict.writtenAtMs));
    const date =
      writeDay === days.rideDateKey
        ? null
        : text.writtenDay(writeDay, yearOf(writeDay) !== yearOf(days.todayDateKey));
    const marked = before(verdict.marker);
    if (marked !== null) {
      return say("activity.review.verdict.meta", { written: marked, replies: count });
    }
    if (!verdict.usedPlan) {
      return date === null
        ? say("activity.review.verdict.metaNoPlan", { time, replies: count })
        : say("activity.review.verdict.metaNoPlanOn", { date, time, replies: count });
    }
    return say("activity.review.verdict.meta", {
      written:
        date === null
          ? writtenSameDay(verdict, replies, time)
          : writtenOn(verdict, replies, { date, time }),
      replies: count,
    });
  };
}
