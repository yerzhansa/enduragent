import { canonicalJson } from "@enduragent/kernel/archive";
import {
  dateKeyFromText,
  type PlanChangeWorkoutMutations,
  type PlanCreationCommandStamp,
  type PlanWorkoutRecord,
} from "@enduragent/kernel/planning";
import { PlanCreationDraftSchema } from "@enduragent/coach-contract";
import { z } from "zod";

const DraftIdSchema = z.object({ id: z.string() }).passthrough();

export function draftIdOf(workout: Pick<PlanWorkoutRecord, "structureJson">): string {
  return DraftIdSchema.parse(JSON.parse(workout.structureJson)).id;
}

export function materializePlanChange(input: {
  readonly snapshotJson: string;
  readonly currentWorkouts: readonly PlanWorkoutRecord[];
  readonly diffIds: ReadonlySet<string>;
  readonly planId: string;
  readonly command: PlanCreationCommandStamp;
  readonly newId: () => string;
}): PlanChangeWorkoutMutations {
  const draft = PlanCreationDraftSchema.parse(JSON.parse(input.snapshotJson));
  const currentByDraftId = new Map(
    input.currentWorkouts.map((workout) => [draftIdOf(workout), workout]),
  );
  const insert: PlanWorkoutRecord[] = [];
  const update: PlanWorkoutRecord[] = [];
  const retained = new Set<string>();
  for (const workout of draft.weeks.flatMap((week) => week.workouts)) {
    if (workout.date === null || !input.diffIds.has(workout.id)) continue;
    const current = currentByDraftId.get(workout.id);
    const row: PlanWorkoutRecord = {
      id: current?.id ?? input.newId(),
      planId: input.planId,
      dateKey: dateKeyFromText(workout.date),
      sport: "Ride",
      name: workout.name,
      durationS: Math.round(workout.minutes * 60),
      structureJson: canonicalJson(workout),
      origin: "coach",
      deviceId: input.command.deviceId,
      hlcPhysicalMs: input.command.hlcPhysicalMs,
      hlcCounter: input.command.hlcCounter,
    };
    retained.add(row.id);
    (current === undefined ? insert : update).push(row);
  }
  return {
    insert,
    update,
    delete: input.currentWorkouts
      .filter((workout) => input.diffIds.has(draftIdOf(workout)) && !retained.has(workout.id))
      .map((workout) => workout.id),
  };
}
