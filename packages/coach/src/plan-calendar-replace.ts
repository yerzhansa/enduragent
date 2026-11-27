import type {
  PlanCalendarAthleteChange,
  PlanCalendarEndingWorkout,
  PlanCalendarReplacing,
} from "@enduragent/coach-contract";
import {
  decodeCloseChoice,
  encodeCloseChoice,
  encodeWeekDelivery,
  firstChangeSetWeeks,
  planEndingStep,
  type AthleteChangesChoice,
  type TickedChange,
} from "@enduragent/engine/calendar";
import {
  addCivilDays,
  createPlanCalendarMirrorRepository,
  createPlanCleanupHoldRepository,
  createPlanReconciliationRepository,
} from "@enduragent/kernel/planning";
import type { MigratorStore, SqlStore } from "@enduragent/kernel/store";
import { createLegacyPlanRepository } from "@enduragent/kernel-node/planning";
import { planEndingView } from "./plan-calendar-details.js";

type ReplaceStore = SqlStore & Pick<MigratorStore, "transaction">;

function sameTick(left: TickedChange, right: TickedChange): boolean {
  return (
    left.planWorkoutId === right.planWorkoutId &&
    left.eventId === right.eventId &&
    left.dateKey === right.dateKey &&
    left.fingerprint === right.fingerprint
  );
}

async function saveCloseChoice(
  store: ReplaceStore,
  input: {
    readonly planId: string;
    readonly choice: AthleteChangesChoice;
    readonly todayDateKey: number;
    readonly nowMs: number;
  },
): Promise<void> {
  const mirror = createPlanCalendarMirrorRepository(store);
  const current = await mirror.readDelivery(input.planId);
  if (current === undefined && input.choice.kind === "keep-them") return;
  const plan = await createLegacyPlanRepository(store).read(input.planId);
  if (plan === undefined) return;
  const delivery = {
    kind: "approved" as const,
    firstSetWeeks: firstChangeSetWeeks(plan, input.todayDateKey),
    approvedWeeks: [],
  };
  await mirror.writeDelivery({
    planId: input.planId,
    stateKind: current?.stateKind ?? delivery.kind,
    stateJson: current?.stateJson ?? encodeWeekDelivery(delivery),
    closeChoiceJson: encodeCloseChoice(input.choice),
    updatedAtMs: Math.max(input.nowMs, current?.updatedAtMs ?? 0),
  });
}

export async function releaseReplacedPlans(
  store: ReplaceStore,
  input: {
    readonly planId: string;
    readonly todayDateKey: number;
    readonly nowMs: number;
    readonly newId: () => string;
    readonly ticked: readonly TickedChange[];
  },
): Promise<void> {
  const holds = createPlanCleanupHoldRepository(store);
  const plans = createLegacyPlanRepository(store);
  let closedOnDateKey = input.todayDateKey;
  for (const hold of await holds.readForReplacement(input.planId)) {
    if (hold.releasedAtMs !== null) continue;
    const workouts = new Set((await plans.readWorkouts(hold.planId)).map((workout) => workout.id));
    const ticked = input.ticked.filter((tick) => workouts.has(tick.planWorkoutId));
    const ending = planEndingStep(
      { kind: "replacement-in-review", replacementPlanId: input.planId },
      {
        type: "athlete-approves-replacement",
        todayDateKey: input.todayDateKey,
        athleteChanges:
          ticked.length === 0 ? { kind: "keep-them" } : { kind: "remove-them", ticked },
      },
    );
    if (ending.kind !== "closed") continue;
    closedOnDateKey = ending.closedOnDateKey;
    await saveCloseChoice(store, {
      planId: hold.planId,
      choice: ending.athleteChanges,
      todayDateKey: input.todayDateKey,
      nowMs: input.nowMs,
    });
  }
  await holds.release(input.planId, {
    closedOnDateKey,
    nowMs: input.nowMs,
    newId: input.newId,
  });
}

type CleanupState = PlanCalendarReplacing["cleanup"];

const CLEANUP_ORDER: readonly CleanupState[] = ["held", "failed", "running", "pending"];

function chosen(
  changes: readonly PlanCalendarAthleteChange[],
  choice: AthleteChangesChoice,
): readonly PlanCalendarAthleteChange[] {
  const ticked = choice.kind === "remove-them" ? choice.ticked : [];
  return changes.filter((change) => ticked.some((tick) => sameTick(tick, change.tick)));
}

function removed(change: PlanCalendarAthleteChange): PlanCalendarEndingWorkout {
  return {
    planWorkoutId: change.planWorkoutId,
    name: change.name,
    dateKey: change.dateKey,
    durationS: change.durationS,
  };
}

export async function readReplacing(
  store: ReplaceStore,
  input: { readonly planId: string; readonly todayDateKey: number },
): Promise<PlanCalendarReplacing | null> {
  const reconciliation = createPlanReconciliationRepository(store);
  const mirror = createPlanCalendarMirrorRepository(store);
  const plans = createLegacyPlanRepository(store);
  const states: CleanupState[] = [];
  const removes: PlanCalendarEndingWorkout[] = [];
  const staysToday: PlanCalendarEndingWorkout[] = [];
  const athleteChanges: PlanCalendarAthleteChange[] = [];
  let planName: string | null = null;
  for (const hold of await createPlanCleanupHoldRepository(store).readForReplacement(
    input.planId,
  )) {
    const job =
      hold.releasedAtMs === null
        ? undefined
        : await reconciliation.readLatestJob(hold.planId, "cleanup");
    if (hold.releasedAtMs !== null && (job === undefined || job.status === "verified")) continue;
    const state: CleanupState =
      job === undefined
        ? "held"
        : job.status === "failed"
          ? "failed"
          : job.status === "pending"
            ? "pending"
            : "running";
    const ending = await planEndingView(
      store,
      hold.planId,
      job === undefined ? input.todayDateKey : job.windowStartDateKey - 1,
    );
    const delivery = job === undefined ? undefined : await mirror.readDelivery(hold.planId);
    const choice: AthleteChangesChoice =
      delivery === undefined ? { kind: "keep-them" } : decodeCloseChoice(delivery.closeChoiceJson);
    const going = chosen(ending.athleteChanges, choice);
    states.push(state);
    removes.push(...ending.removes, ...going.map(removed));
    staysToday.push(...ending.staysToday);
    athleteChanges.push(...ending.athleteChanges.filter((change) => !going.includes(change)));
    const name = (await plans.read(hold.planId))?.name ?? "";
    if (planName === null || ending.removes.length + ending.athleteChanges.length > 0) {
      planName = name;
    }
  }
  const cleanup = CLEANUP_ORDER.find((state) => states.includes(state));
  if (cleanup === undefined || planName === null) return null;
  return {
    planName: planName.slice(0, 512),
    cleanup,
    removes: removes.sort((left, right) => left.dateKey - right.dateKey).slice(0, 500),
    staysToday: staysToday.slice(0, 20),
    athleteChanges: athleteChanges
      .sort((left, right) => left.dateKey - right.dateKey)
      .slice(0, 500),
  };
}

export async function sendsFrom(
  store: ReplaceStore,
  planId: string,
  todayDateKey: number,
): Promise<number> {
  const barrier = await createPlanReconciliationRepository(store).readCleanupBarrier();
  const held = (await createPlanCleanupHoldRepository(store).readForReplacement(planId)).some(
    (hold) => hold.releasedAtMs === null,
  );
  return Math.max(
    todayDateKey,
    barrier?.windowStartDateKey ?? todayDateKey,
    held ? addCivilDays(todayDateKey, 1) : todayDateKey,
  );
}
