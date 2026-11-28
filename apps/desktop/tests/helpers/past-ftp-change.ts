import { createHash } from "node:crypto";
import { PlanCreationDraftSchema } from "@enduragent/coach-contract";
import { canonicalJson } from "@enduragent/kernel/archive";
import {
  createPlanChangeRepository,
  PlanChangeEnvelopeSchema,
  type PlanCreationCommandStamp,
  type PlanCreationStore,
} from "@enduragent/kernel/planning";
import { applyScheduleIntent } from "@enduragent/sport-cycling";
import { materializePlanChange } from "../../../../packages/coach/src/plan-change-materialize.js";

export interface PastFtpChange {
  readonly planId: string;
  readonly expectedVersion: number;
  readonly watts: number;
  readonly todayDateKey: number;
  readonly nowMs: number;
  readonly newId: () => string;
  readonly pending?: boolean;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export async function seedPastFtpChange(
  store: PlanCreationStore,
  change: PastFtpChange,
): Promise<{ readonly changeId: string }> {
  const repository = createPlanChangeRepository(store, { newId: change.newId, sha256 });
  const intent = { kind: "ftp", watts: change.watts } as const;
  const changeId = change.newId();
  const command = (step: string): PlanCreationCommandStamp => ({
    commandId: `past-ftp-${step}-${changeId}`,
    requestDigest: sha256(`past-ftp-${step}-${changeId}`),
    nowMs: change.nowMs,
    deviceId: "past-ftp-device",
    hlcPhysicalMs: change.nowMs,
    hlcCounter: 0,
  });
  const previewed = await repository.preview({
    command: command("preview"),
    planId: change.planId,
    expectedVersion: change.expectedVersion,
    nowMs: change.nowMs,
    changeId,
    build({ snapshotJson, completedWorkoutIds }) {
      const draft = PlanCreationDraftSchema.parse(JSON.parse(snapshotJson));
      const { after, diff, totals } = applyScheduleIntent({
        draft,
        todayDateKey: change.todayDateKey,
        completedWorkoutIds,
        intent,
      });
      return {
        afterSnapshotJson: canonicalJson(after),
        envelope: PlanChangeEnvelopeSchema.parse({
          title: "Correct FTP",
          intent,
          diff,
          totals,
          supersedes: null,
          premises: [
            {
              id: "ftp-sources",
              label: "FTP source comparison at this decision",
              source: "Saved profile and synchronized FTP evidence",
              value: { acceptedPlanFtp: draft.ftp, requestedFtp: change.watts, candidates: [] },
            },
          ],
          confidence:
            "Moderate confidence. Based on your confirmed limits and the available training record.",
        }),
      };
    },
  });
  if (previewed.status !== "previewed") {
    throw new TypeError(`The past FTP change was not stored: ${JSON.stringify(previewed)}`);
  }
  if (change.pending === true) return { changeId };
  const applyCommand = command("apply");
  const applied = await repository.apply({
    command: applyCommand,
    planId: change.planId,
    changeId,
    expectedVersion: change.expectedVersion,
    decision: "apply",
    nowMs: change.nowMs,
    todayDateKey: () => change.todayDateKey,
    mirrorJobId: change.newId(),
    materialize: (snapshotJson, currentWorkouts, diffIds) =>
      materializePlanChange({
        snapshotJson,
        currentWorkouts,
        diffIds,
        planId: change.planId,
        command: applyCommand,
        newId: change.newId,
      }),
  });
  if (applied.status !== "applied") {
    throw new TypeError(`The past FTP change was not applied: ${JSON.stringify(applied)}`);
  }
  return { changeId };
}
