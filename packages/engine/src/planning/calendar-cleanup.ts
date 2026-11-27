import {
  addCivilDays,
  type PlanCalendarMirrorRepository,
  type PlanReconciliationJobRecord,
  type PlanReconciliationRepository,
} from "@enduragent/kernel/planning";
import { decodeCloseChoice } from "./calendar-codec.js";
import {
  groupedByWorkout,
  readIcuCopies,
  readIcuSighting,
  saveIcuCopy,
  storedIcuCopy,
  type CalendarMirrorPort,
} from "./calendar-mirror.js";
import { writeIfUnchanged } from "./conditional-write.js";
import { icuCopyDeleted, type IcuCopy } from "./icu-copy.js";
import { cleanupDeletes, type PlanCopyOnIcu, type PlanEnding } from "./plan-ending.js";
import type { PlanMirrorEvent } from "./reconciler.js";

export interface CalendarCleanupDeps {
  readonly calendar: CalendarMirrorPort;
  readonly mirror: PlanCalendarMirrorRepository;
  readonly reconciliation: PlanReconciliationRepository;
  now(): number;
}

export type CalendarCleanupResult =
  | { readonly kind: "verified"; readonly removed: number; readonly kept: number }
  | { readonly kind: "failed" };

function released(copy: IcuCopy, event: PlanMirrorEvent | undefined): IcuCopy {
  if (copy.kind === "kept-as-yours" || copy.kind === "removed-by-you") return copy;
  if (event === undefined) return icuCopyDeleted(copy);
  return { kind: "kept-as-yours", eventId: event.id };
}

export async function cleanupPlanCalendar(
  job: PlanReconciliationJobRecord,
  deps: CalendarCleanupDeps,
): Promise<CalendarCleanupResult> {
  const running = await deps.reconciliation.beginAttempt(job.id, deps.now());
  const closedOnDateKey = addCivilDays(running.windowStartDateKey, -1);
  const delivery = await deps.mirror.readDelivery(running.planId);
  const ending: PlanEnding = {
    kind: "closed",
    reason: "ended",
    closedOnDateKey,
    athleteChanges:
      delivery === undefined ? { kind: "keep-them" } : decodeCloseChoice(delivery.closeChoiceJson),
    cleanup: { kind: "running" },
    replacement: { kind: "no-replacement" },
  };
  const records = await readIcuCopies(deps.mirror, running.planId);
  const copies: PlanCopyOnIcu[] = [...records.values()].map((record) => ({
    planWorkoutId: record.planWorkoutId,
    dateKey: record.dateKey,
    copy: storedIcuCopy(record),
  }));
  let listed: ReadonlyMap<string, readonly PlanMirrorEvent[]>;
  try {
    listed = groupedByWorkout(
      running.planId,
      await deps.calendar.listEvents({
        startDateKey: running.windowStartDateKey,
        endDateKey: running.windowEndDateKey,
      }),
    );
  } catch {
    await deps.reconciliation.failJob(running.id, "calendar-list-failed", deps.now());
    return { kind: "failed" };
  }
  let removed = 0;
  let failures = 0;
  const deleted = new Set<string>();
  for (const target of cleanupDeletes(copies, ending)) {
    const result = await writeIfUnchanged({
      read: () => readIcuSighting(deps.calendar, target.eventId),
      alreadyWritten: (current) => current.kind === "absent",
      stillAsSeen: (current) =>
        current.kind === "present" && current.version.fingerprint === target.expected.fingerprint,
      write: async () => {
        await deps.calendar.deleteEvent({ eventId: target.eventId });
        return target.eventId;
      },
    });
    if (result.kind === "read-failed" || result.kind === "write-failed") {
      failures += 1;
      continue;
    }
    if (result.kind === "changed") continue;
    deleted.add(target.planWorkoutId);
    removed += result.kind === "written" ? 1 : 0;
    const stored = records.get(target.planWorkoutId);
    await saveIcuCopy(deps, {
      planId: running.planId,
      planWorkoutId: target.planWorkoutId,
      fallbackDateKey: stored?.dateKey ?? running.windowStartDateKey,
      stored,
      copy: icuCopyDeleted(storedIcuCopy(stored)),
      lastWrite: { kind: "ok" },
    });
  }
  if (failures > 0) {
    await deps.reconciliation.failJob(running.id, "calendar-delete-failed", deps.now());
    return { kind: "failed" };
  }
  let kept = 0;
  for (const [planWorkoutId, events] of listed) {
    if (deleted.has(planWorkoutId)) continue;
    const stored = records.get(planWorkoutId);
    if (stored === undefined) continue;
    kept += 1;
    await saveIcuCopy(deps, {
      planId: running.planId,
      planWorkoutId,
      fallbackDateKey: stored.dateKey,
      stored,
      copy: released(storedIcuCopy(stored), events[0]),
      lastWrite: stored.lastWrite,
    });
  }
  await deps.reconciliation.verifyJob(running.id, deps.now());
  return { kind: "verified", removed, kept };
}
