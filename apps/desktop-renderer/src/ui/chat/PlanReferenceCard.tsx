import { usePhrasebook } from "@enduragent/i18n/react";
import type { Phrasebook } from "@enduragent/i18n/messages";
import type { PlanChatCardReadModel, PlanReferenceSelection } from "@enduragent/coach-contract";
import type { ReactElement } from "react";
import { ArtifactCard, Button, EvidenceList, WorkoutList } from "@enduragent/ui";
import { projectPlanChatCard } from "../../plan/chat-card";
import { useEnduragentStore } from "../../state/store";

function dateLabel(dateKey: number, format: Phrasebook["format"]): string {
  const value = String(dateKey);
  return format.date(
    new Date(
      Date.UTC(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1, Number(value.slice(6, 8))),
    ),
    { month: "short", day: "numeric" },
  );
}

function CardBody(props: { readonly card: PlanChatCardReadModel }): ReactElement {
  const { say, format } = usePhrasebook();
  const card = props.card;
  if (card.kind === "active_plan_summary") {
    return (
      <EvidenceList
        label={say("chat.planReference.currentPlan")}
        rows={[
          {
            id: "week",
            label: say("chat.planReference.currentWeek"),
            value: say("chat.planReference.weekProgress", {
              week: format.number(card.currentWeek, { useGrouping: false }),
              total: format.number(card.totalWeeks, { useGrouping: false }),
            }),
          },
          { id: "phase", label: say("chat.planReference.phase"), value: card.phase },
          {
            id: "status",
            label: say("chat.planReference.status"),
            value:
              card.lifecycle === "active"
                ? say("chat.planReference.active")
                : say("chat.planReference.draft"),
          },
        ]}
      />
    );
  }
  if (card.kind === "current_week") {
    return (
      <WorkoutList
        label={say("chat.planReference.currentWeek")}
        empty={say("chat.planReference.emptyWeek")}
        rows={card.workouts.map((workout) => ({
          id: workout.id,
          when: dateLabel(workout.dateKey, format),
          title: workout.name,
          detail: workout.sport,
          status:
            workout.durationSeconds === null
              ? say("chat.planReference.durationUnavailable")
              : say("chat.planReference.minutes", {
                  minutes: format.number(Math.round(workout.durationSeconds / 60), {
                    useGrouping: false,
                  }),
                }),
        }))}
      />
    );
  }
  return (
    <EvidenceList
      label={say("chat.planReference.workout")}
      rows={[
        {
          id: "date",
          label: say("chat.planReference.date"),
          value: dateLabel(card.dateKey, format),
        },
        {
          id: "duration",
          label: say("chat.planReference.duration"),
          value:
            card.durationMinutes === null
              ? say("chat.planReference.unavailable")
              : say("chat.planReference.minutes", {
                  minutes: format.number(card.durationMinutes, { useGrouping: false }),
                }),
        },
        { id: "targets", label: say("chat.planReference.targets"), value: card.targets },
        { id: "purpose", label: say("chat.planReference.purpose"), value: card.purpose },
        {
          id: "guardrail",
          label: say("chat.planReference.safetyGuardrail"),
          value: card.safetyGuardrail,
        },
      ]}
    />
  );
}

export function PlanReferenceCard(props: {
  readonly selection: PlanReferenceSelection;
}): ReactElement | null {
  const { say, format } = usePhrasebook();
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
          ? say("chat.planReference.currentPlan")
          : card.kind === "current_week"
            ? say("chat.planReference.currentWeek")
            : say("chat.planReference.workout")
      }
      title={
        card.kind === "current_week"
          ? say("chat.planReference.weekTitle", {
              week: format.number(card.weekNumber, { useGrouping: false }),
              total: format.number(card.totalWeeks, { useGrouping: false }),
            })
          : card.title
      }
      summary={
        card.kind === "active_plan_summary" && surface.value?.plan?.goal.length === 0
          ? say("chat.planReference.noGoal")
          : card.summary
      }
      actions={
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={actions === null}
          onClick={() => actions?.openFromChat(card.action.target)}
        >
          {say("chat.planReference.openPlan")}
        </Button>
      }
    >
      <CardBody card={card} />
    </ArtifactCard>
  );
}
