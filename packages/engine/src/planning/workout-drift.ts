import { canonicalJson } from "@enduragent/kernel/archive";
import {
  encodePlanAdaptationWorkoutSnapshot,
  planAdaptationWorkoutSnapshot,
  planWeekIndex,
  type PlanRecord,
  type PlanRepository,
  type PlanWorkoutDriftRecord,
  type PlanWorkoutDriftRepository,
  type PlanWorkoutRecord,
} from "@enduragent/kernel/planning";
import {
  planMirrorExternalId,
  type PlanMirrorCalendarPort,
  type PlanMirrorEvent,
} from "./reconciler.js";

export interface PlanWorkoutDriftSnapshot {
  readonly dateKey: number;
  readonly name: string;
  readonly durationS: number | null;
  readonly description: string | null;
}

export interface PlanWorkoutDriftIdentity {
  newId(): string;
  deviceId(): string | Promise<string>;
  stamp(): { readonly physicalMs: number; readonly counter: number };
}

export interface PlanWorkoutDriftDeps {
  readonly repository: PlanWorkoutDriftRepository;
  readonly plans: PlanRepository;
  readonly calendar: PlanMirrorCalendarPort;
  readonly identity: PlanWorkoutDriftIdentity;
  now(): number;
}

export class PlanWorkoutDriftError extends Error {
  readonly code:
    | "missing-drift"
    | "invalid-workout"
    | "invalid-provider-event"
    | "protected-workout"
    | "provider-failed"
    | "verification-failed";

  constructor(code: PlanWorkoutDriftError["code"], options?: ErrorOptions) {
    super(`plan workout drift failed: ${code}`, options);
    this.name = "PlanWorkoutDriftError";
    this.code = code;
  }
}

function structureDescription(value: string): string | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return typeof parsed.description === "string" ? parsed.description : null;
  } catch {
    return null;
  }
}

export function planWorkoutDriftSnapshot(workout: PlanWorkoutRecord): PlanWorkoutDriftSnapshot {
  return Object.freeze({
    dateKey: workout.dateKey,
    name: workout.name,
    durationS: workout.durationS,
    description: structureDescription(workout.structureJson),
  });
}

export function providerWorkoutDriftSnapshot(event: PlanMirrorEvent): PlanWorkoutDriftSnapshot {
  if (
    !Number.isSafeInteger(event.id) ||
    event.id <= 0 ||
    !Number.isSafeInteger(event.dateKey) ||
    typeof event.name !== "string" ||
    event.name.length === 0 ||
    (event.durationS !== undefined &&
      event.durationS !== null &&
      (!Number.isSafeInteger(event.durationS) || event.durationS <= 0))
  ) {
    throw new PlanWorkoutDriftError("invalid-provider-event");
  }
  return Object.freeze({
    dateKey: event.dateKey,
    name: event.name,
    durationS: event.durationS ?? null,
    description: event.description ?? null,
  });
}

function snapshotJson(snapshot: PlanWorkoutDriftSnapshot): string {
  return canonicalJson(snapshot);
}

function comparableSnapshotJson(snapshot: PlanWorkoutDriftSnapshot): string {
  return snapshotJson(snapshot.description === null ? snapshot : { ...snapshot, durationS: null });
}

function revision(event: PlanMirrorEvent, snapshot: PlanWorkoutDriftSnapshot): string {
  return typeof event.updated === "string" && event.updated.length > 0
    ? event.updated
    : snapshotJson(snapshot);
}

function byExternalId(events: readonly PlanMirrorEvent[]): Map<string, PlanMirrorEvent> {
  const result = new Map<string, PlanMirrorEvent>();
  const duplicates = new Set<string>();
  for (const event of events) {
    if (event.externalId === null) continue;
    if (result.has(event.externalId)) duplicates.add(event.externalId);
    else result.set(event.externalId, event);
  }
  for (const value of duplicates) result.delete(value);
  return result;
}

export async function refreshPlanWorkoutDrifts(
  input: {
    readonly plan: PlanRecord;
    readonly workouts: readonly PlanWorkoutRecord[];
    readonly events: readonly PlanMirrorEvent[];
    readonly todayDateKey: number;
    readonly windowEndDateKey: number;
  },
  deps: Pick<PlanWorkoutDriftDeps, "repository" | "identity" | "now">,
): Promise<readonly PlanWorkoutDriftRecord[]> {
  if (input.plan.status !== "active") return [];
  const events = byExternalId(input.events);
  const existing = new Map(
    (await deps.repository.readOpenForPlan(input.plan.id)).map((drift) => [
      drift.planWorkoutId,
      drift,
    ]),
  );
  for (const workout of input.workouts) {
    if (
      workout.planId !== input.plan.id ||
      workout.origin !== "coach" ||
      workout.dateKey < input.todayDateKey ||
      workout.dateKey > input.windowEndDateKey
    )
      continue;
    const event = events.get(planMirrorExternalId(input.plan.id, workout.id));
    if (event === undefined) continue;
    const planned = planWorkoutDriftSnapshot(workout);
    const provider = providerWorkoutDriftSnapshot(event);
    if (comparableSnapshotJson(planned) === comparableSnapshotJson(provider)) continue;
    const now = deps.now();
    const stamp = deps.identity.stamp();
    const open = existing.get(workout.id);
    const drift = await deps.repository.observe({
      id: open?.id ?? deps.identity.newId(),
      planId: input.plan.id,
      planWorkoutId: workout.id,
      providerEventId: event.id,
      providerRevision: revision(event, provider),
      status: "detected",
      planSnapshotJson: snapshotJson(planned),
      providerSnapshotJson: snapshotJson(provider),
      detectedAtMs: open?.detectedAtMs ?? now,
      observedAtMs: now,
      resolvedAtMs: null,
      deviceId: await deps.identity.deviceId(),
      hlcPhysicalMs: stamp.physicalMs,
      hlcCounter: stamp.counter,
    });
    existing.set(workout.id, drift);
  }
  return deps.repository.readOpenForPlan(input.plan.id);
}

async function current(
  input: {
    readonly planId: string;
    readonly workoutId: string;
    readonly eventId: number;
  },
  deps: PlanWorkoutDriftDeps,
): Promise<{
  readonly plan: PlanRecord;
  readonly workout: PlanWorkoutRecord;
  readonly drift: PlanWorkoutDriftRecord;
  readonly event: PlanMirrorEvent;
}> {
  if (deps.calendar.readEvent === undefined) throw new PlanWorkoutDriftError("provider-failed");
  const [plan, workouts, drift] = await Promise.all([
    deps.plans.read(input.planId),
    deps.plans.readWorkouts(input.planId),
    deps.repository.readOpenForWorkout(input.workoutId),
  ]);
  const workout = workouts.find((candidate) => candidate.id === input.workoutId);
  if (plan?.status !== "active" || workout === undefined || drift === undefined) {
    throw new PlanWorkoutDriftError(drift === undefined ? "missing-drift" : "invalid-workout");
  }
  if (drift.providerEventId !== input.eventId) {
    throw new PlanWorkoutDriftError("invalid-provider-event");
  }
  let event: PlanMirrorEvent;
  try {
    event = await deps.calendar.readEvent({ eventId: input.eventId });
  } catch (error) {
    throw new PlanWorkoutDriftError("provider-failed", { cause: error });
  }
  if (
    event.id !== input.eventId ||
    event.externalId !== planMirrorExternalId(input.planId, input.workoutId)
  ) {
    throw new PlanWorkoutDriftError("invalid-provider-event");
  }
  const planned = planWorkoutDriftSnapshot(workout);
  const provider = providerWorkoutDriftSnapshot(event);
  if (
    drift.planSnapshotJson !== snapshotJson(planned) ||
    drift.providerRevision !== revision(event, provider) ||
    drift.providerSnapshotJson !== snapshotJson(provider)
  ) {
    const now = deps.now();
    const stamp = deps.identity.stamp();
    await deps.repository.observe({
      ...drift,
      providerEventId: event.id,
      providerRevision: revision(event, provider),
      planSnapshotJson: snapshotJson(planned),
      providerSnapshotJson: snapshotJson(provider),
      observedAtMs: now,
      deviceId: await deps.identity.deviceId(),
      hlcPhysicalMs: stamp.physicalMs,
      hlcCounter: stamp.counter,
    });
    throw new PlanWorkoutDriftError("invalid-provider-event");
  }
  return { plan, workout, drift, event };
}

function protectedEvent(
  plan: PlanRecord,
  workout: PlanWorkoutRecord,
  event: PlanMirrorEvent,
  todayDateKey: number,
): void {
  if (
    workout.origin !== "coach" ||
    event.category !== "WORKOUT" ||
    workout.dateKey < todayDateKey ||
    event.dateKey < todayDateKey ||
    planWeekIndex(plan, event.dateKey).kind !== "inside"
  ) {
    throw new PlanWorkoutDriftError("protected-workout");
  }
}

function mergedStructure(currentJson: string, provider: PlanWorkoutDriftSnapshot): string {
  let current: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(currentJson) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      current = parsed as Record<string, unknown>;
    }
  } catch {
    current = {};
  }
  const next = { ...current };
  if (
    provider.description !== (typeof current.description === "string" ? current.description : null)
  )
    delete next.workoutDoc;
  if (provider.description === null) delete next.description;
  else next.description = provider.description;
  return canonicalJson(next);
}

async function resolve(
  drift: PlanWorkoutDriftRecord,
  status: "adopted" | "restored",
  deps: PlanWorkoutDriftDeps,
): Promise<PlanWorkoutDriftRecord> {
  const stamp = deps.identity.stamp();
  return deps.repository.resolve({
    id: drift.id,
    status,
    resolvedAtMs: stamp.physicalMs,
    deviceId: await deps.identity.deviceId(),
    hlcPhysicalMs: stamp.physicalMs,
    hlcCounter: stamp.counter,
  });
}

export async function adoptProviderWorkoutEdit(
  input: {
    readonly planId: string;
    readonly workoutId: string;
    readonly eventId: number;
    readonly todayDateKey: number;
  },
  deps: PlanWorkoutDriftDeps,
): Promise<PlanWorkoutDriftRecord> {
  const value = await current(input, deps);
  protectedEvent(value.plan, value.workout, value.event, input.todayDateKey);
  const provider = providerWorkoutDriftSnapshot(value.event);
  const stamp = deps.identity.stamp();
  const deviceId = await deps.identity.deviceId();
  const adoptedWorkout: PlanWorkoutRecord = {
    ...value.workout,
    dateKey: provider.dateKey,
    name: provider.name,
    durationS: provider.durationS,
    structureJson: mergedStructure(value.workout.structureJson, provider),
    deviceId,
    hlcPhysicalMs: stamp.physicalMs,
    hlcCounter: stamp.counter,
  };
  return deps.repository.adopt({
    id: value.drift.id,
    expectedWorkout: value.workout,
    workout: adoptedWorkout,
    ledger: {
      id: deps.identity.newId(),
      planId: value.plan.id,
      targetWorkoutId: value.workout.id,
      operation: "update",
      kind: "drift-adopted",
      sourceId: value.drift.id,
      reversalOfId: null,
      label: "External edit adopted",
      beforeJson: encodePlanAdaptationWorkoutSnapshot(planAdaptationWorkoutSnapshot(value.workout)),
      afterJson: encodePlanAdaptationWorkoutSnapshot(planAdaptationWorkoutSnapshot(adoptedWorkout)),
      weekLoadBefore: null,
      weekLoadAfter: null,
      occurredAtMs: stamp.physicalMs,
      deviceId,
      hlcPhysicalMs: stamp.physicalMs,
      hlcCounter: stamp.counter,
    },
    resolvedAtMs: stamp.physicalMs,
    deviceId,
    hlcPhysicalMs: stamp.physicalMs,
    hlcCounter: stamp.counter,
  });
}

export async function restorePlanWorkout(
  input: {
    readonly planId: string;
    readonly workoutId: string;
    readonly eventId: number;
    readonly todayDateKey: number;
  },
  deps: PlanWorkoutDriftDeps,
): Promise<PlanWorkoutDriftRecord> {
  if (deps.calendar.updateEvent === undefined || deps.calendar.readEvent === undefined) {
    throw new PlanWorkoutDriftError("provider-failed");
  }
  const value = await current(input, deps);
  protectedEvent(value.plan, value.workout, value.event, input.todayDateKey);
  try {
    await deps.calendar.updateEvent({
      eventId: input.eventId,
      dateKey: value.workout.dateKey,
      name: value.workout.name,
      durationS: value.workout.durationS,
      structureJson: value.workout.structureJson,
    });
  } catch (error) {
    throw new PlanWorkoutDriftError("provider-failed", { cause: error });
  }
  let verified: PlanMirrorEvent;
  try {
    verified = await deps.calendar.readEvent({ eventId: input.eventId });
  } catch (error) {
    throw new PlanWorkoutDriftError("verification-failed", { cause: error });
  }
  if (
    verified.externalId !== planMirrorExternalId(input.planId, input.workoutId) ||
    comparableSnapshotJson(providerWorkoutDriftSnapshot(verified)) !==
      comparableSnapshotJson(planWorkoutDriftSnapshot(value.workout))
  ) {
    throw new PlanWorkoutDriftError("verification-failed");
  }
  return resolve(value.drift, "restored", deps);
}
