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
import { landIcuRideSettings } from "../../../apps/desktop/tests/helpers/icu-ftp-fake.js";
import { createPlanCalendarDrain } from "../src/plan-calendar-drain.js";
import { createPlanCreationOperations } from "../src/plan-creation-operations.js";
import { createPlanCalendarOperations } from "../src/plan-calendar-operations.js";
import {
  createCalendarMirrorAdapter,
  createPlanMirrorCalendarAdapter,
} from "../src/planning-calendar.js";
import { planWorkoutDescriber } from "../src/plan-workout-description.js";

const ATHLETE = "i1998";

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

function intervalsCalendarAsMeasured(recountSkewS = 0) {
  const client = new IntervalsClient({ apiKey: "test-key", athleteId: "0" });
  const events: Event[] = [];
  const stored = (body: EventInput, current?: Event): Event => {
    const merged = { ...current, ...body };
    if (typeof merged.startDateLocal !== "string") throw new Error("Expected dated event");
    const description = merged.description ?? null;
    const parsesDescription =
      body.workoutDoc === undefined && description !== null && description.trim() !== "";
    return {
      ...merged,
      id: current?.id ?? events.length + 1,
      startDateLocal: merged.startDateLocal,
      category: "WORKOUT",
      uid: current?.uid ?? crypto.randomUUID(),
      externalId: current?.externalId ?? body.externalId ?? null,
      description,
      movingTime: parsesDescription
        ? describedSeconds(description) + recountSkewS
        : (merged.movingTime ?? null),
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

async function calendarMirror(
  activated: Awaited<ReturnType<typeof activateSyntheticPlan>>,
  options: { readonly recountSkewS?: number } = {},
) {
  const { store, plan, newId, now } = activated;
  const intervals = intervalsCalendarAsMeasured(options.recountSkewS);
  let today = 19980902;
  const drain = createPlanCalendarDrain({
    store,
    calendar: createPlanMirrorCalendarAdapter(() => intervals.client),
    calendarConnected: () => true,
    identity: { newUlid: newId },
    todayDateKey: () => today,
    now,
    logger: { warn: vi.fn() },
    ftp: { athleteId: () => ATHLETE },
  });
  await createPlanCalendarOperations({
    store,
    todayDateKey: () => today,
    now,
    calendarConnected: () => true,
    dateKeyOfMs: () => today,
    changed: async () => undefined,
    calendar: { mirror: createCalendarMirrorAdapter(() => null) },
    identity: {
      deviceId: async () => "calendar-test-device",
      newUlid: () => "0".repeat(25) + "9",
      hlcStamp: () => ({ physicalMs: 1, counter: 0 }),
    },
    applyChange: async () => {
      throw new TypeError("Plan Change operations are not used here");
    },
  })["plan.calendar"]({
    action: "approve-weeks",
    planId: plan.id,
    scope: { kind: "first-weeks" },
  });

  return {
    intervals,
    run: async (dateKey = today) => {
      today = dateKey;
      await drain.kick();
    },
  };
}

async function drainTwoWeeks(activated: Awaited<ReturnType<typeof activateSyntheticPlan>>) {
  const mirror = await calendarMirror(activated);
  const appStart = () => mirror.run();
  const scheduledRefresh = () => mirror.run();
  const planList = () => mirror.run();
  await appStart();
  await scheduledRefresh();
  await planList();
  await mirror.run(19980903);
  return mirror.intervals;
}

async function setFtp(store: SqlStore, ftp: number | null, updated: string) {
  await landIcuRideSettings(store, { id: 77, ftp, indoorFtp: null, updated });
}

async function workoutsInTheTwoWeeks(activated: Awaited<ReturnType<typeof activateSyntheticPlan>>) {
  const rows = await activated.store.all(
    "SELECT id, duration_s, structure_json FROM plan_workout WHERE plan_id=? AND origin='coach' AND date_key BETWEEN 19980902 AND ? ORDER BY id",
    [activated.plan.id, trainingWeek(activated.plan, 2).endDateKey],
  );
  expect(rows.length).toBeGreaterThan(0);
  return new Map(
    rows.map((row) => [
      String(row.id),
      { durationS: Number(row.duration_s), structureJson: String(row.structure_json) },
    ]),
  );
}

function workoutIdOf(externalId: unknown): string {
  return String(externalId).split(":").at(-1) ?? "";
}

const stepsOf = planWorkoutDescriber({ ftpKnown: true });

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
    ["Chat Plan Workouts with their content", false],
    ["draft builder Workouts whose described steps add up to a second more", true],
  ])("mirrors %s once and leaves them alone on later drain runs", async (_case, builderContent) => {
    const activated = await activateSyntheticPlan();
    const { store, plan } = activated;
    if (builderContent) await giveWorkoutsDraftBuilderContent(store, plan.id);
    const intervals = await drainTwoWeeks(activated);
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

  it("sends a Plan whose workouts carry content exactly as before while intervals.icu has no FTP", async () => {
    const withContent = await activateSyntheticPlan();
    const rows = await withContent.store.all(
      "SELECT id, structure_json FROM plan_workout WHERE plan_id=?",
      [withContent.plan.id],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows)
      expect(JSON.parse(String(row.structure_json))).toHaveProperty("content");
    const withoutContent = await activateSyntheticPlan();
    for (const row of rows) {
      const { content: _content, ...older } = JSON.parse(String(row.structure_json));
      await withoutContent.store.run("UPDATE plan_workout SET structure_json=? WHERE id=?", [
        JSON.stringify(older),
        row.id,
      ]);
    }
    const stripped = await withoutContent.store.all(
      "SELECT structure_json FROM plan_workout WHERE plan_id=?",
      [withoutContent.plan.id],
    );
    expect(stripped).toHaveLength(rows.length);
    for (const row of stripped)
      expect(JSON.parse(String(row.structure_json))).not.toHaveProperty("content");
    const sent = await drainTwoWeeks(withContent);
    const sentBefore = await drainTwoWeeks(withoutContent);
    expect(sent.create.mock.calls.length).toBeGreaterThan(0);
    expect(sent.create.mock.calls).toEqual(sentBefore.create.mock.calls);
    expect(sent.update.mock.calls).toEqual([]);
    for (const [body] of sent.create.mock.calls) expect(body).not.toHaveProperty("description");
  });

  it("sends each workout's steps while intervals.icu has an FTP, and leaves them alone after intervals.icu recounts the length", async () => {
    const activated = await activateSyntheticPlan();
    await setFtp(activated.store, 250, "1998-08-30T08:00:00.000+00:00");
    const workouts = await workoutsInTheTwoWeeks(activated);
    const mirror = await calendarMirror(activated, { recountSkewS: 1 });
    await mirror.run();
    await mirror.run();
    await mirror.run(19980903);
    const { create, update, events } = mirror.intervals;
    expect(create.mock.calls).toHaveLength(workouts.size);
    for (const [body] of create.mock.calls) {
      const workout = workouts.get(workoutIdOf("externalId" in body ? body.externalId : null));
      if (workout === undefined) throw new Error("Expected a Plan workout");
      expect(body.description).toBe(stepsOf(workout.structureJson));
      expect(body.description).toMatch(/^- \d+m \d+-\d+%$/mu);
      expect(describedSeconds(String(body.description))).toBe(workout.durationS);
      expect(body).toMatchObject({ movingTime: workout.durationS });
      expect(body).not.toHaveProperty("workoutDoc");
    }
    for (const event of events) {
      expect(event.movingTime).toBe(
        (workouts.get(workoutIdOf(event.externalId))?.durationS ?? 0) + 1,
      );
    }
    expect(update.mock.calls).toEqual([]);
  });

  it("adds the steps to every workout in the two weeks once when an FTP appears, then leaves them alone", async () => {
    const activated = await activateSyntheticPlan();
    const workouts = await workoutsInTheTwoWeeks(activated);
    const mirror = await calendarMirror(activated, { recountSkewS: 1 });
    await mirror.run();
    const { create, update, events } = mirror.intervals;
    expect(create.mock.calls).toHaveLength(workouts.size);
    for (const [body] of create.mock.calls) expect(body).not.toHaveProperty("description");
    expect(update.mock.calls).toEqual([]);
    await setFtp(activated.store, 250, "1998-08-30T08:00:00.000+00:00");
    await mirror.run();
    expect(update.mock.calls).toHaveLength(workouts.size);
    for (const [eventId, body] of update.mock.calls) {
      const event = events.find((entry) => entry.id === eventId);
      const workout = workouts.get(workoutIdOf(event?.externalId));
      if (workout === undefined) throw new Error("Expected a Plan workout");
      expect(body.description).toBe(stepsOf(workout.structureJson));
      expect(body.description).toMatch(/^- \d+m \d+-\d+%$/mu);
    }
    await mirror.run();
    await mirror.run();
    expect(update.mock.calls).toHaveLength(workouts.size);
    expect(create.mock.calls).toHaveLength(workouts.size);
  });

  it("takes the steps off every workout in the two weeks once when the FTP is removed, then leaves them alone", async () => {
    const activated = await activateSyntheticPlan();
    await setFtp(activated.store, 250, "1998-08-30T08:00:00.000+00:00");
    const workouts = await workoutsInTheTwoWeeks(activated);
    const mirror = await calendarMirror(activated, { recountSkewS: 1 });
    await mirror.run();
    const { create, update, events } = mirror.intervals;
    expect(create.mock.calls).toHaveLength(workouts.size);
    await setFtp(activated.store, null, "1998-08-31T08:00:00.000+00:00");
    await mirror.run();
    expect(update.mock.calls).toHaveLength(workouts.size);
    for (const [, body] of update.mock.calls) expect(body.description).toBe("");
    for (const event of events) {
      expect(event.movingTime).toBe(workouts.get(workoutIdOf(event.externalId))?.durationS);
    }
    await mirror.run();
    await mirror.run();
    expect(update.mock.calls).toHaveLength(workouts.size);
    expect(create.mock.calls).toHaveLength(workouts.size);
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
