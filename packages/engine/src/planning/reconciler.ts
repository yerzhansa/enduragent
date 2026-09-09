import { canonicalJson } from "@enduragent/kernel/archive";
import {
  addCivilDays,
  type PlanRecord,
  type PlanReconciliationErrorCode,
  type PlanReconciliationItemRecord,
  type PlanReconciliationJobRecord,
  type PlanReconciliationRepository,
  type PlanWorkoutRecord,
} from "@enduragent/kernel/planning";

export const PLAN_MIRROR_DAYS = 7 as const;
export const PLAN_MIRROR_EXTERNAL_ID_PREFIX = "cycling-coach:plan:";
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export interface PlanMirrorEvent {
  readonly id: number;
  readonly dateKey: number;
  readonly externalId: string | null;
  readonly category?: string | null;
  readonly name?: string | null;
  readonly durationS?: number | null;
  readonly description?: string | null;
  readonly workoutDoc?: Readonly<Record<string, unknown>> | null;
  readonly updated?: string | null;
}

export interface PlanMirrorUpdateInput {
  readonly eventId: number;
  readonly dateKey: number;
  readonly name: string;
  readonly durationS: number | null;
  readonly structureJson: string;
}

export interface PlanMirrorCreateInput {
  readonly planId: string;
  readonly planWorkoutId: string;
  readonly dateKey: number;
  readonly externalId: string;
  readonly name: string;
  readonly sport: string;
  readonly durationS: number | null;
  readonly structureJson: string;
}

export interface PlanMirrorCalendarPort {
  listEvents(input: {
    readonly startDateKey: number;
    readonly endDateKey: number;
  }): Promise<readonly PlanMirrorEvent[]>;
  createEvent(input: PlanMirrorCreateInput): Promise<unknown>;
  deleteEvent(input: { readonly eventId: number }): Promise<unknown>;
  readEvent?(input: { readonly eventId: number }): Promise<PlanMirrorEvent>;
  updateEvent(input: PlanMirrorUpdateInput): Promise<unknown>;
}

export interface PlanReconcilerIdentity {
  newId(): string;
}

export interface PlanReconcilerDeps {
  readonly repository: PlanReconciliationRepository;
  readonly calendar: PlanMirrorCalendarPort;
  readonly identity: PlanReconcilerIdentity;
  now(): number;
}

export type PlanReconciliationDomainState =
  | "activation-local"
  | "reconcile-running"
  | "reconcile-failed"
  | "reconcile-retrying"
  | "reconcile-failed-again"
  | "reconcile-crash-resume"
  | "reconcile-verified";

export interface PlanReconciliationProjection {
  readonly job: PlanReconciliationJobRecord;
  readonly state: PlanReconciliationDomainState;
  readonly created: number;
  readonly pending: number;
  readonly failed: number;
  readonly total: number;
}

export class PlanReconciliationError extends Error {
  readonly code: "plan-not-active" | "invalid-workout" | "invalid-provider-event" | "missing-job";

  constructor(code: PlanReconciliationError["code"]) {
    super(`plan reconciliation failed: ${code}`);
    this.name = "PlanReconciliationError";
    this.code = code;
  }
}

export function planMirrorExternalId(planId: string, planWorkoutId: string): string {
  if (!ULID.test(planId) || !ULID.test(planWorkoutId)) {
    throw new PlanReconciliationError("invalid-workout");
  }
  return `${PLAN_MIRROR_EXTERNAL_ID_PREFIX}${planId}:${planWorkoutId}`;
}

export function planMirrorExternalIdPrefix(planId: string): string {
  if (!ULID.test(planId)) throw new PlanReconciliationError("invalid-workout");
  return `${PLAN_MIRROR_EXTERNAL_ID_PREFIX}${planId}:`;
}

function groupedEvents(events: readonly PlanMirrorEvent[]): Map<string, PlanMirrorEvent[]> {
  const grouped = new Map<string, PlanMirrorEvent[]>();
  for (const event of events) {
    if (
      !Number.isSafeInteger(event.id) ||
      event.id <= 0 ||
      !Number.isSafeInteger(event.dateKey) ||
      (event.externalId !== null && typeof event.externalId !== "string")
    ) {
      throw new PlanReconciliationError("invalid-provider-event");
    }
    if (event.externalId === null) continue;
    const values = grouped.get(event.externalId) ?? [];
    values.push(event);
    grouped.set(event.externalId, values);
  }
  return grouped;
}

function itemError(
  operation: PlanReconciliationItemRecord["operation"],
): Exclude<PlanReconciliationErrorCode, "calendar-list-failed"> {
  return operation === "create" ? "calendar-create-failed" : "calendar-delete-failed";
}

function jobState(job: PlanReconciliationJobRecord): PlanReconciliationDomainState {
  if (job.status === "pending") return "activation-local";
  if (job.status === "verified") return "reconcile-verified";
  if (job.status === "running" || job.status === "retrying") {
    if (job.lastResumedAttempt === job.attemptCount) return "reconcile-crash-resume";
    return job.status === "retrying" ? "reconcile-retrying" : "reconcile-running";
  }
  return job.failureCount > 1 ? "reconcile-failed-again" : "reconcile-failed";
}

export async function projectPlanReconciliation(
  repository: PlanReconciliationRepository,
  job: PlanReconciliationJobRecord,
): Promise<PlanReconciliationProjection> {
  const items = await repository.readItems(job.id);
  const created = items.filter(
    (item) => item.status === "created" || item.status === "verified",
  ).length;
  const failed = items.filter((item) => item.status === "failed").length;
  const pending = items.length - created - failed;
  return Object.freeze({
    job,
    state: jobState(job),
    created,
    pending,
    failed,
    total: items.length,
  });
}

async function failListedJob(
  deps: PlanReconcilerDeps,
  job: PlanReconciliationJobRecord,
): Promise<PlanReconciliationProjection> {
  const failed = await deps.repository.failJob(job.id, "calendar-list-failed", deps.now());
  return projectPlanReconciliation(deps.repository, failed);
}

async function finishJob(
  deps: PlanReconcilerDeps,
  job: PlanReconciliationJobRecord,
): Promise<PlanReconciliationProjection> {
  const items = await deps.repository.readItems(job.id);
  const failed = items.find((item) => item.status === "failed");
  if (failed !== undefined) {
    const failedJob = await deps.repository.failJob(
      job.id,
      failed.lastErrorCode ?? "calendar-verification-failed",
      deps.now(),
    );
    return projectPlanReconciliation(deps.repository, failedJob);
  }
  const verified = await deps.repository.verifyJob(job.id, deps.now());
  return projectPlanReconciliation(deps.repository, verified);
}

function mirrorExpected(workout: PlanWorkoutRecord): string {
  return JSON.stringify({
    dateKey: workout.dateKey,
    name: workout.name,
    sport: workout.sport,
    durationS: workout.durationS,
    structureJson: workout.structureJson,
  });
}

function eventMatchesExpected(expectedJson: string, event: PlanMirrorEvent): boolean {
  try {
    const expected = JSON.parse(expectedJson) as {
      readonly dateKey: number;
      readonly name: string;
      readonly durationS: number | null;
      readonly structureJson: string;
    };
    const structure = JSON.parse(expected.structureJson) as Record<string, unknown>;
    const expectedDescription =
      typeof structure.description === "string" ? structure.description : null;
    const expectedWorkoutDoc =
      structure.workoutDoc !== null &&
      typeof structure.workoutDoc === "object" &&
      !Array.isArray(structure.workoutDoc)
        ? structure.workoutDoc
        : null;
    return (
      event.dateKey === expected.dateKey &&
      (event.name === undefined || event.name === expected.name) &&
      (event.durationS === undefined || event.durationS === expected.durationS) &&
      (event.description === undefined || event.description === expectedDescription) &&
      (event.workoutDoc === undefined ||
        canonicalJson(event.workoutDoc) === canonicalJson(expectedWorkoutDoc))
    );
  } catch {
    return false;
  }
}

function eventHasCompleteMirrorFields(event: PlanMirrorEvent): boolean {
  return (
    event.name !== undefined &&
    event.durationS !== undefined &&
    event.description !== undefined &&
    event.workoutDoc !== undefined
  );
}

function canVerifyMirrorEvent(
  item: PlanReconciliationItemRecord,
  event: PlanMirrorEvent,
  previouslyVerifiedProviderEventId?: number,
): boolean {
  const providerIdentityWasVerified =
    (item.status === "verified" && item.providerEventId === event.id) ||
    previouslyVerifiedProviderEventId === event.id;
  return (
    eventMatchesExpected(item.expectedJson, event) &&
    (eventHasCompleteMirrorFields(event) ||
      item.status === "created" ||
      providerIdentityWasVerified)
  );
}

async function updateMirrorEvent(
  deps: PlanReconcilerDeps,
  item: PlanReconciliationItemRecord,
  event: PlanMirrorEvent,
  workout: PlanWorkoutRecord,
): Promise<void> {
  await deps.repository.startItem(item.id, deps.now());
  try {
    await deps.calendar.updateEvent({
      eventId: event.id,
      dateKey: workout.dateKey,
      name: workout.name,
      durationS: workout.durationS,
      structureJson: workout.structureJson,
    });
    await deps.repository.markItemCreated(item.id, deps.now());
  } catch {
    await deps.repository.failItem(item.id, "calendar-create-failed", deps.now());
  }
}

async function verifyMirrorItems(
  deps: PlanReconcilerDeps,
  job: PlanReconciliationJobRecord,
  grouped: ReadonlyMap<string, readonly PlanMirrorEvent[]>,
  firstEligibleDateKey = Number.NEGATIVE_INFINITY,
): Promise<void> {
  for (const item of await deps.repository.readItems(job.id)) {
    const matches = (grouped.get(item.externalId) ?? []).filter(
      (event) => item.operation !== "delete" || event.dateKey >= firstEligibleDateKey,
    );
    if (item.operation === "delete" && matches.length === 0) {
      await deps.repository.verifyItem(item.id, null, deps.now());
    } else if (
      item.operation === "create" &&
      matches.length === 1 &&
      canVerifyMirrorEvent(item, matches[0]!)
    ) {
      await deps.repository.verifyItem(item.id, matches[0]!.id, deps.now());
    } else {
      await deps.repository.failItem(item.id, "calendar-verification-failed", deps.now());
    }
  }
}

export async function reconcileActivePlanWindow(
  input: {
    readonly plan: PlanRecord;
    readonly workouts: readonly PlanWorkoutRecord[];
    readonly todayDateKey: number;
    readonly firstEligibleDateKey?: number;
  },
  deps: PlanReconcilerDeps,
): Promise<PlanReconciliationProjection> {
  if (input.plan.status !== "active") throw new PlanReconciliationError("plan-not-active");
  const windowEndDateKey = addCivilDays(input.todayDateKey, PLAN_MIRROR_DAYS - 1);
  const firstEligibleDateKey = Math.max(
    input.todayDateKey,
    input.firstEligibleDateKey ?? input.todayDateKey,
  );
  const now = deps.now();
  const job = await deps.repository.createOrGetJob({
    id: deps.identity.newId(),
    planId: input.plan.id,
    kind: "mirror",
    windowStartDateKey: input.todayDateKey,
    windowEndDateKey,
    createdAtMs: now,
  });
  const selected = input.workouts.filter((workout) => {
    if (workout.planId !== input.plan.id) throw new PlanReconciliationError("invalid-workout");
    return (
      workout.origin === "coach" &&
      workout.dateKey >= firstEligibleDateKey &&
      workout.dateKey <= windowEndDateKey
    );
  });
  for (const workout of selected) {
    const externalId = planMirrorExternalId(input.plan.id, workout.id);
    const expectedJson = mirrorExpected(workout);
    await deps.repository.prepareItem({
      id: deps.identity.newId(),
      jobId: job.id,
      planWorkoutId: workout.id,
      operation: "create",
      dateKey: workout.dateKey,
      externalId,
      expectedJson,
      createdAtMs: deps.now(),
    });
  }
  const running = await deps.repository.beginAttempt(job.id, deps.now());
  let before: Map<string, PlanMirrorEvent[]>;
  try {
    before = groupedEvents(
      await deps.calendar.listEvents({
        startDateKey: input.todayDateKey,
        endDateKey: windowEndDateKey,
      }),
    );
  } catch {
    return failListedJob(deps, running);
  }
  const selectedExternalIds = new Set(
    selected.map((workout) => planMirrorExternalId(input.plan.id, workout.id)),
  );
  const workoutById = new Map(input.workouts.map((workout) => [workout.id, workout]));
  const prefix = planMirrorExternalIdPrefix(input.plan.id);
  for (const [externalId, events] of before) {
    if (!externalId.startsWith(prefix) || selectedExternalIds.has(externalId)) continue;
    const eligible = events.filter((event) => event.dateKey >= firstEligibleDateKey);
    if (eligible.length === 0) continue;
    const workoutId = externalId.slice(prefix.length);
    if (!ULID.test(workoutId)) continue;
    const workout = workoutById.get(workoutId);
    if (workout !== undefined && workout.origin !== "coach") continue;
    await deps.repository.prepareItem({
      id: deps.identity.newId(),
      jobId: job.id,
      planWorkoutId: null,
      operation: "delete",
      dateKey: eligible[0]!.dateKey,
      externalId,
      expectedJson: JSON.stringify(eligible.map((event) => ({ eventId: event.id }))),
      createdAtMs: deps.now(),
    });
  }
  const selectedWorkoutById = new Map(selected.map((workout) => [workout.id, workout]));
  for (const item of await deps.repository.readItems(job.id)) {
    const matches = before.get(item.externalId) ?? [];
    if (item.operation === "delete") {
      if (selectedExternalIds.has(item.externalId)) {
        await deps.repository.deleteItem(item.id);
        continue;
      }
      const eligible = matches.filter((event) => event.dateKey >= firstEligibleDateKey);
      if (eligible.length === 0) {
        await deps.repository.verifyItem(item.id, null, deps.now());
        continue;
      }
      await deps.repository.startItem(item.id, deps.now());
      let failed = false;
      for (const event of eligible) {
        try {
          await deps.calendar.deleteEvent({ eventId: event.id });
        } catch {
          failed = true;
        }
      }
      if (failed) await deps.repository.failItem(item.id, "calendar-delete-failed", deps.now());
      continue;
    }
    const workout =
      item.planWorkoutId === null ? undefined : selectedWorkoutById.get(item.planWorkoutId);
    if (workout === undefined) {
      await deps.repository.deleteItem(item.id);
      continue;
    }
    if (matches.length > 1) {
      await deps.repository.failItem(item.id, "calendar-verification-failed", deps.now());
      continue;
    }
    if (matches.length === 1) {
      if (canVerifyMirrorEvent(item, matches[0]!)) {
        await deps.repository.verifyItem(item.id, matches[0]!.id, deps.now());
        continue;
      }
      await updateMirrorEvent(deps, item, matches[0]!, workout);
      continue;
    }
    let immediate: Map<string, PlanMirrorEvent[]>;
    try {
      immediate = groupedEvents(
        await deps.calendar.listEvents({
          startDateKey: item.dateKey,
          endDateKey: item.dateKey,
        }),
      );
    } catch {
      return failListedJob(deps, running);
    }
    const immediateMatches = immediate.get(item.externalId) ?? [];
    if (immediateMatches.length > 1) {
      await deps.repository.failItem(item.id, "calendar-verification-failed", deps.now());
      continue;
    }
    if (immediateMatches.length === 1) {
      if (canVerifyMirrorEvent(item, immediateMatches[0]!)) {
        await deps.repository.verifyItem(item.id, immediateMatches[0]!.id, deps.now());
        continue;
      }
      await updateMirrorEvent(deps, item, immediateMatches[0]!, workout);
      continue;
    }
    await deps.repository.startItem(item.id, deps.now());
    try {
      await deps.calendar.createEvent({
        planId: input.plan.id,
        planWorkoutId: workout.id,
        dateKey: workout.dateKey,
        externalId: item.externalId,
        name: workout.name,
        sport: workout.sport,
        durationS: workout.durationS,
        structureJson: workout.structureJson,
      });
    } catch {
      await deps.repository.failItem(item.id, itemError(item.operation), deps.now());
      continue;
    }
    await deps.repository.markItemCreated(item.id, deps.now());
  }
  let after: Map<string, PlanMirrorEvent[]>;
  try {
    after = groupedEvents(
      await deps.calendar.listEvents({
        startDateKey: input.todayDateKey,
        endDateKey: windowEndDateKey,
      }),
    );
  } catch {
    for (const item of await deps.repository.readItems(job.id)) {
      if (item.status === "running" || item.status === "created") {
        await deps.repository.failItem(item.id, "calendar-verification-failed", deps.now());
      }
    }
    return failListedJob(deps, running);
  }
  await verifyMirrorItems(deps, job, after, firstEligibleDateKey);
  return finishJob(deps, running);
}

export async function verifyPlanMirror(
  job: PlanReconciliationJobRecord,
  deps: PlanReconcilerDeps,
): Promise<PlanReconciliationProjection> {
  const stored = await deps.repository.readJob(job.id);
  if (stored === undefined || stored.kind !== "mirror") {
    throw new PlanReconciliationError("missing-job");
  }
  const running = await deps.repository.beginAttempt(stored.id, deps.now());
  let events: Map<string, PlanMirrorEvent[]>;
  try {
    events = groupedEvents(
      await deps.calendar.listEvents({
        startDateKey: running.windowStartDateKey,
        endDateKey: running.windowEndDateKey,
      }),
    );
  } catch {
    return failListedJob(deps, running);
  }
  await verifyMirrorItems(deps, running, events);
  return finishJob(deps, running);
}

function cleanupExpected(event: PlanMirrorEvent): string {
  return JSON.stringify({
    eventId: event.id,
    dateKey: event.dateKey,
    externalId: event.externalId,
  });
}

export async function cleanupPlanMirror(
  input: {
    readonly planId: string;
    readonly todayDateKey: number;
    readonly startDateKey?: number;
    readonly endDateKey: number;
  },
  deps: PlanReconcilerDeps,
): Promise<PlanReconciliationProjection> {
  const startDateKey = input.startDateKey ?? addCivilDays(input.todayDateKey, 1);
  const now = deps.now();
  const job = await deps.repository.createOrGetJob({
    id: deps.identity.newId(),
    planId: input.planId,
    kind: "cleanup",
    windowStartDateKey: startDateKey,
    windowEndDateKey: input.endDateKey,
    createdAtMs: now,
  });
  const running = await deps.repository.beginAttempt(job.id, deps.now());
  let before: Map<string, PlanMirrorEvent[]>;
  try {
    before = groupedEvents(
      await deps.calendar.listEvents({
        startDateKey,
        endDateKey: input.endDateKey,
      }),
    );
  } catch {
    return failListedJob(deps, running);
  }
  const prefix = planMirrorExternalIdPrefix(input.planId);
  const eligible = [...before.entries()].filter(
    ([externalId, events]) =>
      externalId.startsWith(prefix) &&
      events.some((event) => event.dateKey >= startDateKey && event.dateKey <= input.endDateKey),
  );
  for (const [externalId, events] of eligible) {
    const first = events[0]!;
    await deps.repository.prepareItem({
      id: deps.identity.newId(),
      jobId: job.id,
      planWorkoutId: null,
      operation: "delete",
      dateKey: first.dateKey,
      externalId,
      expectedJson: JSON.stringify(events.map((event) => JSON.parse(cleanupExpected(event)))),
      createdAtMs: deps.now(),
    });
  }
  for (const item of await deps.repository.readItems(job.id)) {
    const matches = before.get(item.externalId) ?? [];
    if (matches.length === 0) {
      await deps.repository.verifyItem(item.id, null, deps.now());
      continue;
    }
    await deps.repository.startItem(item.id, deps.now());
    let failed = false;
    for (const event of matches) {
      try {
        await deps.calendar.deleteEvent({ eventId: event.id });
      } catch {
        failed = true;
      }
    }
    if (failed) await deps.repository.failItem(item.id, "calendar-delete-failed", deps.now());
  }
  let after: Map<string, PlanMirrorEvent[]>;
  try {
    after = groupedEvents(
      await deps.calendar.listEvents({
        startDateKey,
        endDateKey: input.endDateKey,
      }),
    );
  } catch {
    for (const item of await deps.repository.readItems(job.id)) {
      if (item.status === "running") {
        await deps.repository.failItem(item.id, "calendar-verification-failed", deps.now());
      }
    }
    return failListedJob(deps, running);
  }
  for (const item of await deps.repository.readItems(job.id)) {
    const remaining = after.get(item.externalId) ?? [];
    if (remaining.length === 0) {
      await deps.repository.verifyItem(item.id, null, deps.now());
    } else {
      await deps.repository.failItem(item.id, "calendar-verification-failed", deps.now());
    }
  }
  return finishJob(deps, running);
}

export async function verifyPlanCleanup(
  job: PlanReconciliationJobRecord,
  deps: PlanReconcilerDeps,
): Promise<PlanReconciliationProjection> {
  const stored = await deps.repository.readJob(job.id);
  if (stored === undefined || stored.kind !== "cleanup") {
    throw new PlanReconciliationError("missing-job");
  }
  const running = await deps.repository.beginAttempt(stored.id, deps.now());
  let events: Map<string, PlanMirrorEvent[]>;
  try {
    events = groupedEvents(
      await deps.calendar.listEvents({
        startDateKey: running.windowStartDateKey,
        endDateKey: running.windowEndDateKey,
      }),
    );
  } catch {
    return failListedJob(deps, running);
  }
  const prefix = planMirrorExternalIdPrefix(running.planId);
  for (const [externalId, matches] of events) {
    if (!externalId.startsWith(prefix) || matches.length === 0) continue;
    const first = matches[0]!;
    await deps.repository.prepareItem({
      id: deps.identity.newId(),
      jobId: running.id,
      planWorkoutId: null,
      operation: "delete",
      dateKey: first.dateKey,
      externalId,
      expectedJson: JSON.stringify(matches.map((event) => JSON.parse(cleanupExpected(event)))),
      createdAtMs: deps.now(),
    });
  }
  for (const item of await deps.repository.readItems(running.id)) {
    if ((events.get(item.externalId) ?? []).length === 0) {
      await deps.repository.verifyItem(item.id, null, deps.now());
    } else {
      await deps.repository.failItem(item.id, "calendar-verification-failed", deps.now());
    }
  }
  return finishJob(deps, running);
}
