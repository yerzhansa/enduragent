import type { PlanCalendarRide } from "@enduragent/coach-contract";
import { usePhrasebook } from "@enduragent/i18n/react";
import { cn } from "@enduragent/ui";
import type { ReactElement } from "react";
import type { FirstDayOfWeek } from "../../calendar/dates";
import {
  rideGroups,
  rideOutcome,
  type ActivityReviewRead,
  type RideGroupLabel,
  type RideOutcome,
} from "../../activity-review/rides";
import { useReviewText, type ReviewText } from "./review-text";

type Say = ReturnType<typeof usePhrasebook>["say"];

function outcomeView(
  outcome: RideOutcome,
  say: Say,
): { readonly tone: string; readonly text: string } | null {
  switch (outcome.kind) {
    case "none":
      return null;
    case "extra":
      return { tone: "text-ink-2", text: say("activity.review.list.extra") };
    case "is-this":
      return {
        tone: "text-brand",
        text: say("activity.review.list.isThis", { name: outcome.name }),
      };
    case "done-as-planned":
      return { tone: "text-ok", text: say("activity.review.list.doneAsPlanned") };
    case "done-differently":
      return { tone: "text-warn", text: say("activity.review.list.doneDifferently") };
  }
}

function groupText(label: RideGroupLabel, first: boolean, say: Say, text: ReviewText): string {
  const name =
    label.kind === "training-week"
      ? say("activity.review.list.trainingWeek", { week: label.week })
      : text.weekRange(label.startDateKey, label.endDateKey);
  return first ? say("activity.review.list.first", { group: name }) : name;
}

function RideRow(props: {
  readonly ride: PlanCalendarRide;
  readonly read: ActivityReviewRead;
  readonly selected: boolean;
  readonly onSelect: (activityId: string) => void;
}): ReactElement {
  const { say } = usePhrasebook();
  const text = useReviewText();
  const day = text.weekdayDay(props.ride.dateKey);
  const outcome = outcomeView(rideOutcome(props.read, props.ride), say);
  return (
    <li className="m-0 p-0">
      <button
        type="button"
        className={cn(
          "relative flex w-full flex-col gap-px border-b border-line bg-transparent px-3.5 py-2 text-left text-sm text-ink hover:bg-surface",
          props.selected && "bg-brand-soft hover:bg-brand-soft",
        )}
        aria-current={props.selected ? "true" : undefined}
        data-ride-id={props.ride.activityId}
        onClick={() => props.onSelect(props.ride.activityId)}
      >
        {props.selected ? (
          <span className="absolute inset-y-0 left-0 w-0.75 bg-brand" aria-hidden="true" />
        ) : null}
        <span className="text-xs text-ink-2">
          {props.ride.dateKey === props.read.todayDateKey
            ? say("activity.review.list.today", { day })
            : day}
        </span>
        <span>{text.rideLength(props.ride)}</span>
        {outcome === null ? null : (
          <span className={cn("text-xs font-semibold", outcome.tone)}>{outcome.text}</span>
        )}
      </button>
    </li>
  );
}

export function RideList(props: {
  readonly read: ActivityReviewRead;
  readonly firstDay: FirstDayOfWeek;
  readonly selectedId: string | null;
  readonly onSelect: (activityId: string) => void;
}): ReactElement {
  const { say } = usePhrasebook();
  const text = useReviewText();
  const groups = rideGroups(props.read, props.firstDay);
  return (
    <nav
      className="flex min-h-0 w-58 flex-none flex-col overflow-auto border-r border-line bg-surface-2"
      aria-label={say("activity.review.list.label")}
    >
      {groups.map((group, index) => (
        <section key={group.key} aria-label={groupText(group.label, false, say, text)}>
          <h2 className="m-0 border-b border-line px-3.5 py-2.5 text-xs font-semibold text-ink-2">
            {groupText(group.label, index === 0, say, text)}
          </h2>
          <ul className="m-0 list-none p-0">
            {group.rides.map((ride) => (
              <RideRow
                key={ride.activityId}
                ride={ride}
                read={props.read}
                selected={ride.activityId === props.selectedId}
                onSelect={props.onSelect}
              />
            ))}
          </ul>
        </section>
      ))}
    </nav>
  );
}
