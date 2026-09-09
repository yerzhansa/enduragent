import type {
  PlanMirrorCalendarPort,
  PlanMirrorCreateInput,
  PlanMirrorEvent,
  PlanMirrorUpdateInput,
} from "@enduragent/engine";

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
  delayMs = 0;
  nextEventId = 100;

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
    this.events.push({
      id: this.nextEventId++,
      dateKey: input.dateKey,
      externalId: input.externalId,
      name: input.name,
      durationS: input.durationS,
      ...eventContent(input.structureJson),
    });
  }

  async updateEvent(input: PlanMirrorUpdateInput) {
    this.updates.push(input);
    await this.delay();
    const index = this.events.findIndex((event) => event.id === input.eventId);
    const event = this.events[index];
    if (event === undefined) throw new Error("missing");
    this.events[index] = {
      ...event,
      dateKey: input.dateKey,
      name: input.name,
      durationS: input.durationS,
      ...eventContent(input.structureJson),
    };
  }

  async deleteEvent(input: { eventId: number }) {
    this.deletes.push(input.eventId);
    await this.delay();
    const index = this.events.findIndex((event) => event.id === input.eventId);
    if (index < 0) throw new Error("missing");
    this.events.splice(index, 1);
  }

  private async delay(): Promise<void> {
    if (this.delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
  }
}

export const createMemoryPlanCalendar = () => new MemoryPlanCalendar();
