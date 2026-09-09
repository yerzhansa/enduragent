import type { EventInput, IntervalsClient } from "intervals-icu-api";
import type {
  PlanMirrorCalendarPort,
  PlanMirrorEvent,
  PlanMirrorUpdateInput,
} from "@enduragent/engine";

function clientValue<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error("Intervals calendar request failed.", { cause: result.error });
  return result.value;
}

function dateText(dateKey: number): string {
  const value = String(dateKey).padStart(8, "0");
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function dateKey(value: string): number {
  const parsed = Number(value.slice(0, 10).replaceAll("-", ""));
  if (!Number.isSafeInteger(parsed)) throw new TypeError("Intervals returned an invalid date.");
  return parsed;
}

function eventType(sport: string): NonNullable<EventInput["type"]> {
  const normalized = sport.toLowerCase();
  if (normalized.includes("cycl") || normalized.includes("bike") || normalized.includes("ride"))
    return "Ride";
  if (normalized.includes("run")) return "Run";
  if (normalized.includes("swim")) return "Swim";
  return "Workout";
}

function eventContent(structureJson: string): Pick<EventInput, "description" | "workoutDoc"> {
  try {
    const value = JSON.parse(structureJson) as Record<string, unknown>;
    return {
      ...(typeof value.description === "string" ? { description: value.description } : {}),
      ...(typeof value.workoutDoc === "object" && value.workoutDoc !== null
        ? { workoutDoc: value.workoutDoc as NonNullable<EventInput["workoutDoc"]> }
        : {}),
    };
  } catch {
    return {};
  }
}

function mappedEvent(event: {
  readonly id: number;
  readonly startDateLocal: string;
  readonly uid?: string | null;
  readonly category?: string | null;
  readonly name?: string | null;
  readonly movingTime?: number | null;
  readonly description?: string | null;
  readonly workoutDoc?: unknown;
  readonly [key: string]: unknown;
}): PlanMirrorEvent {
  return {
    id: event.id,
    dateKey: dateKey(event.startDateLocal),
    externalId: event.uid ?? null,
    ...(event.category === undefined ? {} : { category: event.category }),
    ...(event.name === undefined ? {} : { name: event.name }),
    ...(event.movingTime === undefined ? {} : { durationS: event.movingTime }),
    ...(event.description === undefined ? {} : { description: event.description }),
    ...(event.workoutDoc === undefined
      ? {}
      : {
          workoutDoc:
            event.workoutDoc !== null &&
            typeof event.workoutDoc === "object" &&
            !Array.isArray(event.workoutDoc)
              ? (event.workoutDoc as Readonly<Record<string, unknown>>)
              : null,
        }),
    ...(typeof event.updated === "string" ? { updated: event.updated } : {}),
  };
}

function updateBody(input: PlanMirrorUpdateInput): EventInput {
  return {
    startDateLocal: `${dateText(input.dateKey)}T00:00:00`,
    category: "WORKOUT",
    name: input.name,
    ...(input.durationS === null ? {} : { movingTime: input.durationS }),
    ...eventContent(input.structureJson),
  };
}

export function createPlanMirrorCalendarAdapter(
  readClient: () => IntervalsClient | null,
): PlanMirrorCalendarPort {
  const requiredClient = (): IntervalsClient => {
    const client = readClient();
    if (client === null) throw new Error("Intervals credentials are required.");
    return client;
  };
  const adapter: PlanMirrorCalendarPort = {
    async listEvents(input) {
      const events = clientValue(
        await requiredClient().events.list({
          oldest: dateText(input.startDateKey),
          newest: dateText(input.endDateKey),
          category: ["WORKOUT"],
        }),
      );
      return events.map((event) => mappedEvent(event));
    },
    async createEvent(input) {
      return clientValue(
        await requiredClient().events.create(
          {
            startDateLocal: `${dateText(input.dateKey)}T00:00:00`,
            category: "WORKOUT",
            name: input.name,
            type: eventType(input.sport),
            uid: input.externalId,
            ...(input.durationS === null ? {} : { movingTime: input.durationS }),
            ...eventContent(input.structureJson),
          },
          { upsertOnUid: true },
        ),
      );
    },
    async deleteEvent(input) {
      return clientValue(await requiredClient().events.delete(input.eventId));
    },
    async readEvent(input) {
      return mappedEvent(clientValue(await requiredClient().events.get(input.eventId)));
    },
    async updateEvent(input) {
      return clientValue(await requiredClient().events.update(input.eventId, updateBody(input)));
    },
  };
  return Object.freeze(adapter);
}
