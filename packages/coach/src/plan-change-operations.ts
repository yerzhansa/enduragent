import {
  PlanChangeModelSchema,
  PlanChangeApplyRpcParamsSchema,
  PlanChangeApplyResultSchema,
  PlanChangePreviewRpcParamsSchema,
  PlanChangePreviewResultSchema,
  PlanCreationDraftSchema,
  type PlanChangeIntent,
  type PlanChangeOperations,
  type PlanChangeModel,
  type PlanChangesPaused,
} from "@enduragent/coach-contract";
import { canonicalJson } from "@enduragent/kernel/archive";
import {
  createPlanChangeRepository,
  createPlanWorkoutMatchRepository,
  PlanChangeEnvelopeSchema,
  dateKeyFromText,
  type PlanWorkoutRecord,
  type PlanChangeRepository,
} from "@enduragent/kernel/planning";
import type { MigratorStore, SqlStore } from "@enduragent/kernel/store";
import type { AuthoredIdentity } from "@enduragent/kernel-node/home";
import { applyScheduleIntent } from "@enduragent/sport-cycling";
import { z } from "zod";

export const PROPOSAL_STALE_AFTER_HOURS = 24;

export async function readPlanChangesPaused(input: {
  calendarConnected: () => Promise<boolean>;
  syncStatus: () => Promise<{ lastSuccessfulSyncAtMs: number | null; awaitingSync: boolean }>;
  now: () => number;
}): Promise<PlanChangesPaused> {
  if (!(await input.calendarConnected())) return null;
  const { lastSuccessfulSyncAtMs } = await input.syncStatus();
  return lastSuccessfulSyncAtMs !== null &&
    input.now() - lastSuccessfulSyncAtMs > PROPOSAL_STALE_AFTER_HOURS * 60 * 60 * 1000
    ? { reason: "sync-stale", lastSuccessfulSyncAtMs }
    : null;
}

const DraftIdSchema = z.object({ id: z.string() }).passthrough();

const titles = {
  "weekday-duration": "Limit weekday duration",
  "weekday-unavailable": "Keep a weekday free",
  "hard-weekday": "No hard training on a weekday",
  "weekly-duration": "Limit weekly duration",
  "longest-workout": "Limit the longest Workout",
  inverse: "Undo the latest Change",
} satisfies Record<PlanChangeIntent["kind"], string>;

async function readCompletedWorkoutIds(
  store: SqlStore,
  planId: string,
): Promise<ReadonlySet<string>> {
  const rows = await store.all(
    `SELECT workout.structure_json FROM plan_workout workout
    WHERE workout.plan_id=? AND EXISTS (
      SELECT 1 FROM plan_workout_match match
      WHERE match.plan_workout_id=workout.id AND match.plan_id=workout.plan_id
        AND match.decision='confirmed'
    )`,
    [planId],
  );
  return new Set(
    rows.map((row) => DraftIdSchema.parse(JSON.parse(z.string().parse(row.structure_json))).id),
  );
}

export async function projectPlanChanges(input: {
  repository: PlanChangeRepository;
  store: SqlStore;
  planId: string;
  todayDateKey: number;
}): Promise<PlanChangeModel[]> {
  const changes = await input.repository.listChanges(input.planId);
  if (!changes.some((change) => change.status === "applied"))
    return changes.map((change) => PlanChangeModelSchema.parse({ ...change, undo: null }));
  const context = await input.repository.readUndoContext(input.planId);
  const completedWorkoutIds = await readCompletedWorkoutIds(input.store, input.planId);
  return changes.map((change) => {
    let undo: PlanChangeModel["undo"] = null;
    if (change.status === "applied") {
      if (context === null) undo = { eligible: false, reason: "plan-changed" };
      else if (context.newestApplied?.changeId !== change.changeId)
        undo = { eligible: false, reason: "not-newest" };
      else if (PlanChangeModelSchema.shape.intent.parse(change.intent).kind === "inverse")
        undo = { eligible: false, reason: "inverse" };
      else if (
        change.resultRevisionNumber !== context.currentRevisionNumber ||
        context.previousSnapshotJson === null
      )
        undo = { eligible: false, reason: "plan-changed" };
      else {
        const restored = applyScheduleIntent({
          draft: PlanCreationDraftSchema.parse(JSON.parse(context.snapshotJson)),
          previousDraft: PlanCreationDraftSchema.parse(JSON.parse(context.previousSnapshotJson)),
          intent: { kind: "inverse", changeId: change.changeId },
          completedWorkoutIds,
          todayDateKey: input.todayDateKey,
        });
        undo =
          restored.diff.length > 0
            ? { eligible: true }
            : { eligible: false, reason: "nothing-to-restore" };
      }
    }
    return PlanChangeModelSchema.parse({ ...change, undo });
  });
}

export function createPlanChangeOperations(input: {
  store: SqlStore & Pick<MigratorStore, "transaction">;
  identity: AuthoredIdentity;
  crypto: Crypto;
  todayDateKey: () => number;
  now: () => number;
  calendarConnected: () => Promise<boolean>;
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
  const admit = async (store: SqlStore) =>
    (
      await readPlanChangesPaused({
        calendarConnected: input.calendarConnected,
        syncStatus: () => createPlanWorkoutMatchRepository(store).readSyncStatus(),
        now: input.now,
      })
    )?.reason ?? null;
  return {
    async "plan_change.preview"(request) {
      const parsed = PlanChangePreviewRpcParamsSchema.safeParse(request);
      if (!parsed.success) {
        if (parsed.error.issues.every((issue) => issue.path[0] === "intent"))
          return { status: "rejected", reason: "invalid-intent" };
        throw parsed.error;
      }
      const { intent, planId, expectedVersion } = parsed.data;
      const result = await repository.preview({
        admit,
        command: await stamp(parsed.data),
        planId,
        expectedVersion,
        nowMs: input.now(),
        changeId: input.identity.newUlid(),
        build({
          snapshotJson,
          previousSnapshotJson,
          newestApplied,
          currentRevisionNumber,
          completedWorkoutIds,
        }) {
          const draft = PlanCreationDraftSchema.parse(JSON.parse(snapshotJson));
          if (
            intent.kind === "inverse" &&
            (newestApplied?.changeId !== intent.changeId ||
              newestApplied.resultRevisionNumber !== currentRevisionNumber ||
              previousSnapshotJson === null ||
              PlanChangeModelSchema.shape.intent.parse(newestApplied.intent).kind === "inverse")
          )
            return { status: "rejected", reason: "invalid-intent" };
          const transformation = {
            draft,
            completedWorkoutIds,
            todayDateKey: input.todayDateKey(),
          };
          const { after, diff, totals } =
            intent.kind === "inverse"
              ? applyScheduleIntent({
                  ...transformation,
                  intent,
                  previousDraft: PlanCreationDraftSchema.parse(
                    JSON.parse(previousSnapshotJson ?? "null"),
                  ),
                })
              : applyScheduleIntent({ ...transformation, intent });
          if (intent.kind === "inverse" && diff.length === 0)
            return { status: "rejected", reason: "invalid-intent" };
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
                ...(intent.kind === "inverse" && newestApplied !== null
                  ? [
                      {
                        id: "undone-change",
                        label: "Applied Change",
                        source: "Plan history",
                        value: { changeId: newestApplied.changeId, title: newestApplied.title },
                      },
                    ]
                  : []),
              ],
              confidence:
                "Moderate confidence. Based on your confirmed limits and the available training record.",
            }),
          };
        },
      });
      return PlanChangePreviewResultSchema.parse(
        result.status === "previewed"
          ? { ...result, change: { ...result.change, undo: null } }
          : result,
      );
    },
    async "plan_change.apply"(request) {
      const parsed = PlanChangeApplyRpcParamsSchema.parse(request);
      const command = await stamp(parsed);
      const result = await repository.apply({
        admit,
        command,
        planId: parsed.planId,
        changeId: parsed.changeId,
        expectedVersion: parsed.expectedVersion,
        decision: parsed.decision,
        nowMs: input.now(),
        todayDateKey: input.todayDateKey,
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
