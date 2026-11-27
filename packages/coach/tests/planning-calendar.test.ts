import { IntervalsClient, type Event, type EventInput } from "intervals-icu-api";
import { describe, expect, it, vi, onTestFinished } from "vitest";
import type { PlanCreationAnswerInput } from "@enduragent/coach-contract";
import { reconcileActivePlanWindow } from "@enduragent/engine";
import { trainingWeek } from "@enduragent/engine/calendar";
import {
  createPlanCreationRepository,
  createPlanRepository,
  createPlanReconciliationRepository,
} from "@enduragent/kernel/planning";
import { runMigrations, type SqlStore } from "@enduragent/kernel/store";
import { serializeIntervalsWorkout } from "@enduragent/sport-cycling";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { createPlanCalendarDrain } from "../src/plan-calendar-drain.js";
import { createPlanCreationOperations } from "../src/plan-creation-operations.js";
import { createPlanCalendarOperations } from "../src/plan-calendar-operations.js";
import { createPlanMirrorCalendarAdapter } from "../src/planning-calendar.js";

async function activateSyntheticPlan() {
  const store = openSqliteStorage(":memory:");
  onTestFinished(() => store.close());
  await runMigrations(store, MIGRATIONS);
  let sequence = 0;
  const newId = () => String(++sequence).padStart(26, "0");
  const now = () => 904_737_600_000;
  const host = createPlanCreationOperations({
    store,
    repository: createPlanCreationRepository(store),
    identity: {
      deviceId: async () => "calendar-test-device",
      newUlid: newId,
      hlcStamp: () => ({ physicalMs: now(), counter: 0 }),
    },
    crypto: globalThis.crypto,
    eventCandidates: { read: async () => [] },
    eventSources: { read: async () => [] },
    today: () => "1998-09-02",
    todayDateKey: () => 19980902,
    now,
  });
  const started = await host["plan_creation.start"]({ commandId: "start" });
  if (started.status !== "started") throw new Error("Expected creation");
  let card = started.planCreation;
  const answers: readonly PlanCreationAnswerInput[] = [
    { kind: "goal", goal: { kind: "fitness" } },
    { kind: "plan-length", weeks: 4 },
    { kind: "schedule-mode", mode: "fixed" },
    {
      kind: "availability",
      mode: "fixed",
      weeklyHoursLimit: 8,
      longestWorkoutHours: 3,
      usableWeekdays: [2, 4, 6],
    },
    { kind: "start-timing", timing: { kind: "as-soon-as-possible" } },
    { kind: "commitments", commitments: { kind: "none" } },
    { kind: "baseline", baseline: "regular" },
    { kind: "success", success: { kind: "fitness-choice", choice: "climb-stronger" } },
    { kind: "restriction", restriction: { kind: "none" } },
  ];
  for (const answer of answers) {
    const result = await host["plan_creation.answer"]({
      commandId: `answer-${newId()}`,
      creationId: card.creationId,
      expectedVersion: card.version,
      answer,
    });
    if (result.status !== "answered") throw new Error("Expected answer");
    card = result.planCreation;
  }
  const preview = await host["plan_creation.preview"]({
    commandId: "preview",
    creationId: card.creationId,
    expectedVersion: card.version,
  });
  if (preview.status !== "previewed") throw new Error("Expected preview");
  const activated = await host["plan_creation.activate"]({
    commandId: "activate",
    creationId: card.creationId,
    expectedVersion: preview.planCreation.version,
    incumbent: null,
  });
  const plans = createPlanRepository(store);
  const plan = await plans.read(activated.planId);
  if (plan === undefined) throw new Error("Expected active Plan");
  return { store, plans, plan, newId, now };
}

async function giveWorkoutsDraftBuilderContent(store: SqlStore, planId: string) {
  const durationS = 3_725;
  const mainMinutes = Number((durationS / 60).toFixed(2)) - 20;
  const workoutDoc = {
    name: "Sweet spot",
    steps: [
      {
        type: "warmup" as const,
        duration: { value: 10, unit: "minutes" as const },
        power: { kind: "percent_ftp" as const, low: 45, high: 65 },
      },
      {
        type: "set" as const,
        repeat: 3,
        interval: {
          type: "interval" as const,
          duration: { value: (mainMinutes - 9) / 3, unit: "minutes" as const },
          power: { kind: "percent_ftp" as const, low: 88, high: 94 },
        },
        recovery: {
          type: "recovery" as const,
          duration: { value: 3, unit: "minutes" as const },
          power: { kind: "percent_ftp" as const, value: 50 },
        },
      },
      {
        type: "cooldown" as const,
        duration: { value: 10, unit: "minutes" as const },
        power: { kind: "percent_ftp" as const, value: 45 },
      },
    ],
  };
  const { description, movingTime } = serializeIntervalsWorkout(workoutDoc);
  if (movingTime !== durationS) throw new Error("Expected the builder's duration");
  await store.run("UPDATE plan_workout SET duration_s=?, structure_json=? WHERE plan_id=?", [
    durationS,
    JSON.stringify({ workoutType: "sweet_spot", description, workoutDoc }),
    planId,
  ]);
}

function describedSeconds(description: string): number {
  let total = 0;
  let repeat = 1;
  for (const line of description.split("\n")) {
    const set = /(\d+)x$/.exec(line);
    if (set !== null) repeat = Number(set[1]);
    else if (line === "") repeat = 1;
    const step = /^- (?:(\d+)m(\d+)?|(\d+)s)\b/.exec(line);
    if (step === null) continue;
    total +=
      repeat *
      (step[3] === undefined ? Number(step[1]) * 60 + Number(step[2] ?? 0) : Number(step[3]));
  }
  return total;
}

function intervalsCalendarAsMeasured() {
  const client = new IntervalsClient({ apiKey: "test-key", athleteId: "0" });
  const events: Event[] = [];
  const stored = (body: EventInput, current?: Event): Event => {
    const merged = { ...current, ...body };
    if (typeof merged.startDateLocal !== "string") throw new Error("Expected dated event");
    const description = merged.description ?? null;
    const parsesDescription = body.workoutDoc === undefined && description !== null;
    return {
      ...merged,
      id: current?.id ?? events.length + 1,
      startDateLocal: merged.startDateLocal,
      category: "WORKOUT",
      uid: current?.uid ?? crypto.randomUUID(),
      externalId: current?.externalId ?? body.externalId ?? null,
      description,
      movingTime: parsesDescription ? describedSeconds(description) : (merged.movingTime ?? null),
      workoutDoc: parsesDescription
        ? { duration: describedSeconds(description), steps: [{ duration: 600, warmup: true }] }
        : (body.workoutDoc ?? current?.workoutDoc ?? null),
    };
  };
  vi.spyOn(client.events, "list").mockImplementation(async (query) => ({
    ok: true,
    value: events.filter((event) => {
      const day = event.startDateLocal.slice(0, 10);
      return (
        (query?.oldest === undefined || day >= query.oldest) &&
        (query?.newest === undefined || day <= query.newest) &&
        (query?.category === undefined || query.category.includes(event.category))
      );
    }),
  }));
  const create = vi.spyOn(client.events, "create").mockImplementation(async (body) => {
    const event = stored(body);
    events.push(event);
    return { ok: true, value: event };
  });
  vi.spyOn(client.events, "get").mockImplementation(async (id) => {
    const event = events.find((row) => row.id === id);
    return event === undefined
      ? {
          ok: false as const,
          error: { kind: "NotFound" as const, status: 404 as const, body: null },
        }
      : { ok: true as const, value: event };
  });
  const update = vi.spyOn(client.events, "update").mockImplementation(async (id, body) => {
    const index = events.findIndex((event) => event.id === id);
    const current = events[index];
    if (current === undefined) throw new Error("Expected stored event");
    const event = stored(body, current);
    events[index] = event;
    return { ok: true, value: event };
  });
  return { client, events, create, update };
}

describe("Plan Intervals calendar adapter", () => {
  it("uses provider external IDs as durable Plan workout identities", async () => {
    const list = vi.fn(async () => ({
      ok: true as const,
      value: [
        {
          id: 42,
          startDateLocal: "2026-08-25T00:00:00",
          category: "WORKOUT",
          uid: "00000000-0000-4000-8000-000000000042",
          externalId: "cycling-coach:plan:plan:workout",
        },
      ],
    }));
    const create = vi.fn(async (body: unknown) => ({
      ok: true as const,
      value: { id: 43, ...(body as object) },
    }));
    const remove = vi.fn(async () => ({ ok: true as const, value: {} }));
    const client = {
      events: { list, create, delete: remove },
    } as unknown as IntervalsClient;
    const calendar = createPlanMirrorCalendarAdapter(() => client);

    await expect(
      calendar.listEvents({ startDateKey: 20260825, endDateKey: 20260831 }),
    ).resolves.toEqual([
      {
        id: 42,
        dateKey: 20260825,
        externalId: "cycling-coach:plan:plan:workout",
        category: "WORKOUT",
      },
    ]);
    await calendar.createEvent({
      planId: "00000000000000000000000001",
      planWorkoutId: "00000000000000000000000002",
      dateKey: 20260826,
      externalId: "cycling-coach:plan:plan:workout-2",
      name: "Threshold 4×8",
      sport: "cycling",
      durationS: 4_800,
      structureJson: JSON.stringify({ description: "Four threshold efforts." }),
    });
    await calendar.deleteEvent({ eventId: 42 });

    expect(list).toHaveBeenCalledWith({
      oldest: "2026-08-25",
      newest: "2026-08-31",
      category: ["WORKOUT"],
    });
    expect(create).toHaveBeenCalledWith({
      startDateLocal: "2026-08-26T00:00:00",
      category: "WORKOUT",
      name: "Threshold 4×8",
      type: "Ride",
      externalId: "cycling-coach:plan:plan:workout-2",
      movingTime: 4_800,
      description: "Four threshold efforts.",
    });
    expect(remove).toHaveBeenCalledWith(42);
  });

  it.each([
    ["Ride", "Ride"],
    ["cycling", "Ride"],
    ["bike", "Ride"],
    ["running", "Run"],
    ["swimming", "Swim"],
  ])("maps %s Workouts to %s events", async (sport, type) => {
    const client = new IntervalsClient({ apiKey: "test-key", athleteId: "0" });
    const create = vi.spyOn(client.events, "create").mockResolvedValue({
      ok: true,
      value: { id: 43, startDateLocal: "1998-09-02T00:00:00", category: "WORKOUT" },
    });
    await createPlanMirrorCalendarAdapter(() => client).createEvent({
      planId: "00000000000000000000000001",
      planWorkoutId: "00000000000000000000000002",
      dateKey: 19980902,
      externalId: "cycling-coach:plan:plan:workout",
      name: "Endurance",
      sport,
      durationS: 3600,
      structureJson: "{}",
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ type }));
  });

  it("mirrors a Chat-activated Plan through the calendar adapter as Ride events", async () => {
    const { store, plans, plan, newId, now } = await activateSyntheticPlan();
    const client = new IntervalsClient({ apiKey: "test-key", athleteId: "0" });
    const events: Event[] = [];
    vi.spyOn(client.events, "list").mockImplementation(async () => ({ ok: true, value: events }));
    const create = vi.spyOn(client.events, "create").mockImplementation(async (body) => {
      if (!("startDateLocal" in body) || typeof body.startDateLocal !== "string")
        throw new Error("Expected dated event");
      const event = {
        ...body,
        id: events.length + 1,
        startDateLocal: body.startDateLocal,
        category: "WORKOUT",
      };
      events.push(event);
      return { ok: true, value: event };
    });
    const result = await reconcileActivePlanWindow(
      {
        plan,
        workouts: await plans.readWorkouts(plan.id),
        todayDateKey: 19980902,
      },
      {
        repository: createPlanReconciliationRepository(store),
        calendar: createPlanMirrorCalendarAdapter(() => client),
        identity: { newId },
        now,
      },
    );
    expect(result.state).toBe("reconcile-verified");
    expect(create.mock.calls.length).toBeGreaterThan(0);
    for (const [body] of create.mock.calls) expect(body).toMatchObject({ type: "Ride" });
  });

  it.each([
    ["Chat Plan Workouts", false],
    ["draft builder Workouts whose described steps add up to a second more", true],
  ])("mirrors %s once and leaves them alone on later drain runs", async (_case, builderContent) => {
    const { store, plan, newId, now } = await activateSyntheticPlan();
    if (builderContent) await giveWorkoutsDraftBuilderContent(store, plan.id);
    const intervals = intervalsCalendarAsMeasured();
    let today = 19980902;
    const drain = createPlanCalendarDrain({
      store,
      calendar: createPlanMirrorCalendarAdapter(() => intervals.client),
      calendarConnected: () => true,
      identity: { newUlid: newId },
      todayDateKey: () => today,
      now,
      logger: { warn: vi.fn() },
    });
    await createPlanCalendarOperations({
      store,
      todayDateKey: () => today,
      now,
      calendarConnected: () => true,
      dateKeyOfMs: () => today,
      changed: () => undefined,
    })["plan.calendar"]({
      action: "approve-weeks",
      planId: plan.id,
      scope: { kind: "first-weeks" },
    });

    const appStart = () => drain.kick();
    const scheduledRefresh = () => drain.kick();
    const planList = () => drain.kick();
    await appStart();
    await scheduledRefresh();
    await planList();
    today = 19980903;
    await scheduledRefresh();

    const weekTwoEnd = trainingWeek(plan, 2).endDateKey;
    const inTheTwoWeeks = await store.get(
      "SELECT COUNT(*) AS count FROM plan_workout WHERE plan_id=? AND origin='coach' AND date_key BETWEEN 19980902 AND ?",
      [plan.id, weekTwoEnd],
    );
    const workouts = Number(inTheTwoWeeks?.count);
    expect(workouts).toBeGreaterThan(0);
    expect({
      creates: intervals.create.mock.calls.length,
      events: intervals.events.length,
      updates: intervals.update.mock.calls.length,
    }).toEqual({ creates: workouts, events: workouts, updates: 0 });
    for (const [body] of intervals.create.mock.calls) {
      expect(body).not.toHaveProperty("uid");
      expect(body).not.toHaveProperty("workoutDoc");
    }
  });

  it("sends and reads the Plan identity as intervals.icu's external_id on the wire", async () => {
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    const client = new IntervalsClient({
      apiKey: "test-key",
      athleteId: "0",
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(String(input), init);
        const text = request.method === "POST" ? await request.text() : "";
        requests.push({
          method: request.method,
          url: request.url,
          body: text === "" ? null : JSON.parse(text),
        });
        const reply =
          request.method === "GET"
            ? [
                {
                  id: 42,
                  start_date_local: "1998-09-02T00:00:00",
                  category: "WORKOUT",
                  uid: "00000000-0000-4000-8000-000000000042",
                  external_id: "cycling-coach:plan:plan:workout",
                },
              ]
            : { id: 43, start_date_local: "1998-09-03T00:00:00", category: "WORKOUT" };
        return new Response(JSON.stringify(reply), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const calendar = createPlanMirrorCalendarAdapter(() => client);

    await expect(
      calendar.listEvents({ startDateKey: 19980902, endDateKey: 19980908 }),
    ).resolves.toEqual([
      expect.objectContaining({ id: 42, externalId: "cycling-coach:plan:plan:workout" }),
    ]);
    await calendar.createEvent({
      planId: "00000000000000000000000001",
      planWorkoutId: "00000000000000000000000002",
      dateKey: 19980903,
      externalId: "cycling-coach:plan:plan:workout-2",
      name: "Endurance",
      sport: "cycling",
      durationS: 3600,
      structureJson: "{}",
    });

    const post = requests.find((request) => request.method === "POST");
    expect(post?.body).toMatchObject({ external_id: "cycling-coach:plan:plan:workout-2" });
    expect(post?.body).not.toHaveProperty("uid");
    expect(post?.url).not.toContain("upsertOnUid=true");
  });

  it("fails closed when Intervals credentials are absent", async () => {
    const calendar = createPlanMirrorCalendarAdapter(() => null);
    await expect(
      calendar.listEvents({ startDateKey: 20260825, endDateKey: 20260831 }),
    ).rejects.toThrow("Intervals credentials are required");
  });
});
