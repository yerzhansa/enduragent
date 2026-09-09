import { IntervalsClient, type Event } from "intervals-icu-api";
import { describe, expect, it, vi, onTestFinished } from "vitest";
import type { PlanCreationAnswerInput } from "@enduragent/coach-contract";
import { reconcileActivePlanWindow } from "@enduragent/engine";
import {
  createPlanCreationRepository,
  createPlanRepository,
  createPlanReconciliationRepository,
} from "@enduragent/kernel/planning";
import { runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { createPlanCreationOperations } from "../src/plan-creation-operations.js";
import { createPlanMirrorCalendarAdapter } from "../src/planning-calendar.js";

describe("Plan Intervals calendar adapter", () => {
  it("uses provider UIDs as durable Plan workout identities", async () => {
    const list = vi.fn(async () => ({
      ok: true as const,
      value: [
        {
          id: 42,
          startDateLocal: "2026-08-25T00:00:00",
          category: "WORKOUT",
          uid: "cycling-coach:plan:plan:workout",
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
    expect(create).toHaveBeenCalledWith(
      {
        startDateLocal: "2026-08-26T00:00:00",
        category: "WORKOUT",
        name: "Threshold 4×8",
        type: "Ride",
        uid: "cycling-coach:plan:plan:workout-2",
        movingTime: 4_800,
        description: "Four threshold efforts.",
      },
      { upsertOnUid: true },
    );
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
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ type }), { upsertOnUid: true });
  });

  it("mirrors a Chat-activated Plan through the calendar adapter as Ride events", async () => {
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

  it("fails closed when Intervals credentials are absent", async () => {
    const calendar = createPlanMirrorCalendarAdapter(() => null);
    await expect(
      calendar.listEvents({ startDateKey: 20260825, endDateKey: 20260831 }),
    ).rejects.toThrow("Intervals credentials are required");
  });
});
