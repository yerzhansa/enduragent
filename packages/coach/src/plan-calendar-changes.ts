import type { PlanCalendarRpcResult, PlanCalendarWorkoutVersion } from "@enduragent/coach-contract";
import {
  applyIcuCopyEffect,
  icuCopyKeep,
  icuCopyOnRun,
  icuSightingKey,
  icuCopyPutBack,
  icuSighting,
  planWorkoutFingerprint,
  readIcuCopies,
  saveIcuCopy,
  storedIcuCopy,
  type CalendarMirrorPort,
  type DescribeWorkout,
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
  readonly describe: DescribeWorkout;
  readonly now: () => number;
  readonly changed: () => Promise<void>;
}

type ChangeRequest = { readonly planId: string; readonly planWorkoutId: string };
type ChoiceRequest = ChangeRequest & { readonly basis: string };

export async function sightingBasis(sighting: IcuSighting): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(icuSightingKey(sighting)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sendPlan(workout: PlanWorkoutRecord, describe: DescribeWorkout) {
  return { kind: "send" as const, planFingerprint: planWorkoutFingerprint(workout, describe) };
}

interface CardContext {
  readonly stored: PlanIcuCopyRecord;
  readonly card: Extract<IcuCopy, { kind: "changed-in-icu" }>;
  readonly workout: PlanWorkoutRecord;
}

const UNAVAILABLE: PlanCalendarRpcResult = { status: "refused", reason: "intervals-unavailable" };

function shownText(text: string | null | undefined): string | null {
  return typeof text === "string" && text.trim().length > 0 ? text : null;
}

function planVersion(
  workout: PlanWorkoutRecord,
  describe: DescribeWorkout,
): PlanCalendarWorkoutVersion {
  return {
    dateKey: workout.dateKey,
    name: workout.name,
    durationS: workout.durationS,
    description: shownText(describe(workout.structureJson)),
  };
}

function intervalsVersion(event: PlanMirrorEvent, workout: PlanWorkoutRecord) {
  const name = event.name?.trim();
  return {
    dateKey: event.dateKey,
    name: name === undefined || name.length === 0 ? workout.name : name,
    durationS: event.durationS ?? null,
    description: shownText(event.description),
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
  const observed = icuCopyOnRun(
    found.card,
    sendPlan(found.workout, deps.describe),
    current.sighting,
  ).copy;
  if (observed.kind !== "changed-in-icu") {
    await save(deps, request.planId, found, observed);
    void deps.changed();
    return { status: "change-resolved", outcome: "no-card" };
  }
  if (icuSightingKey(found.card.shown) !== icuSightingKey(current.sighting)) {
    await save(deps, request.planId, found, observed);
  }
  const intervals = current.event === null ? null : intervalsVersion(current.event, found.workout);
  return {
    status: "change-detail",
    basis: await sightingBasis(current.sighting),
    planWorkoutId: found.workout.id,
    change:
      intervals === null
        ? "deleted"
        : intervals.dateKey === found.card.baseline.dateKey
          ? "edited"
          : "moved",
    plan: planVersion(found.workout, deps.describe),
    intervals,
    editedAt: current.event?.updated ?? null,
  };
}

async function unseen(
  deps: PlanCalendarChangeDeps,
  request: ChoiceRequest,
  found: CardContext,
  sighting: IcuSighting,
): Promise<PlanCalendarRpcResult | null> {
  if ((await sightingBasis(sighting)) === request.basis) return null;
  const observed = icuCopyOnRun(found.card, sendPlan(found.workout, deps.describe), sighting).copy;
  if (observed.kind !== "changed-in-icu") {
    await save(deps, request.planId, found, observed);
    void deps.changed();
    return { status: "change-resolved", outcome: "no-card" };
  }
  await save(deps, request.planId, found, observed);
  return { status: "change-resolved", outcome: "refreshed" };
}

export async function putBackChange(
  deps: PlanCalendarChangeDeps,
  request: ChoiceRequest,
): Promise<PlanCalendarRpcResult> {
  const found = await context(deps, request);
  if (found === null) return { status: "change-resolved", outcome: "no-card" };
  const current = await readCurrent(deps, found.card);
  if (current === null) return UNAVAILABLE;
  const changedSince = await unseen(deps, request, found, current.sighting);
  if (changedSince !== null) return changedSince;
  const plan = sendPlan(found.workout, deps.describe);
  const decided = icuCopyPutBack(found.card, current.sighting, plan);
  if (decided.kind !== "done") {
    await save(deps, request.planId, found, decided.copy);
    return { status: "change-resolved", outcome: decided.kind };
  }
  const applied = await applyIcuCopyEffect(
    {
      calendar: deps.mirror,
      mirror: createPlanCalendarMirrorRepository(deps.store),
      describe: deps.describe,
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
  if (applied.copy.kind === "changed-in-icu") {
    return { status: "change-resolved", outcome: "refreshed" };
  }
  void deps.changed();
  return { status: "change-resolved", outcome: "put-back" };
}

export async function keepChange(
  deps: PlanCalendarChangeDeps,
  request: ChoiceRequest,
): Promise<PlanCalendarRpcResult> {
  const found = await context(deps, request);
  if (found === null) return { status: "change-resolved", outcome: "no-card" };
  const current = await readCurrent(deps, found.card);
  if (current === null) return UNAVAILABLE;
  const changedSince = await unseen(deps, request, found, current.sighting);
  if (changedSince !== null) return changedSince;
  const plan = sendPlan(found.workout, deps.describe);
  const probe = icuCopyKeep(found.card, current.sighting, plan, plan.planFingerprint);
  if (probe.kind !== "done") {
    await save(deps, request.planId, found, probe.copy);
    return { status: "change-resolved", outcome: probe.kind };
  }
  if (probe.effect.kind !== "adopt-into-plan" || current.event === null) {
    await save(deps, request.planId, found, probe.copy);
    void deps.changed();
    return { status: "change-resolved", outcome: "kept" };
  }
  const version = intervalsVersion(current.event, found.workout);
  const minutes = version.durationS === null ? undefined : Math.round(version.durationS / 60);
  const unchanged =
    version.dateKey === found.workout.dateKey &&
    version.name === found.workout.name &&
    (minutes === undefined || minutes === Math.round((found.workout.durationS ?? 0) / 60));
  const adopted = unchanged
    ? "applied"
    : await applyWorkoutEdits(deps, {
        planId: request.planId,
        title: "Kept your intervals.icu change",
        intent: { kind: "keep-intervals-change", planWorkoutId: found.workout.id },
        edits: [
          {
            planWorkoutId: found.workout.id,
            dateKey: version.dateKey,
            name: version.name,
            ...(minutes === undefined ? {} : { minutes }),
          },
        ],
      });
  if (adopted === "refused") return { status: "refused", reason: "plan-change-refused" };
  const updated = (await createLegacyPlanRepository(deps.store).readWorkouts(request.planId)).find(
    (row) => row.id === found.workout.id,
  );
  if (updated === undefined) return { status: "refused", reason: "plan-change-refused" };
  const keptPlan = sendPlan(updated, deps.describe);
  const kept = icuCopyKeep(found.card, current.sighting, keptPlan, keptPlan.planFingerprint);
  await save(deps, request.planId, found, kept.copy);
  void deps.changed();
  return { status: "change-resolved", outcome: "kept" };
}
