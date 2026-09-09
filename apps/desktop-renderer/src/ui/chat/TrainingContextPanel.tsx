import type { ReactElement } from "react";
import { Button } from "@enduragent/ui";
import { useEnduragentStore } from "../../state/store";
import { msg, type Message } from "@enduragent/i18n";
import { usePhrasebook } from "@enduragent/i18n/react";

function ContextSection(props: {
  readonly label: string;
  readonly title: string;
  readonly detail?: string;
}): ReactElement {
  return (
    <section className="border-t border-line py-row first:border-t-0 first:pt-0">
      <h3 className="m-0 text-xs font-semibold tracking-[0.06em] text-ink-2 uppercase">
        {props.label}
      </h3>
      <p className="mt-[calc(var(--inset)/2)] mb-0 text-sm font-semibold text-ink">{props.title}</p>
      {props.detail === undefined ? null : (
        <p className="mt-[calc(var(--inset)/2)] mb-0 text-xs text-ink-2">{props.detail}</p>
      )}
    </section>
  );
}

function unavailableCopy(reason: string): Message {
  return reason === "no-plan" || reason === "no-platform-load" || reason === "missing-anchor"
    ? msg("chat.trainingContext.notAvailable")
    : msg("chat.trainingContext.waiting");
}

export function TrainingContextPanel(props: {
  readonly titleId?: string;
  readonly labelledBy?: string;
  readonly className?: string;
}): ReactElement {
  const { say, format } = usePhrasebook();
  const training = useEnduragentStore((state) => state.training);
  const planning = useEnduragentStore((state) => state.planSurface);
  const planActions = useEnduragentStore((state) => state.planningReadActions);
  const context = training.trainingContext;
  const currentPlan = planning.value?.status === "ready" ? planning.value.plan : null;
  const todayWorkout = currentPlan?.todayWorkout ?? null;

  return (
    <aside
      className={`training-context min-h-0 overflow-auto [scrollbar-width:none] border-l border-line bg-surface-2 px-[calc(var(--inset)*2)] py-[calc(var(--inset)*2)] ${props.className ?? ""}`}
      aria-label={props.labelledBy === undefined ? say("chat.trainingContext.title") : undefined}
      aria-labelledby={props.labelledBy}
    >
      <h2 id={props.titleId} className="m-0 text-sm font-semibold">
        {say("chat.trainingContext.title")}
      </h2>
      <p className="mt-[calc(var(--inset)/2)] mb-[calc(var(--inset)*2)] text-xs text-ink-2">
        {say("chat.trainingContext.available")}
      </p>

      {training.status === "loading" ? (
        <p className="m-0 text-sm text-ink-2" role="status">
          {say("chat.trainingContext.loading")}
        </p>
      ) : training.status === "unavailable" ? (
        <p className="m-0 text-sm text-ink-2" role="status">
          {say("chat.trainingContext.unavailable")}
        </p>
      ) : (
        <div>
          {todayWorkout === null ? (
            <ContextSection
              label={say("chat.trainingContext.today")}
              title={
                planning.status === "loading"
                  ? say("chat.trainingContext.loadingPlan")
                  : planning.value?.status === "no-plan"
                    ? say("chat.trainingContext.noPlan")
                    : say("chat.trainingContext.noWorkout")
              }
            />
          ) : (
            <ContextSection
              label={say("chat.trainingContext.today")}
              title={todayWorkout.name}
              detail={
                todayWorkout.durationSeconds === null
                  ? todayWorkout.sport
                  : say("chat.trainingContext.workoutDetail", {
                      minutes: format.number(Math.round(todayWorkout.durationSeconds / 60), {
                        useGrouping: false,
                      }),
                      sport: todayWorkout.sport,
                    })
              }
            />
          )}

          <ContextSection
            label={say("chat.trainingContext.currentPlan")}
            title={
              currentPlan === null
                ? planning.status === "loading"
                  ? say("chat.trainingContext.loadingPlan")
                  : say("chat.trainingContext.notAvailable")
                : currentPlan.name
            }
            detail={
              currentPlan?.currentWeek === null || currentPlan === null
                ? undefined
                : say(
                    currentPlan.phase === null
                      ? "chat.trainingContext.week"
                      : "chat.trainingContext.weekPhase",
                    {
                      week: format.number(currentPlan.currentWeek, { useGrouping: false }),
                      total: format.number(currentPlan.totalWeeks, { useGrouping: false }),
                      phase: currentPlan.phase ?? "",
                    },
                  )
            }
          />

          <ContextSection
            label={say("chat.trainingContext.recentLoad")}
            title={
              context.cyclingLoad.kind === "computed"
                ? format.number(context.cyclingLoad.value, {
                    maximumFractionDigits: 0,
                    useGrouping: false,
                  })
                : say(unavailableCopy(context.cyclingLoad.reason))
            }
            detail={
              context.cyclingLoad.kind === "computed"
                ? say(
                    context.cyclingLoad.activityCount === 1
                      ? "chat.trainingContext.activities_one"
                      : "chat.trainingContext.activities_other",
                    {
                      count: context.cyclingLoad.activityCount,
                      formattedCount: format.number(context.cyclingLoad.activityCount, {
                        useGrouping: false,
                      }),
                      days: format.number(7, { useGrouping: false }),
                    },
                  )
                : undefined
            }
          />

          <ContextSection
            label={say("chat.trainingContext.cyclingAnchor")}
            title={
              context.anchorZones.kind === "computed"
                ? say("chat.trainingContext.power", {
                    watts: format.number(context.anchorZones.anchor.watts, {
                      maximumFractionDigits: 0,
                      useGrouping: false,
                    }),
                  })
                : say(unavailableCopy(context.anchorZones.reason))
            }
            detail={
              context.anchorZones.kind === "computed"
                ? say("chat.trainingContext.anchorDetail", {
                    source: context.anchorZones.anchor.source,
                    confidence: say(
                      context.anchorZones.anchor.confidence === "manual"
                        ? "chat.trainingContext.confidence.manual"
                        : context.anchorZones.anchor.confidence === "platform"
                          ? "chat.trainingContext.confidence.platform"
                          : "chat.trainingContext.confidence.fit",
                    ),
                  })
                : undefined
            }
          />
        </div>
      )}

      {training.status === "refresh-unavailable" ? (
        <p className="mt-[calc(var(--inset)/2)] mb-0 text-xs text-warn" role="status">
          {say("chat.trainingContext.refreshUnavailable")}
        </p>
      ) : null}
      {currentPlan === null ? null : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-inset -ml-inset text-ink-2"
          onClick={() => planActions?.openFromChat(currentPlan.navigation)}
          disabled={planActions === null}
        >
          {say("chat.trainingContext.openPlan")}
        </Button>
      )}
    </aside>
  );
}
