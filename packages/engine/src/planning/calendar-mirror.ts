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
  type IcuCopyDecision,
  type IcuCopyEffect,
  type IcuPlanSide,
  type IcuSighting,
} from "./icu-copy.js";
import {
  planMirrorExternalId,
  planMirrorExternalIdPrefix,
  type PlanMirrorEvent,
} from "./reconciler.js";
import { thisTrainingWeekAndNext, trainingWeek, trainingWeekOfDate } from "./training-week.js";
import { WEEK_DELIVERY_START, weekIsAllowed, type WeekDelivery } from "./week-delivery.js";

export type DescribeWorkout = (structureJson: string) => string | null;

export interface CalendarEventFields {
  readonly dateKey: number;
  readonly name: string;
  readonly sport: string;
  readonly durationS: number | null;
  readonly description: string | null;
}

export interface CalendarEventCreate extends CalendarEventFields {
  readonly planId: string;
  readonly planWorkoutId: string;
  readonly externalId: string;
}

export interface CalendarEventUpdate extends CalendarEventFields {
  readonly eventId: number;
}

export interface CalendarMirrorPort {
  listEvents(input: {
    readonly startDateKey: number;
    readonly endDateKey: number;
  }): Promise<readonly PlanMirrorEvent[]>;
  readEvent(input: { readonly eventId: number }): Promise<PlanMirrorEvent | null>;
  createEvent(input: CalendarEventCreate): Promise<PlanMirrorEvent>;
  updateEvent(input: CalendarEventUpdate): Promise<PlanMirrorEvent>;
  deleteEvent(input: { readonly eventId: number }): Promise<void>;
}

export interface CalendarMirrorDeps {
  readonly calendar: CalendarMirrorPort;
  readonly mirror: PlanCalendarMirrorRepository;
  readonly describe: DescribeWorkout;
  now(): number;
}

export interface CalendarMirrorInput {
  readonly plan: PlanRecord;
  readonly workouts: readonly PlanWorkoutRecord[];
  readonly todayDateKey: number;
  readonly firstEligibleDateKey: number;
}

export interface CalendarMirrorRun extends CalendarMirrorInput {
  readonly matchedWorkoutIds: ReadonlySet<string>;
}

export type CalendarMirrorResult =
  | { readonly kind: "waiting-for-first-approve" }
  | { readonly kind: "nothing-due" }
  | { readonly kind: "list-failed" }
  | {
      readonly kind: "ran";
      readonly written: number;
      readonly failures: readonly PlanIcuWriteErrorCode[];
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

export function icuEventType(sport: string): string {
  const normalized = sport.toLowerCase();
  if (normalized.includes("cycl") || normalized.includes("bike") || normalized.includes("ride")) {
    return "Ride";
  }
  if (normalized.includes("run")) return "Run";
  if (normalized.includes("swim")) return "Swim";
  return "Workout";
}

function shownText(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function describesSteps(description: string | null): boolean {
  return description !== null && /^\s*-\s/m.test(description);
}

const FINGERPRINT_FORMAT = "icu-2";

function currentFingerprintFormat(fingerprint: string): boolean {
  return fingerprint.startsWith(JSON.stringify([FINGERPRINT_FORMAT]).slice(0, -1));
}

export function icuEventFingerprint(event: PlanMirrorEvent): string {
  const description = shownText(event.description);
  return JSON.stringify([
    FINGERPRINT_FORMAT,
    event.dateKey,
    event.name ?? null,
    event.type ?? null,
    description,
    describesSteps(description) ? null : (event.durationS ?? null),
  ]);
}

export function icuFingerprintParts(
  fingerprint: string,
): { readonly name: string | null; readonly durationS: number | null } | null {
  if (!currentFingerprintFormat(fingerprint)) return null;
  try {
    const parts: unknown = JSON.parse(fingerprint);
    if (!Array.isArray(parts)) return null;
    const name: unknown = parts[2];
    const duration: unknown = parts[5];
    return {
      name: typeof name === "string" ? name : null,
      durationS: typeof duration === "number" ? duration : null,
    };
  } catch {
    return null;
  }
}

export function planWorkoutFingerprint(
  workout: PlanWorkoutRecord,
  describe: DescribeWorkout,
): string {
  return JSON.stringify([
    workout.dateKey,
    workout.name,
    workout.sport,
    workout.durationS,
    describe(workout.structureJson),
  ]);
}

function fieldsBesideText(planFingerprint: string): string | null {
  try {
    const parts: unknown = JSON.parse(planFingerprint);
    return Array.isArray(parts) && parts.length === 5 ? JSON.stringify(parts.slice(0, 4)) : null;
  } catch {
    return null;
  }
}

function onlyTextDiffers(sentFingerprint: string, planFingerprint: string): boolean {
  const sent = fieldsBesideText(sentFingerprint);
  return sent !== null && sent === fieldsBesideText(planFingerprint);
}

export function expectedIcuFingerprint(
  workout: PlanWorkoutRecord,
  describe: DescribeWorkout,
): string {
  const description = shownText(describe(workout.structureJson));
  return JSON.stringify([
    FINGERPRINT_FORMAT,
    workout.dateKey,
    workout.name,
    icuEventType(workout.sport),
    description,
    describesSteps(description) ? null : workout.durationS,
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

function rebaselined(copy: IcuCopy, sighting: IcuSighting): IcuCopy {
  if (copy.kind !== "on-icu" && copy.kind !== "moving-by-you") return copy;
  if (sighting.kind !== "present" || sighting.eventId !== copy.baseline.eventId) return copy;
  if (currentFingerprintFormat(copy.baseline.readBack.fingerprint)) return copy;
  return { ...copy, baseline: { ...copy.baseline, readBack: sighting.version } };
}

function tracked(copy: IcuCopy): boolean {
  return copy.kind === "on-icu" || copy.kind === "moving-by-you" || copy.kind === "changed-in-icu";
}

function eventFields(workout: PlanWorkoutRecord, describe: DescribeWorkout): CalendarEventFields {
  return {
    dateKey: workout.dateKey,
    name: workout.name,
    sport: workout.sport,
    durationS: workout.durationS,
    description: describe(workout.structureJson),
  };
}

function failed(copy: IcuCopy, errorCode: PlanIcuWriteErrorCode): AppliedIcuCopy {
  return { copy, lastWrite: { kind: "failed", errorCode }, wrote: "no-write" };
}

function settledWrite(stored: PlanIcuCopyRecord | undefined): PlanIcuLastWrite {
  return stored === undefined || stored.lastWrite.kind === "failed"
    ? { kind: "none" }
    : stored.lastWrite;
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
  switch (result.kind) {
    case "read-failed":
      return failed(copy, "calendar-read-failed");
    case "write-failed":
      return failed(copy, errorCode);
    case "changed":
      return {
        copy: icuCopyOnRun(copy, target.plan, result.current).copy,
        lastWrite: settledWrite(target.stored),
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
  const quiet: AppliedIcuCopy = {
    copy,
    lastWrite: settledWrite(target.stored),
    wrote: "no-write",
  };
  const workout = target.workout;
  switch (effect.kind) {
    case "none":
    case "adopt-into-plan":
    case "remove-from-plan":
      return quiet;
    case "create": {
      if (workout === undefined) return quiet;
      let created: PlanMirrorEvent;
      try {
        created = await deps.calendar.createEvent({
          ...eventFields(workout, deps.describe),
          planId,
          planWorkoutId: workout.id,
          externalId: planMirrorExternalId(planId, workout.id),
        });
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
      if (workout === undefined) return quiet;
      const result = await writeIfUnchanged({
        read: () => readIcuSighting(deps.calendar, effect.eventId),
        alreadyWritten: (current) =>
          current.kind === "present" &&
          current.version.fingerprint === expectedIcuFingerprint(workout, deps.describe),
        stillAsSeen: (current) =>
          current.kind === "present" && current.version.fingerprint === effect.expected.fingerprint,
        write: async () =>
          icuSighting(
            await deps.calendar.updateEvent({
              ...eventFields(workout, deps.describe),
              eventId: effect.eventId,
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
  describe: DescribeWorkout,
): readonly IcuCopyTarget[] {
  const result: IcuCopyTarget[] = [];
  const planned = new Set<string>();
  for (const workout of input.workouts) {
    if (workout.planId !== input.plan.id) continue;
    planned.add(workout.id);
    if (workout.origin !== "coach") continue;
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
        ? { kind: "send", planFingerprint: planWorkoutFingerprint(workout, describe) }
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

function heldForRide(
  input: CalendarMirrorRun,
  target: IcuCopyTarget,
  decided: IcuCopyDecision,
): IcuCopyEffect {
  return decided.effect.kind === "update" &&
    decided.copy.kind === "on-icu" &&
    target.plan.kind === "send" &&
    input.matchedWorkoutIds.has(target.planWorkoutId) &&
    onlyTextDiffers(decided.copy.baseline.planFingerprint, target.plan.planFingerprint)
    ? { kind: "none" }
    : decided.effect;
}

export async function mirrorPlanCalendar(
  input: CalendarMirrorRun,
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
  const failures: PlanIcuWriteErrorCode[] = [];
  let changedInIcu = 0;
  for (const target of targets(input, delivery, setting, copies, window, deps.describe)) {
    const sighting = await sightingFor(deps, target, listed);
    let applied: AppliedIcuCopy;
    if (sighting === "read-failed") {
      applied = failed(target.copy, "calendar-read-failed");
    } else {
      const decided = icuCopyOnRun(rebaselined(target.copy, sighting), target.plan, sighting);
      applied = await applyIcuCopyEffect(
        deps,
        input.plan.id,
        target,
        decided.copy,
        heldForRide(input, target, decided),
      );
    }
    if (applied.wrote === "wrote") written += 1;
    if (applied.lastWrite.kind === "failed") failures.push(applied.lastWrite.errorCode);
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
  return { kind: "ran", written, failures, changedInIcu };
}

export async function observeIcuCopies(
  input: {
    readonly planId: string;
    readonly workouts: readonly PlanWorkoutRecord[];
    readonly startDateKey: number;
    readonly endDateKey: number;
  },
  deps: CalendarMirrorDeps,
): Promise<
  | { readonly kind: "observed"; readonly changed: number }
  | { readonly kind: "nothing-tracked" }
  | { readonly kind: "list-failed" }
> {
  const workouts = new Map(input.workouts.map((workout) => [workout.id, workout]));
  const watched: (IcuCopyTarget & { readonly stored: PlanIcuCopyRecord })[] = [];
  for (const [planWorkoutId, stored] of await readIcuCopies(deps.mirror, input.planId)) {
    const copy = storedIcuCopy(stored);
    const workout = workouts.get(planWorkoutId);
    if (
      workout === undefined ||
      (copy.kind !== "on-icu" && copy.kind !== "moving-by-you" && copy.kind !== "changed-in-icu") ||
      copy.baseline.dateKey < input.startDateKey ||
      copy.baseline.dateKey > input.endDateKey
    ) {
      continue;
    }
    watched.push({
      planWorkoutId,
      workout,
      stored,
      copy,
      plan: { kind: "send", planFingerprint: planWorkoutFingerprint(workout, deps.describe) },
    });
  }
  if (watched.length === 0) return { kind: "nothing-tracked" };
  let listed: ReadonlyMap<string, readonly PlanMirrorEvent[]>;
  try {
    listed = groupedByWorkout(
      input.planId,
      await deps.calendar.listEvents({
        startDateKey: input.startDateKey,
        endDateKey: input.endDateKey,
      }),
    );
  } catch {
    return { kind: "list-failed" };
  }
  let changed = 0;
  for (const target of watched) {
    const sighting = await sightingFor(deps, target, listed);
    if (sighting === "read-failed") continue;
    const decided = icuCopyOnRun(rebaselined(target.copy, sighting), target.plan, sighting);
    if (decided.effect.kind !== "none") continue;
    if (decided.copy.kind !== target.copy.kind) changed += 1;
    await saveIcuCopy(deps, {
      planId: input.planId,
      planWorkoutId: target.planWorkoutId,
      fallbackDateKey: target.stored.dateKey,
      stored: target.stored,
      copy: decided.copy,
      lastWrite: target.stored.lastWrite,
    });
  }
  return { kind: "observed", changed };
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
