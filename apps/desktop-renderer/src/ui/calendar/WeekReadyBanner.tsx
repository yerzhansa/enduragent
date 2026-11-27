import { usePhrasebook } from "@enduragent/i18n/react";
import { Button } from "@enduragent/ui";
import { Calendar } from "lucide-react";
import type { PlanCalendarReplacing } from "@enduragent/coach-contract";
import type { ReactElement } from "react";
import { comingOff, type PendingApproval } from "../../calendar/approval";
import { useCalendarText } from "./calendar-text";

export function WeekReadyBanner(props: {
  readonly pending: PendingApproval;
  readonly onReview: () => void;
}): ReactElement | null {
  const { say } = usePhrasebook();
  const text = useCalendarText();
  const entry = props.pending.weeks[0];
  if (entry === undefined) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-2.5 rounded-card border border-line-2 bg-surface px-3.5 py-2.5 text-sm"
      role="status"
      data-week-ready={entry.week.index}
    >
      <Calendar className="size-4 text-brand" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <strong>{say("plan.calendar.banner.lead", { week: entry.week.index })}</strong>{" "}
        {say("plan.calendar.banner.detail", {
          count: props.pending.count,
          duration: text.duration(props.pending.totalS),
          date: text.weekdayDayMonth(entry.week.startDateKey),
        })}
      </span>
      <Button type="button" onClick={props.onReview}>
        {say("plan.calendar.banner.review")}
      </Button>
    </div>
  );
}

export function ReplaceWaitingBanner(props: {
  readonly replacing: PlanCalendarReplacing;
  readonly onReview: () => void;
}): ReactElement {
  const { say } = usePhrasebook();
  return (
    <div
      className="flex flex-wrap items-center gap-2.5 rounded-card border border-line-2 bg-surface px-3.5 py-2.5 text-sm"
      role="status"
      data-replace-waiting=""
    >
      <Calendar className="size-4 text-brand" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <strong>{say("plan.calendar.approve.replace.bannerLead")}</strong>{" "}
        {say("plan.calendar.approve.replace.bannerDetail", {
          count: comingOff(props.replacing, false).length,
          old: props.replacing.planName,
        })}
      </span>
      <Button type="button" onClick={props.onReview}>
        {say("plan.calendar.banner.review")}
      </Button>
    </div>
  );
}
