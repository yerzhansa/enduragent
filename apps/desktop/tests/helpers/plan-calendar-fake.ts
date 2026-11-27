import type {
  PlanMirrorCalendarPort,
  PlanMirrorCreateInput,
  PlanMirrorEvent,
  PlanMirrorUpdateInput,
} from "@enduragent/engine";
import { icuEventType, type CalendarMirrorPort } from "@enduragent/engine/calendar";

const eventContent = (structureJson: string) => {
  const content: unknown = JSON.parse(structureJson);
  if (content === null || typeof content !== "object" || Array.isArray(content))
    throw new TypeError("Calendar Workout structure must be an object");
  return {
    description:
      "description" in content && typeof content.description === "string"
        ? content.description
        : null,
    workoutDoc:
      "workoutDoc" in content &&
      content.workoutDoc !== null &&
      typeof content.workoutDoc === "object" &&
      !Array.isArray(content.workoutDoc)
        ? Object.fromEntries(Object.entries(content.workoutDoc))
        : null,
  };
};

class MemoryPlanCalendar implements PlanMirrorCalendarPort {
  readonly events: PlanMirrorEvent[] = [];
  readonly creates: PlanMirrorCreateInput[] = [];
  readonly updates: PlanMirrorUpdateInput[] = [];
  readonly deletes: number[] = [];
  readonly lists: Array<{ readonly startDateKey: number; readonly endDateKey: number }> = [];
  failNextList = false;
  failNextCreate = false;
  refuseDeletes = false;
  failNextUpdate = false;
  delayMs = 0;
  nextEventId = 100;
  version = 0;
  beforeWrite: (() => void) | undefined;
  readonly mirror: CalendarMirrorPort = {
    listEvents: (input) => this.listEvents(input),
    readEvent: async ({ eventId }) => {
      await this.delay();
      return this.events.find((event) => event.id === eventId) ?? null;
    },
    createEvent: async (input) => {
      await this.createEvent(input);
      const created = this.events.at(-1);
      if (created === undefined) throw new Error("missing");
      return created;
    },
    updateEvent: async (input) => {
      await this.updateEvent(input);
      const updated = this.events.find((event) => event.id === input.eventId);
      if (updated === undefined) throw new Error("missing");
      return updated;
    },
    deleteEvent: async (input) => {
      await this.deleteEvent(input);
    },
  };

  editByAthlete(
    eventId: number,
    patch: Partial<Pick<PlanMirrorEvent, "dateKey" | "name" | "durationS" | "description">>,
  ) {
    const index = this.events.findIndex((event) => event.id === eventId);
    const event = this.events[index];
    if (event === undefined) throw new Error("missing");
    this.events[index] = { ...event, ...patch, updated: this.stamp() };
  }

  deleteByAthlete(eventId: number) {
    const index = this.events.findIndex((event) => event.id === eventId);
    if (index < 0) throw new Error("missing");
    this.events.splice(index, 1);
  }

  private stamp(): string {
    this.version += 1;
    return `1998-01-01T00:00:00.${String(this.version).padStart(3, "0")}+00:00`;
  }

  private stored(durationS: number | null, description: string | null): number | null {
    return description === null || durationS === null || !/^\s*-\s/m.test(description)
      ? durationS
      : durationS + 1;
  }

  async listEvents(input: { startDateKey: number; endDateKey: number }) {
    this.lists.push(input);
    await this.delay();
    if (this.failNextList) {
      this.failNextList = false;
      throw new Error("unavailable");
    }
    return this.events.filter(
      (event) => event.dateKey >= input.startDateKey && event.dateKey <= input.endDateKey,
    );
  }

  async createEvent(input: PlanMirrorCreateInput) {
    this.creates.push(input);
    await this.delay();
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new Error("unavailable");
    }
    this.beforeWrite?.();
    const content = eventContent(input.structureJson);
    this.events.push({
      id: this.nextEventId++,
      dateKey: input.dateKey,
      externalId: input.externalId,
      name: input.name,
      type: icuEventType(input.sport),
      ...content,
      durationS: this.stored(input.durationS, content.description),
      updated: this.stamp(),
    });
  }

  async updateEvent(input: PlanMirrorUpdateInput) {
    this.updates.push(input);
    await this.delay();
    this.beforeWrite?.();
    if (this.failNextUpdate) {
      this.failNextUpdate = false;
      throw new Error("unavailable");
    }
    const index = this.events.findIndex((event) => event.id === input.eventId);
    const event = this.events[index];
    if (event === undefined) throw new Error("missing");
    const content = eventContent(input.structureJson);
    this.events[index] = {
      ...event,
      dateKey: input.dateKey,
      name: input.name,
      ...(input.sport === undefined ? {} : { type: icuEventType(input.sport) }),
      ...content,
      durationS: this.stored(input.durationS, content.description),
      updated: this.stamp(),
    };
  }

  async deleteEvent(input: { eventId: number }) {
    this.deletes.push(input.eventId);
    await this.delay();
    if (this.refuseDeletes) throw new Error("forbidden");
    const index = this.events.findIndex((event) => event.id === input.eventId);
    if (index < 0) throw new Error("missing");
    this.events.splice(index, 1);
  }

  private async delay(): Promise<void> {
    if (this.delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
  }
}

export const createMemoryPlanCalendar = () => new MemoryPlanCalendar();
