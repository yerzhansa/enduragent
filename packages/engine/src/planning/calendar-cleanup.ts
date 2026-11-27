import {
  addCivilDays,
  type PlanCalendarMirrorRepository,
  type PlanIcuCopyRecord,
  type PlanReconciliationJobRecord,
  type PlanReconciliationRepository,
} from "@enduragent/kernel/planning";
import { decodeCloseChoice } from "./calendar-codec.js";
import {
  groupedByWorkout,
  icuEventFingerprint,
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

function leftByPlan(stored: PlanIcuCopyRecord | undefined): boolean {
  if (stored === undefined) return true;
  const copy = storedIcuCopy(stored);
  return copy.kind === "not-sent" && copy.owner === "plan";
}

async function deleteIfUnchanged(
  calendar: CalendarMirrorPort,
  eventId: number,
  expected: { readonly fingerprint: string },
): Promise<"deleted" | "absent" | "changed" | "failed"> {
  const result = await writeIfUnchanged({
    read: () => readIcuSighting(calendar, eventId),
    alreadyWritten: (current) => current.kind === "absent",
    stillAsSeen: (current) =>
      current.kind === "present" && current.version.fingerprint === expected.fingerprint,
    write: async () => {
      await calendar.deleteEvent({ eventId });
      return eventId;
    },
  });
  if (result.kind === "read-failed" || result.kind === "write-failed") return "failed";
  if (result.kind === "changed") return "changed";
  return result.kind === "written" ? "deleted" : "absent";
}

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
  const deleted = new Map<string, number>();
  for (const target of cleanupDeletes(copies, ending)) {
    const result = await deleteIfUnchanged(deps.calendar, target.eventId, target.expected);
    if (result === "failed") {
      failures += 1;
      continue;
    }
    if (result === "changed") continue;
    deleted.set(target.planWorkoutId, target.eventId);
    removed += result === "deleted" ? 1 : 0;
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
  const releases: [string, readonly PlanMirrorEvent[]][] = [];
  for (const [planWorkoutId, events] of listed) {
    const stored = records.get(planWorkoutId);
    const deletedEventId = deleted.get(planWorkoutId);
    if (deletedEventId === undefined && !leftByPlan(stored)) {
      releases.push([planWorkoutId, events]);
      continue;
    }
    for (const event of events) {
      if (event.id === deletedEventId) continue;
      const result = await deleteIfUnchanged(deps.calendar, event.id, {
        fingerprint: icuEventFingerprint(event),
      });
      if (result === "failed") failures += 1;
      if (result === "deleted") removed += 1;
    }
  }
  if (failures > 0) {
    await deps.reconciliation.failJob(running.id, "calendar-delete-failed", deps.now());
    return { kind: "failed" };
  }
  let kept = 0;
  for (const [planWorkoutId, events] of releases) {
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
  for (const item of await deps.reconciliation.readItems(running.id)) {
    await deps.reconciliation.deleteItem(item.id);
  }
  await deps.reconciliation.verifyJob(running.id, deps.now());
  return { kind: "verified", removed, kept };
}
