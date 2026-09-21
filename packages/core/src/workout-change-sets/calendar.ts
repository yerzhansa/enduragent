import { z } from "zod";
import { COACH_EVENT_TAG, isCoachOwnedEvent, todayInTZ } from "@enduragent/engine/sport";
import type { EventInput, Result } from "intervals-icu-api";
import { dateSchema, type Change, type Snapshot } from "./record.js";
import { WorkoutChangeError } from "./error.js";

export interface CalendarClient {
  readonly athlete: { get(): Promise<Result<unknown>> };
  readonly events: {
    get(id: number): Promise<Result<unknown>>;
    list(input: { oldest: string; newest: string }): Promise<Result<unknown>>;
    create(input: EventInput): Promise<Result<unknown>>;
    update(id: number, input: EventInput): Promise<Result<unknown>>;
    delete(id: number): Promise<Result<unknown>>;
  };
}
const eventSchema = z.object({
  id: z.number().int(),
  startDateLocal: z.string(),
  category: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  movingTime: z.number().nullable().optional(),
  description: z.string().nullable().optional(),
  icuTrainingLoad: z.number().nullable().optional(),
  workoutDoc: z.json().nullable().optional(),
  tags: z.array(z.string()).nullable().optional(),
  externalId: z.string().nullable().optional(),
});
export type CalendarEvent = z.infer<typeof eventSchema>;

export function normalizeJson(
  value: z.infer<ReturnType<typeof z.json>>,
): z.infer<ReturnType<typeof z.json>> {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalizeJson(value[key])]),
    );
  return typeof value === "string" ? value.replace(/\r\n/g, "\n") : value;
}
export function snapshot(event: CalendarEvent): Snapshot {
  dateSchema.parse(event.startDateLocal.slice(0, 10));
  return {
    eventId: event.id,
    date: event.startDateLocal.slice(0, 10),
    name: event.name ?? null,
    durationSeconds: event.movingTime ?? null,
    description: event.description?.replace(/\r\n/g, "\n") ?? null,
    trainingLoad: event.icuTrainingLoad ?? null,
    structure: normalizeJson(event.workoutDoc ?? null),
  };
}
export function sameSnapshot(left: Snapshot, right: Snapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
export function today(timezone: string): string {
  return todayInTZ(timezone);
}

export function eligible(event: CalendarEvent, currentDate: string): void {
  dateSchema.parse(event.startDateLocal.slice(0, 10));
  if (event.category !== "WORKOUT")
    throw new WorkoutChangeError("workoutOnly", "Only scheduled workouts can be changed.");
  if (!isCoachOwnedEvent(event))
    throw new WorkoutChangeError("coachOnly", "Only coach-created workouts can be changed.");
  if (event.startDateLocal.slice(0, 10) < currentDate)
    throw new WorkoutChangeError("pastProtected", "Past workouts are protected.");
}
export async function accountIdentity(client: CalendarClient): Promise<string> {
  const response = await client.athlete.get();
  if (!response.ok)
    throw new WorkoutChangeError("cannotVerify", "The calendar account cannot be verified.");
  return z
    .object({ id: z.union([z.string().min(1), z.number().int()]) })
    .parse(response.value)
    .id.toString();
}
export async function readEvent(client: CalendarClient, id: number): Promise<CalendarEvent> {
  const response = await client.events.get(id);
  if (!response.ok) throw new Error("The workout cannot be verified in intervals.icu.");
  const event = eventSchema.parse(response.value);
  if (event.id !== id) throw new Error("The calendar returned another workout.");
  return event;
}
export async function readDay(client: CalendarClient, date: string): Promise<CalendarEvent[]> {
  const response = await client.events.list({ oldest: date, newest: date });
  if (!response.ok) throw new Error("The calendar date cannot be verified in intervals.icu.");
  return z.array(eventSchema).parse(response.value);
}
export function desired(change: Extract<Change, { kind: "edit" }>, current: Snapshot): Snapshot {
  const patch = change.patch;
  const description =
    patch.description === undefined
      ? current.description
      : patch.description.replace(/\r\n/g, "\n");
  return {
    ...current,
    ...patch,
    structure:
      patch.structure === undefined
        ? description === current.description
          ? current.structure
          : null
        : normalizeJson(patch.structure),
    description,
  };
}
function structureInput(value: Snapshot["structure"]): {
  workoutDoc?: NonNullable<EventInput["workoutDoc"]>;
} {
  if (value === null) return {};
  const validated = z.record(z.string(), z.json()).parse(value);
  return { workoutDoc: validated as NonNullable<EventInput["workoutDoc"]> };
}
export function creationInput(change: Extract<Change, { kind: "add" }>): EventInput {
  const value = change.prepared;
  return {
    startDateLocal: `${value.date}T00:00:00`,
    category: "WORKOUT",
    name: value.name,
    type: value.sport === "cycling" ? "Ride" : "WeightTraining",
    movingTime: value.durationSeconds,
    description: value.description,
    ...(value.trainingLoad === null ? {} : { icuTrainingLoad: value.trainingLoad }),
    ...structureInput(value.structure),
    tags: [COACH_EVENT_TAG],
    externalId: change.recoveryIdentity,
  };
}
export function updateInput(change: Extract<Change, { kind: "edit" }>): EventInput {
  const patch = change.patch;
  return {
    ...(patch.date === undefined ? {} : { startDateLocal: `${patch.date}T00:00:00` }),
    ...(patch.name === undefined ? {} : { name: patch.name }),
    ...(patch.durationSeconds === undefined ? {} : { movingTime: patch.durationSeconds }),
    ...(patch.description === undefined ? {} : { description: patch.description }),
    ...(patch.trainingLoad === undefined ? {} : { icuTrainingLoad: patch.trainingLoad }),
    ...(patch.structure === undefined ? {} : structureInput(patch.structure)),
  };
}
export type WriteResult =
  | { kind: "confirmed"; eventId: number | null }
  | { kind: "rejected" }
  | { kind: "uncertain" };
export async function write(client: CalendarClient, change: Change): Promise<WriteResult> {
  try {
    const response =
      change.kind === "add"
        ? await client.events.create(creationInput(change))
        : change.kind === "edit"
          ? await client.events.update(change.reviewed.eventId, updateInput(change))
          : await client.events.delete(change.reviewed.eventId);
    if (!response.ok) {
      const error = response.error;
      return {
        kind:
          error.kind === "Unauthorized" ||
          error.kind === "Forbidden" ||
          error.kind === "RateLimit" ||
          error.kind === "NotFound" ||
          (error.kind === "Http" && error.status === 400)
            ? "rejected"
            : "uncertain",
      };
    }
    if (change.kind === "delete") return { kind: "confirmed", eventId: change.reviewed.eventId };
    const parsed = z.object({ id: z.number().int() }).safeParse(response.value);
    if (!parsed.success || (change.kind === "edit" && parsed.data.id !== change.reviewed.eventId))
      return { kind: "uncertain" };
    return { kind: "confirmed", eventId: parsed.data.id };
  } catch {
    return { kind: "uncertain" };
  }
}
