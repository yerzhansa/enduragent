import type {
  PlanCalendarMirrorRepository,
  PlanIcuCopyRecord,
  PlanIcuLastWrite,
  PlanIcuWriteErrorCode,
  PlanRecord,
  PlanWorkoutRecord,
} from "@enduragent/kernel/planning";
import {
  decodeIcuCopy,
  decodeWeekDelivery,
  encodeIcuCopy,
  encodeWeekDelivery,
} from "./calendar-codec.js";
import { writeIfUnchanged, type ConditionalWriteResult } from "./conditional-write.js";
import {
  icuCopyDeleted,
  icuCopyOnRun,
  icuCopyWritten,
  ICU_COPY_NOT_SENT,
  type IcuCopy,
  type IcuCopyEffect,
  type IcuPlanSide,
  type IcuSighting,
} from "./icu-copy.js";
import {
  planMirrorExternalId,
  planMirrorExternalIdPrefix,
  type PlanMirrorCreateInput,
  type PlanMirrorEvent,
  type PlanMirrorUpdateInput,
} from "./reconciler.js";
import { thisTrainingWeekAndNext, trainingWeek, trainingWeekOfDate } from "./training-week.js";
import { WEEK_DELIVERY_START, weekIsAllowed, type WeekDelivery } from "./week-delivery.js";

export interface CalendarMirrorPort {
  listEvents(input: {
    readonly startDateKey: number;
    readonly endDateKey: number;
  }): Promise<readonly PlanMirrorEvent[]>;
  readEvent(input: { readonly eventId: number }): Promise<PlanMirrorEvent | null>;
  createEvent(input: PlanMirrorCreateInput): Promise<PlanMirrorEvent>;
  updateEvent(input: PlanMirrorUpdateInput): Promise<PlanMirrorEvent>;
  deleteEvent(input: { readonly eventId: number }): Promise<void>;
}

export interface CalendarMirrorDeps {
  readonly calendar: CalendarMirrorPort;
  readonly mirror: PlanCalendarMirrorRepository;
  now(): number;
}

export interface CalendarMirrorInput {
  readonly plan: PlanRecord;
  readonly workouts: readonly PlanWorkoutRecord[];
  readonly todayDateKey: number;
  readonly firstEligibleDateKey: number;
}

export type CalendarMirrorResult =
  | { readonly kind: "waiting-for-first-approve" }
  | { readonly kind: "nothing-due" }
  | { readonly kind: "list-failed" }
  | {
      readonly kind: "ran";
      readonly written: number;
      readonly failed: number;
      readonly changedInIcu: number;
    };

interface Window {
  readonly startDateKey: number;
  readonly endDateKey: number;
}

export interface IcuCopyTarget {
  readonly planWorkoutId: string;
  readonly workout: PlanWorkoutRecord | undefined;
  readonly stored: PlanIcuCopyRecord | undefined;
  readonly copy: IcuCopy;
  readonly plan: IcuPlanSide;
}

export interface AppliedIcuCopy {
  readonly copy: IcuCopy;
  readonly lastWrite: PlanIcuLastWrite;
  readonly wrote: "wrote" | "no-write";
}

function descriptionOf(structureJson: string): string | null {
  try {
    const value: unknown = JSON.parse(structureJson);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const description = Object.fromEntries(Object.entries(value)).description;
    return typeof description === "string" ? description : null;
  } catch {
    return null;
  }
}

export function icuEventFingerprint(event: PlanMirrorEvent): string {
  const description = event.description ?? null;
  return JSON.stringify([
    event.dateKey,
    event.name ?? null,
    description,
    description === null ? (event.durationS ?? null) : null,
  ]);
}

export function planWorkoutFingerprint(workout: PlanWorkoutRecord): string {
  return JSON.stringify([
    workout.dateKey,
    workout.name,
    workout.sport,
    workout.durationS,
    descriptionOf(workout.structureJson),
  ]);
}

export function expectedIcuFingerprint(workout: PlanWorkoutRecord): string {
  const description = descriptionOf(workout.structureJson);
  return JSON.stringify([
    workout.dateKey,
    workout.name,
    description,
    description === null ? workout.durationS : null,
  ]);
}

export function icuSighting(event: PlanMirrorEvent | null | undefined): IcuSighting {
  if (event === null || event === undefined) return { kind: "absent" };
  return {
    kind: "present",
    eventId: event.id,
    dateKey: event.dateKey,
    version: { fingerprint: icuEventFingerprint(event), updated: event.updated ?? "" },
  };
}

export function copyEventDateKey(copy: IcuCopy): number | null {
  if (copy.kind === "on-icu" || copy.kind === "moving-by-you") return copy.baseline.dateKey;
  if (copy.kind === "changed-in-icu") {
    return copy.shown.kind === "present" ? copy.shown.dateKey : copy.baseline.dateKey;
  }
  return null;
}

export async function readWeekDelivery(
  mirror: PlanCalendarMirrorRepository,
  planId: string,
): Promise<WeekDelivery> {
  const record = await mirror.readDelivery(planId);
  return record === undefined ? WEEK_DELIVERY_START : decodeWeekDelivery(record.stateJson);
}

export async function saveWeekDelivery(
  mirror: PlanCalendarMirrorRepository,
  planId: string,
  delivery: WeekDelivery,
  nowMs: number,
): Promise<void> {
  const current = await mirror.readDelivery(planId);
  await mirror.writeDelivery({
    planId,
    stateKind: delivery.kind,
    stateJson: encodeWeekDelivery(delivery),
    closeChoiceJson: current?.closeChoiceJson ?? JSON.stringify({ kind: "keep-them" }),
    updatedAtMs: nowMs,
  });
}

export async function readIcuCopies(
  mirror: PlanCalendarMirrorRepository,
  planId: string,
): Promise<ReadonlyMap<string, PlanIcuCopyRecord>> {
  return new Map((await mirror.readCopies(planId)).map((record) => [record.planWorkoutId, record]));
}

export function storedIcuCopy(record: PlanIcuCopyRecord | undefined): IcuCopy {
  return record === undefined ? ICU_COPY_NOT_SENT : decodeIcuCopy(record.stateJson);
}

function tracked(copy: IcuCopy): boolean {
  return copy.kind === "on-icu" || copy.kind === "moving-by-you" || copy.kind === "changed-in-icu";
}

function createInput(planId: string, workout: PlanWorkoutRecord): PlanMirrorCreateInput {
  return {
    planId,
    planWorkoutId: workout.id,
    dateKey: workout.dateKey,
    externalId: planMirrorExternalId(planId, workout.id),
    name: workout.name,
    sport: workout.sport,
    durationS: workout.durationS,
    structureJson: workout.structureJson,
  };
}

function failed(copy: IcuCopy, errorCode: PlanIcuWriteErrorCode): AppliedIcuCopy {
  return { copy, lastWrite: { kind: "failed", errorCode }, wrote: "no-write" };
}

async function readBack(deps: CalendarMirrorDeps, reply: IcuSighting): Promise<IcuSighting> {
  if (reply.kind !== "present") return reply;
  try {
    const stored = icuSighting(await deps.calendar.readEvent({ eventId: reply.eventId }));
    return stored.kind === "present" ? stored : reply;
  } catch {
    return reply;
  }
}

export async function readIcuSighting(
  calendar: CalendarMirrorPort,
  eventId: number,
): Promise<IcuSighting> {
  return icuSighting(await calendar.readEvent({ eventId }));
}

async function settle(
  deps: CalendarMirrorDeps,
  target: IcuCopyTarget,
  copy: IcuCopy,
  result: ConditionalWriteResult<IcuSighting, IcuSighting>,
  errorCode: PlanIcuWriteErrorCode,
): Promise<AppliedIcuCopy> {
  const keepWrite = target.stored?.lastWrite ?? { kind: "none" };
  switch (result.kind) {
    case "read-failed":
      return failed(copy, "calendar-read-failed");
    case "write-failed":
      return failed(copy, errorCode);
    case "changed":
      return {
        copy: icuCopyOnRun(copy, target.plan, result.current).copy,
        lastWrite: keepWrite,
        wrote: "no-write",
      };
    case "unchanged":
      if (result.current.kind === "absent") {
        return { copy: icuCopyDeleted(copy), lastWrite: { kind: "ok" }, wrote: "no-write" };
      }
      return {
        copy: icuCopyWritten(copy, {
          eventId: result.current.eventId,
          dateKey: result.current.dateKey,
          planFingerprint: target.plan.kind === "send" ? target.plan.planFingerprint : "",
          readBack: result.current.version,
        }),
        lastWrite: { kind: "ok" },
        wrote: "no-write",
      };
    case "written": {
      if (result.written.kind === "absent") {
        return { copy: icuCopyDeleted(copy), lastWrite: { kind: "ok" }, wrote: "wrote" };
      }
      const stored = await readBack(deps, result.written);
      if (stored.kind !== "present") return failed(copy, "calendar-read-failed");
      return {
        copy: icuCopyWritten(copy, {
          eventId: stored.eventId,
          dateKey: stored.dateKey,
          planFingerprint: target.plan.kind === "send" ? target.plan.planFingerprint : "",
          readBack: stored.version,
        }),
        lastWrite: { kind: "ok" },
        wrote: "wrote",
      };
    }
  }
}

export async function applyIcuCopyEffect(
  deps: CalendarMirrorDeps,
  planId: string,
  target: IcuCopyTarget,
  copy: IcuCopy,
  effect: IcuCopyEffect,
): Promise<AppliedIcuCopy> {
  const keepWrite = target.stored?.lastWrite ?? { kind: "none" };
  const workout = target.workout;
  switch (effect.kind) {
    case "none":
    case "adopt-into-plan":
    case "remove-from-plan":
      return { copy, lastWrite: keepWrite, wrote: "no-write" };
    case "create": {
      if (workout === undefined) return { copy, lastWrite: keepWrite, wrote: "no-write" };
      let created: PlanMirrorEvent;
      try {
        created = await deps.calendar.createEvent(createInput(planId, workout));
      } catch {
        return failed(copy, "calendar-create-failed");
      }
      return settle(
        deps,
        target,
        copy,
        { kind: "written", written: icuSighting(created) },
        "calendar-create-failed",
      );
    }
    case "update": {
      if (workout === undefined) return { copy, lastWrite: keepWrite, wrote: "no-write" };
      const result = await writeIfUnchanged({
        read: () => readIcuSighting(deps.calendar, effect.eventId),
        alreadyWritten: (current) =>
          current.kind === "present" &&
          current.version.fingerprint === expectedIcuFingerprint(workout),
        stillAsSeen: (current) =>
          current.kind === "present" && current.version.fingerprint === effect.expected.fingerprint,
        write: async () =>
          icuSighting(
            await deps.calendar.updateEvent({
              eventId: effect.eventId,
              dateKey: workout.dateKey,
              name: workout.name,
              durationS: workout.durationS,
              structureJson: workout.structureJson,
            }),
          ),
      });
      return settle(deps, target, copy, result, "calendar-update-failed");
    }
    case "delete": {
      const result = await writeIfUnchanged({
        read: () => readIcuSighting(deps.calendar, effect.eventId),
        alreadyWritten: (current) => current.kind === "absent",
        stillAsSeen: (current) =>
          current.kind === "present" && current.version.fingerprint === effect.expected.fingerprint,
        write: async (): Promise<IcuSighting> => {
          await deps.calendar.deleteEvent({ eventId: effect.eventId });
          return { kind: "absent" };
        },
      });
      return settle(deps, target, copy, result, "calendar-delete-failed");
    }
  }
}

export function groupedByWorkout(
  planId: string,
  events: readonly PlanMirrorEvent[],
): ReadonlyMap<string, readonly PlanMirrorEvent[]> {
  const prefix = planMirrorExternalIdPrefix(planId);
  const byWorkout = new Map<string, PlanMirrorEvent[]>();
  for (const event of events) {
    if (event.externalId === null || !event.externalId.startsWith(prefix)) continue;
    const workoutId = event.externalId.slice(prefix.length);
    byWorkout.set(workoutId, [...(byWorkout.get(workoutId) ?? []), event]);
  }
  return byWorkout;
}

function pick(
  events: readonly PlanMirrorEvent[] | undefined,
  copy: IcuCopy,
): PlanMirrorEvent | undefined {
  if (events === undefined) return undefined;
  if (copy.kind === "on-icu" || copy.kind === "moving-by-you" || copy.kind === "changed-in-icu") {
    const known = events.find((event) => event.id === copy.baseline.eventId);
    if (known !== undefined) return known;
  }
  return events[0];
}

function targets(
  input: CalendarMirrorInput,
  delivery: WeekDelivery,
  setting: Parameters<typeof weekIsAllowed>[1],
  copies: ReadonlyMap<string, PlanIcuCopyRecord>,
  window: Window,
): readonly IcuCopyTarget[] {
  const result: IcuCopyTarget[] = [];
  const planned = new Set<string>();
  for (const workout of input.workouts) {
    if (workout.planId !== input.plan.id || workout.origin !== "coach") continue;
    planned.add(workout.id);
    const stored = copies.get(workout.id);
    const copy = storedIcuCopy(stored);
    if (copy.kind === "removed-by-you" || copy.kind === "kept-as-yours") continue;
    const week = trainingWeekOfDate(input.plan, workout.dateKey);
    const inWindow =
      workout.dateKey >= Math.max(window.startDateKey, input.firstEligibleDateKey) &&
      workout.dateKey <= window.endDateKey;
    const allowed = week !== null && weekIsAllowed(delivery, setting, week);
    const send = inWindow && (allowed || tracked(copy));
    const eventDate = copyEventDateKey(copy) ?? workout.dateKey;
    if (!send && (!tracked(copy) || eventDate < input.firstEligibleDateKey)) continue;
    result.push({
      planWorkoutId: workout.id,
      workout,
      stored,
      copy,
      plan: send
        ? { kind: "send", planFingerprint: planWorkoutFingerprint(workout) }
        : { kind: "withdraw", reason: "not-due" },
    });
  }
  for (const [planWorkoutId, stored] of copies) {
    if (planned.has(planWorkoutId)) continue;
    const copy = storedIcuCopy(stored);
    const eventDate = copyEventDateKey(copy);
    if (!tracked(copy) || eventDate === null || eventDate < input.firstEligibleDateKey) continue;
    result.push({
      planWorkoutId,
      workout: undefined,
      stored,
      copy,
      plan: { kind: "withdraw", reason: "not-in-plan" },
    });
  }
  return result;
}

async function sightingFor(
  deps: CalendarMirrorDeps,
  target: IcuCopyTarget,
  listed: ReadonlyMap<string, readonly PlanMirrorEvent[]>,
): Promise<IcuSighting | "read-failed"> {
  const seen = pick(listed.get(target.planWorkoutId), target.copy);
  if (seen !== undefined) return icuSighting(seen);
  if (
    target.copy.kind !== "on-icu" &&
    target.copy.kind !== "moving-by-you" &&
    target.copy.kind !== "changed-in-icu"
  ) {
    return { kind: "absent" };
  }
  try {
    return await readIcuSighting(deps.calendar, target.copy.baseline.eventId);
  } catch {
    return "read-failed";
  }
}

function changedRecord(stored: PlanIcuCopyRecord | undefined, record: PlanIcuCopyRecord): boolean {
  if (stored === undefined) {
    return record.stateKind !== "not-sent" || record.lastWrite.kind !== "none";
  }
  return (
    stored.stateJson !== record.stateJson ||
    stored.dateKey !== record.dateKey ||
    JSON.stringify(stored.lastWrite) !== JSON.stringify(record.lastWrite)
  );
}

export async function saveIcuCopy(
  deps: Pick<CalendarMirrorDeps, "mirror" | "now">,
  input: {
    readonly planId: string;
    readonly planWorkoutId: string;
    readonly fallbackDateKey: number;
    readonly stored: PlanIcuCopyRecord | undefined;
    readonly copy: IcuCopy;
    readonly lastWrite: PlanIcuLastWrite;
  },
): Promise<void> {
  const record: PlanIcuCopyRecord = {
    planId: input.planId,
    planWorkoutId: input.planWorkoutId,
    dateKey: copyEventDateKey(input.copy) ?? input.stored?.dateKey ?? input.fallbackDateKey,
    stateKind: input.copy.kind,
    stateJson: encodeIcuCopy(input.copy),
    lastWrite: input.lastWrite,
    updatedAtMs: deps.now(),
  };
  if (changedRecord(input.stored, record)) await deps.mirror.writeCopy(record);
}

export function dueWindow(input: CalendarMirrorInput): Window | null {
  const due = thisTrainingWeekAndNext(input.plan, input.todayDateKey);
  const first = due[0];
  const last = due.at(-1);
  if (first === undefined || last === undefined) return null;
  const window = {
    startDateKey: Math.max(
      input.firstEligibleDateKey,
      trainingWeek(input.plan, first).startDateKey,
    ),
    endDateKey: trainingWeek(input.plan, last).endDateKey,
  };
  return window.startDateKey > window.endDateKey ? null : window;
}

export async function mirrorPlanCalendar(
  input: CalendarMirrorInput,
  deps: CalendarMirrorDeps,
): Promise<CalendarMirrorResult> {
  const delivery = await readWeekDelivery(deps.mirror, input.plan.id);
  if (delivery.kind === "waiting-for-first-approve") return { kind: "waiting-for-first-approve" };
  const window = dueWindow(input);
  if (window === null) return { kind: "nothing-due" };
  const setting = await deps.mirror.readWeekDeliverySetting();
  const copies = await readIcuCopies(deps.mirror, input.plan.id);
  let listed: ReadonlyMap<string, readonly PlanMirrorEvent[]>;
  try {
    listed = groupedByWorkout(input.plan.id, await deps.calendar.listEvents(window));
  } catch {
    return { kind: "list-failed" };
  }
  let written = 0;
  let failures = 0;
  let changedInIcu = 0;
  for (const target of targets(input, delivery, setting, copies, window)) {
    const sighting = await sightingFor(deps, target, listed);
    let applied: AppliedIcuCopy;
    if (sighting === "read-failed") {
      applied = failed(target.copy, "calendar-read-failed");
    } else {
      const decided = icuCopyOnRun(target.copy, target.plan, sighting);
      applied = await applyIcuCopyEffect(deps, input.plan.id, target, decided.copy, decided.effect);
    }
    if (applied.wrote === "wrote") written += 1;
    if (applied.lastWrite.kind === "failed") failures += 1;
    if (applied.copy.kind === "changed-in-icu") changedInIcu += 1;
    await saveIcuCopy(deps, {
      planId: input.plan.id,
      planWorkoutId: target.planWorkoutId,
      fallbackDateKey: target.workout?.dateKey ?? window.startDateKey,
      stored: target.stored,
      copy: applied.copy,
      lastWrite: applied.lastWrite,
    });
  }
  return { kind: "ran", written, failed: failures, changedInIcu };
}

export async function sentTrainingWeeks(
  input: CalendarMirrorInput,
  mirror: PlanCalendarMirrorRepository,
): Promise<ReadonlySet<number>> {
  const copies = await readIcuCopies(mirror, input.plan.id);
  return new Set(
    thisTrainingWeekAndNext(input.plan, input.todayDateKey).filter((week) =>
      input.workouts.every(
        (workout) =>
          workout.origin !== "coach" ||
          workout.dateKey < input.firstEligibleDateKey ||
          trainingWeekOfDate(input.plan, workout.dateKey) !== week ||
          (copies.get(workout.id)?.stateKind ?? "not-sent") !== "not-sent",
      ),
    ),
  );
}
