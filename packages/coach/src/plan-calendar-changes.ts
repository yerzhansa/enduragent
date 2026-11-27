import type { PlanCalendarRpcResult, PlanCalendarWorkoutVersion } from "@enduragent/coach-contract";
import {
  applyIcuCopyEffect,
  icuCopyKeep,
  icuCopyPutBack,
  icuSighting,
  planWorkoutFingerprint,
  readIcuCopies,
  saveIcuCopy,
  storedIcuCopy,
  type CalendarMirrorPort,
  type IcuCopy,
  type IcuSighting,
} from "@enduragent/engine/calendar";
import type { PlanMirrorEvent } from "@enduragent/engine";
import {
  createPlanCalendarMirrorRepository,
  type PlanIcuCopyRecord,
  type PlanWorkoutRecord,
} from "@enduragent/kernel/planning";
import type { MigratorStore, SqlStore } from "@enduragent/kernel/store";
import { createLegacyPlanRepository } from "@enduragent/kernel-node/planning";
import { applyWorkoutEdits, type PlanCalendarEditDeps } from "./plan-calendar-edit.js";

export interface PlanCalendarChangeDeps extends PlanCalendarEditDeps {
  readonly store: SqlStore & Pick<MigratorStore, "transaction">;
  readonly mirror: CalendarMirrorPort;
  readonly now: () => number;
  readonly changed: () => void;
}

type ChangeRequest = { readonly planId: string; readonly planWorkoutId: string };

interface CardContext {
  readonly stored: PlanIcuCopyRecord;
  readonly card: Extract<IcuCopy, { kind: "changed-in-icu" }>;
  readonly workout: PlanWorkoutRecord;
}

const UNAVAILABLE: PlanCalendarRpcResult = { status: "refused", reason: "intervals-unavailable" };

function descriptionOf(structureJson: string): string | null {
  try {
    const value: unknown = JSON.parse(structureJson);
    if (value === null || typeof value !== "object" || !("description" in value)) return null;
    return typeof value.description === "string" && value.description.trim().length > 0
      ? value.description
      : null;
  } catch {
    return null;
  }
}

function planVersion(workout: PlanWorkoutRecord): PlanCalendarWorkoutVersion {
  return {
    dateKey: workout.dateKey,
    name: workout.name,
    durationS: workout.durationS,
    description: descriptionOf(workout.structureJson),
  };
}

function intervalsVersion(event: PlanMirrorEvent, workout: PlanWorkoutRecord) {
  const name = event.name?.trim();
  return {
    dateKey: event.dateKey,
    name: name === undefined || name.length === 0 ? workout.name : name,
    durationS: event.durationS ?? null,
    description:
      typeof event.description === "string" && event.description.trim().length > 0
        ? event.description
        : null,
  };
}

async function context(
  deps: PlanCalendarChangeDeps,
  request: ChangeRequest,
): Promise<CardContext | null> {
  const stored = (
    await readIcuCopies(createPlanCalendarMirrorRepository(deps.store), request.planId)
  ).get(request.planWorkoutId);
  const card = storedIcuCopy(stored);
  if (stored === undefined || card.kind !== "changed-in-icu") return null;
  const workout = (await createLegacyPlanRepository(deps.store).readWorkouts(request.planId)).find(
    (row) => row.id === request.planWorkoutId,
  );
  return workout === undefined ? null : { stored, card, workout };
}

async function readCurrent(
  deps: PlanCalendarChangeDeps,
  card: CardContext["card"],
): Promise<{ readonly sighting: IcuSighting; readonly event: PlanMirrorEvent | null } | null> {
  const eventId = card.shown.kind === "present" ? card.shown.eventId : card.baseline.eventId;
  try {
    const event = await deps.mirror.readEvent({ eventId });
    return { sighting: icuSighting(event), event };
  } catch {
    return null;
  }
}

async function save(
  deps: PlanCalendarChangeDeps,
  planId: string,
  found: CardContext,
  copy: IcuCopy,
  lastWrite: PlanIcuCopyRecord["lastWrite"] = found.stored.lastWrite,
): Promise<void> {
  await saveIcuCopy(
    { mirror: createPlanCalendarMirrorRepository(deps.store), now: deps.now },
    {
      planId,
      planWorkoutId: found.workout.id,
      fallbackDateKey: found.workout.dateKey,
      stored: found.stored,
      copy,
      lastWrite,
    },
  );
}

export async function changeDetail(
  deps: PlanCalendarChangeDeps,
  request: ChangeRequest,
): Promise<PlanCalendarRpcResult> {
  const found = await context(deps, request);
  if (found === null) return { status: "change-resolved", outcome: "no-card" };
  const current = await readCurrent(deps, found.card);
  if (current === null) return UNAVAILABLE;
  const intervals = current.event === null ? null : intervalsVersion(current.event, found.workout);
  return {
    status: "change-detail",
    planWorkoutId: found.workout.id,
    change:
      intervals === null
        ? "deleted"
        : intervals.dateKey === found.card.baseline.dateKey
          ? "edited"
          : "moved",
    plan: planVersion(found.workout),
    intervals,
    editedAt: current.event?.updated ?? null,
  };
}

export async function putBackChange(
  deps: PlanCalendarChangeDeps,
  request: ChangeRequest,
): Promise<PlanCalendarRpcResult> {
  const found = await context(deps, request);
  if (found === null) return { status: "change-resolved", outcome: "no-card" };
  const current = await readCurrent(deps, found.card);
  if (current === null) return UNAVAILABLE;
  const plan = { kind: "send" as const, planFingerprint: planWorkoutFingerprint(found.workout) };
  const decided = icuCopyPutBack(found.card, current.sighting, plan);
  if (decided.kind !== "done") {
    await save(deps, request.planId, found, decided.copy);
    return { status: "change-resolved", outcome: decided.kind };
  }
  const applied = await applyIcuCopyEffect(
    {
      calendar: deps.mirror,
      mirror: createPlanCalendarMirrorRepository(deps.store),
      now: deps.now,
    },
    request.planId,
    {
      planWorkoutId: found.workout.id,
      workout: found.workout,
      stored: found.stored,
      copy: found.card,
      plan,
    },
    decided.copy,
    decided.effect,
  );
  await save(deps, request.planId, found, applied.copy, applied.lastWrite);
  if (applied.lastWrite.kind === "failed") return UNAVAILABLE;
  deps.changed();
  return { status: "change-resolved", outcome: "put-back" };
}

export async function keepChange(
  deps: PlanCalendarChangeDeps,
  request: ChangeRequest,
): Promise<PlanCalendarRpcResult> {
  const found = await context(deps, request);
  if (found === null) return { status: "change-resolved", outcome: "no-card" };
  const current = await readCurrent(deps, found.card);
  if (current === null) return UNAVAILABLE;
  const plan = { kind: "send" as const, planFingerprint: planWorkoutFingerprint(found.workout) };
  const probe = icuCopyKeep(found.card, current.sighting, plan, plan.planFingerprint);
  if (probe.kind !== "done") {
    await save(deps, request.planId, found, probe.copy);
    return { status: "change-resolved", outcome: probe.kind };
  }
  if (probe.effect.kind !== "adopt-into-plan" || current.event === null) {
    await save(deps, request.planId, found, probe.copy);
    deps.changed();
    return { status: "change-resolved", outcome: "kept" };
  }
  const version = intervalsVersion(current.event, found.workout);
  const adopted = await applyWorkoutEdits(deps, {
    planId: request.planId,
    title: "Kept your intervals.icu change",
    intent: { kind: "keep-intervals-change", planWorkoutId: found.workout.id },
    edits: [
      {
        planWorkoutId: found.workout.id,
        dateKey: version.dateKey,
        name: version.name,
        minutes: Math.round((version.durationS ?? found.workout.durationS ?? 60) / 60),
      },
    ],
  });
  if (adopted === "refused") return { status: "refused", reason: "plan-change-refused" };
  const updated = (await createLegacyPlanRepository(deps.store).readWorkouts(request.planId)).find(
    (row) => row.id === found.workout.id,
  );
  if (updated === undefined) return { status: "refused", reason: "plan-change-refused" };
  const kept = icuCopyKeep(
    found.card,
    current.sighting,
    { kind: "send", planFingerprint: planWorkoutFingerprint(updated) },
    planWorkoutFingerprint(updated),
  );
  await save(deps, request.planId, found, kept.copy);
  deps.changed();
  return { status: "change-resolved", outcome: "kept" };
}
