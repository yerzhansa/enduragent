import {
  PlanChangeApplyRpcParamsSchema,
  PlanChangeApplyResultSchema,
  PlanChangePreviewRpcParamsSchema,
  PlanChangePreviewResultSchema,
  PlanCreationDraftSchema,
  type PlanChangeIntent,
  type PlanChangeOperations,
} from "@enduragent/coach-contract";
import { canonicalJson } from "@enduragent/kernel/archive";
import {
  createPlanChangeRepository,
  PlanChangeEnvelopeSchema,
  dateKeyFromText,
  type PlanWorkoutRecord,
} from "@enduragent/kernel/planning";
import type { MigratorStore, SqlStore } from "@enduragent/kernel/store";
import type { AuthoredIdentity } from "@enduragent/kernel-node/home";
import { applyScheduleIntent } from "@enduragent/sport-cycling";
import { z } from "zod";

const DraftIdSchema = z.object({ id: z.string() }).passthrough();

const titles = {
  "weekday-duration": "Limit weekday duration",
  "weekday-unavailable": "Keep a weekday free",
  "hard-weekday": "No hard training on a weekday",
  "weekly-duration": "Limit weekly duration",
  "longest-workout": "Limit the longest Workout",
} satisfies Record<PlanChangeIntent["kind"], string>;

export function createPlanChangeOperations(input: {
  store: SqlStore & Pick<MigratorStore, "transaction">;
  identity: AuthoredIdentity;
  crypto: Crypto;
  todayDateKey: () => number;
  now: () => number;
}): PlanChangeOperations {
  const sha256 = async (text: string): Promise<string> => {
    const digest = await input.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  const repository = createPlanChangeRepository(input.store, {
    newId: () => input.identity.newUlid(),
    sha256,
  });
  const stamp = async (request: { commandId: string }) => {
    const requestDigest = await sha256(canonicalJson(request));
    const clock = input.identity.hlcStamp();
    return {
      commandId: request.commandId,
      requestDigest,
      nowMs: clock.physicalMs,
      deviceId: await input.identity.deviceId(),
      hlcPhysicalMs: clock.physicalMs,
      hlcCounter: clock.counter,
    };
  };
  return {
    async "plan_change.preview"(request) {
      const parsed = PlanChangePreviewRpcParamsSchema.safeParse(request);
      if (!parsed.success) {
        if (parsed.error.issues.every((issue) => issue.path[0] === "intent"))
          return { status: "rejected", reason: "invalid-intent" };
        throw parsed.error;
      }
      const { intent, planId, expectedVersion } = parsed.data;
      const completedRows = await input.store.all(
        `SELECT workout.structure_json FROM plan_workout workout
        WHERE workout.plan_id=? AND EXISTS (
          SELECT 1 FROM plan_workout_match match
          WHERE match.plan_workout_id=workout.id AND match.plan_id=workout.plan_id
            AND match.decision='confirmed'
        )`,
        [planId],
      );
      const completedWorkoutIds = new Set(
        completedRows.map(
          (row) => DraftIdSchema.parse(JSON.parse(z.string().parse(row.structure_json))).id,
        ),
      );
      const result = await repository.preview({
        command: await stamp(parsed.data),
        planId,
        expectedVersion,
        nowMs: input.now(),
        changeId: input.identity.newUlid(),
        build(snapshotJson) {
          const draft = PlanCreationDraftSchema.parse(JSON.parse(snapshotJson));
          const { after, diff, totals } = applyScheduleIntent({
            draft,
            intent,
            completedWorkoutIds,
            todayDateKey: input.todayDateKey(),
          });
          return {
            afterSnapshotJson: canonicalJson(after),
            envelope: PlanChangeEnvelopeSchema.parse({
              title: titles[intent.kind],
              intent,
              diff,
              totals,
              supersedes: null,
              premises: [
                {
                  id: "confirmed-limits",
                  label: "Confirmed Plan limits",
                  source: "Your confirmed answers",
                  value: intent,
                },
              ],
              confidence:
                "Moderate confidence. Based on your confirmed limits and the available training record.",
            }),
          };
        },
      });
      return PlanChangePreviewResultSchema.parse(result);
    },
    async "plan_change.apply"(request) {
      const parsed = PlanChangeApplyRpcParamsSchema.parse(request);
      const command = await stamp(parsed);
      const result = await repository.apply({
        command,
        planId: parsed.planId,
        changeId: parsed.changeId,
        expectedVersion: parsed.expectedVersion,
        decision: parsed.decision,
        nowMs: input.now(),
        todayDateKey: input.todayDateKey(),
        mirrorJobId: input.identity.newUlid(),
        materialize(snapshotJson, currentWorkouts, diffIds) {
          const draft = PlanCreationDraftSchema.parse(JSON.parse(snapshotJson));
          const currentByDraftId = new Map(
            currentWorkouts.map((workout) => [
              DraftIdSchema.parse(JSON.parse(workout.structureJson)).id,
              workout,
            ]),
          );
          const insert: PlanWorkoutRecord[] = [];
          const update: PlanWorkoutRecord[] = [];
          const retained = new Set<string>();
          for (const workout of draft.weeks.flatMap((week) => week.workouts)) {
            if (workout.date === null || !diffIds.has(workout.id)) continue;
            const current = currentByDraftId.get(workout.id);
            const row: PlanWorkoutRecord = {
              id: current?.id ?? input.identity.newUlid(),
              planId: parsed.planId,
              dateKey: dateKeyFromText(workout.date),
              sport: "Ride",
              name: workout.name,
              durationS: Math.round(workout.minutes * 60),
              structureJson: canonicalJson(workout),
              origin: "coach",
              deviceId: command.deviceId,
              hlcPhysicalMs: command.hlcPhysicalMs,
              hlcCounter: command.hlcCounter,
            };
            retained.add(row.id);
            (current === undefined ? insert : update).push(row);
          }
          return {
            insert,
            update,
            delete: currentWorkouts
              .filter(
                (workout) =>
                  diffIds.has(DraftIdSchema.parse(JSON.parse(workout.structureJson)).id) &&
                  !retained.has(workout.id),
              )
              .map((workout) => workout.id),
          };
        },
      });
      return PlanChangeApplyResultSchema.parse(result);
    },
  };
}
