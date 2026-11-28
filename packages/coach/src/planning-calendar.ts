import type { EventInput, IntervalsClient } from "intervals-icu-api";
import type {
  PlanMirrorCalendarPort,
  PlanMirrorEvent,
  PlanMirrorUpdateInput,
} from "@enduragent/engine";
import {
  icuEventType,
  type CalendarEventCreate,
  type CalendarEventUpdate,
  type CalendarMirrorPort,
} from "@enduragent/engine/calendar";

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

function storedDescription(structureJson: string): string | null {
  try {
    const value = JSON.parse(structureJson) as Record<string, unknown>;
    return typeof value.description === "string" ? value.description : null;
  } catch {
    return null;
  }
}

function mappedEvent(event: {
  readonly id: number;
  readonly startDateLocal: string;
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
    externalId: typeof event.externalId === "string" ? event.externalId : null,
    ...(event.category === undefined ? {} : { category: event.category }),
    ...(event.name === undefined ? {} : { name: event.name }),
    ...(event.movingTime === undefined ? {} : { durationS: event.movingTime }),
    ...(event.description === undefined ? {} : { description: event.description }),
    ...(typeof event.type === "string" ? { type: event.type } : {}),
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

function eventBody(input: {
  readonly dateKey: number;
  readonly name: string;
  readonly durationS: number | null;
}): EventInput {
  return {
    startDateLocal: `${dateText(input.dateKey)}T00:00:00`,
    category: "WORKOUT",
    name: input.name,
    ...(input.durationS === null ? {} : { movingTime: input.durationS }),
  };
}

function described(description: string | null): Pick<EventInput, "description"> {
  return description === null ? {} : { description };
}

function updateBody(input: PlanMirrorUpdateInput): EventInput {
  return { ...eventBody(input), ...described(storedDescription(input.structureJson)) };
}

function mirrorUpdateBody(input: CalendarEventUpdate): EventInput {
  return {
    ...eventBody(input),
    type: icuEventType(input.sport),
    description: input.description ?? "",
  };
}

function createBody(input: CalendarEventCreate): EventInput {
  return {
    ...eventBody(input),
    type: icuEventType(input.sport),
    externalId: input.externalId,
    ...described(input.description),
  };
}

function missing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "kind" in error &&
    (error.kind === "NotFound" || ("status" in error && error.status === 404))
  );
}

export function createCalendarMirrorAdapter(
  readClient: () => IntervalsClient | null,
): CalendarMirrorPort {
  const requiredClient = (): IntervalsClient => {
    const client = readClient();
    if (client === null) throw new Error("Intervals credentials are required.");
    return client;
  };
  const adapter: CalendarMirrorPort = {
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
    async readEvent(input) {
      const result = await requiredClient().events.get(input.eventId);
      if (!result.ok && missing(result.error)) return null;
      return mappedEvent(clientValue(result));
    },
    async createEvent(input) {
      return mappedEvent(clientValue(await requiredClient().events.create(createBody(input))));
    },
    async updateEvent(input) {
      return mappedEvent(
        clientValue(await requiredClient().events.update(input.eventId, mirrorUpdateBody(input))),
      );
    },
    async deleteEvent(input) {
      clientValue(await requiredClient().events.delete(input.eventId));
    },
  };
  return Object.freeze(adapter);
}

export interface PlanMirrorCalendarAdapter extends PlanMirrorCalendarPort {
  readonly mirror: CalendarMirrorPort;
}

export function createPlanMirrorCalendarAdapter(
  readClient: () => IntervalsClient | null,
): PlanMirrorCalendarAdapter {
  const requiredClient = (): IntervalsClient => {
    const client = readClient();
    if (client === null) throw new Error("Intervals credentials are required.");
    return client;
  };
  const adapter: PlanMirrorCalendarAdapter = {
    mirror: createCalendarMirrorAdapter(readClient),
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
          createBody({ ...input, description: storedDescription(input.structureJson) }),
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
