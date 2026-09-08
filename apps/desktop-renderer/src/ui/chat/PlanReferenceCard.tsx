import type { PlanChatCardReadModel, PlanReferenceSelection } from "@enduragent/coach-contract";
import type { ReactElement } from "react";
import { ArtifactCard, Button, EvidenceList, WorkoutList } from "@enduragent/ui";
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

function CardBody(props: { readonly card: PlanChatCardReadModel }): ReactElement {
  const card = props.card;
  if (card.kind === "active_plan_summary") {
    return (
      <EvidenceList
        label="Current Plan"
        rows={[
          { id: "week", label: "Current week", value: `${card.currentWeek} of ${card.totalWeeks}` },
          { id: "phase", label: "Phase", value: card.phase },
          {
            id: "status",
            label: "Status",
            value: card.lifecycle === "active" ? "Active" : "Draft",
          },
        ]}
      />
    );
  }
  if (card.kind === "current_week") {
    return (
      <WorkoutList
        label="Current week"
        empty="No workouts in this week."
        rows={card.workouts.map((workout) => ({
          id: workout.id,
          when: dateLabel(workout.dateKey),
          title: workout.name,
          detail: workout.sport,
          status:
            workout.durationSeconds === null
              ? "Duration unavailable"
              : `${Math.round(workout.durationSeconds / 60)} min`,
        }))}
      />
    );
  }
  return (
    <EvidenceList
      label="Workout"
      rows={[
        { id: "date", label: "Date", value: dateLabel(card.dateKey) },
        {
          id: "duration",
          label: "Duration",
          value: card.durationMinutes === null ? "Unavailable" : `${card.durationMinutes} min`,
        },
        { id: "targets", label: "Targets", value: card.targets },
        { id: "purpose", label: "Purpose", value: card.purpose },
        { id: "guardrail", label: "Safety guardrail", value: card.safetyGuardrail },
      ]}
    />
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
    <ArtifactCard
      className="mt-4 min-w-0"
      eyebrow={
        card.kind === "active_plan_summary"
          ? "Current Plan"
          : card.kind === "current_week"
            ? "Current week"
            : "Workout"
      }
      title={card.title}
      summary={card.summary}
      actions={
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={actions === null}
          onClick={() => actions?.openFromChat(card.action.target)}
        >
          {card.action.label}
        </Button>
      }
    >
      <CardBody card={card} />
    </ArtifactCard>
  );
}
