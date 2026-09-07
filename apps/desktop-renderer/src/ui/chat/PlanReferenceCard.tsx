import type {
  PlanChatCardReadModel,
  PlanReferenceSelection,
  PlanWorkoutReadModel,
} from "@enduragent/coach-contract";
import type { ReactElement, ReactNode } from "react";
import { Button } from "@enduragent/ui";
import { projectPlanChatCard } from "../../plan/chat-card";
import { useEnduragentStore } from "../../state/store";

function dateLabel(dateKey: number): string {
  const value = String(dateKey);
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
    new Date(
      Date.UTC(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1, Number(value.slice(6, 8))),
    ),
  );
}

function Row(props: { readonly label: string; readonly value: ReactNode }): ReactElement {
  return (
    <div className="grid grid-cols-[minmax(104px,0.72fr)_minmax(0,1.28fr)] gap-4 border-t border-line px-4 py-3 first:border-t-0 max-[560px]:grid-cols-1 max-[560px]:gap-1">
      <span className="text-xs leading-4 text-ink-2">{props.label}</span>
      <strong className="text-right text-sm leading-5 font-semibold [overflow-wrap:anywhere] max-[560px]:text-left">
        {props.value}
      </strong>
    </div>
  );
}

function WorkoutLine(props: { readonly workout: PlanWorkoutReadModel }): ReactElement {
  const workout = props.workout;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-3 border-t border-line px-4 py-3 first:border-t-0">
      <div className="min-w-0">
        <strong className="block text-sm leading-5">{workout.name}</strong>
        <span className="mt-1 block text-xs leading-4 text-ink-2">
          {dateLabel(workout.dateKey)} · {workout.sport}
        </span>
      </div>
      <span className="text-sm leading-5 font-semibold tabular-nums">
        {workout.durationSeconds === null
          ? "Duration unavailable"
          : `${Math.round(workout.durationSeconds / 60)} min`}
      </span>
    </div>
  );
}

function CardBody(props: { readonly card: PlanChatCardReadModel }): ReactElement {
  const card = props.card;
  if (card.kind === "active_plan_summary") {
    return (
      <div>
        <Row label="Current week" value={`${card.currentWeek} of ${card.totalWeeks}`} />
        <Row label="Phase" value={card.phase} />
        <Row label="Status" value={card.lifecycle === "active" ? "Active" : "Draft"} />
      </div>
    );
  }
  if (card.kind === "current_week") {
    return card.workouts.length === 0 ? (
      <p className="m-0 border-t border-line px-4 py-3 text-sm text-ink-2">
        No workouts in this week.
      </p>
    ) : (
      <div>
        {card.workouts.map((workout) => (
          <WorkoutLine key={workout.id} workout={workout} />
        ))}
      </div>
    );
  }
  return (
    <div>
      <Row label="Date" value={dateLabel(card.dateKey)} />
      <Row
        label="Duration"
        value={card.durationMinutes === null ? "Unavailable" : `${card.durationMinutes} min`}
      />
      <Row label="Targets" value={card.targets} />
      <Row label="Purpose" value={card.purpose} />
      <Row label="Safety guardrail" value={card.safetyGuardrail} />
    </div>
  );
}

export function PlanReferenceCard(props: {
  readonly selection: PlanReferenceSelection;
}): ReactElement | null {
  const surface = useEnduragentStore((state) => state.planSurface);
  const actions = useEnduragentStore((state) => state.planningReadActions);
  const card =
    surface.status !== "ready" || surface.value === null
      ? null
      : projectPlanChatCard(props.selection, surface.value);
  if (card === null) return null;

  return (
    <section className="mt-4 min-w-0 overflow-hidden rounded-card border border-line bg-surface shadow-elev-1">
      <header className="px-4 py-4">
        <p className="m-0 text-xs font-semibold tracking-[0.06em] text-ink-2 uppercase">
          {card.kind === "active_plan_summary"
            ? "Current Plan"
            : card.kind === "current_week"
              ? "Current week"
              : "Workout"}
        </p>
        <h3 className="mt-2 mb-0 text-base leading-6 font-semibold">{card.title}</h3>
        <p className="mt-2 mb-0 text-sm leading-5 text-ink-2">{card.summary}</p>
      </header>
      <CardBody card={card} />
      <footer className="border-t border-line px-4 py-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={actions === null}
          onClick={() => actions?.openFromChat(card.action.target)}
        >
          {card.action.label}
        </Button>
      </footer>
    </section>
  );
}
