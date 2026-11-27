import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { PlanCreationAnswerInput } from "@enduragent/coach-contract";
import { planMirrorExternalIdPrefix } from "@enduragent/engine";
import {
  createPlanCreationRepository,
  createPlanReconciliationRepository,
} from "@enduragent/kernel/planning";
import { runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { createMemoryPlanCalendar } from "../../../apps/desktop/tests/helpers/plan-calendar-fake.js";
import { createPlanCalendarDrain } from "../src/plan-calendar-drain.js";
import { createPlanCreationOperations } from "../src/plan-creation-operations.js";

const today = 19980902;
const tomorrow = 19980903;
const retryableCleanup = "Calendar cleanup failed. Retry available.";

async function harness() {
  const store = openSqliteStorage(":memory:");
  await runMigrations(store, MIGRATIONS);
  let sequence = 100;
  const calendar = createMemoryPlanCalendar();
  const outage = { deletes: false };
  const deleteEvent = calendar.deleteEvent.bind(calendar);
  calendar.deleteEvent = async (input) => {
    if (outage.deletes) throw new Error("503 Service Unavailable");
    return deleteEvent(input);
  };
  const identity = {
    deviceId: async () => "cleanup-barrier-device",
    newUlid: () => String(++sequence).padStart(26, "0"),
    hlcStamp: () => ({ physicalMs: 904_694_400_000, counter: sequence }),
  };
  const dependencies = {
    store,
    identity,
    crypto: globalThis.crypto,
    todayDateKey: () => today,
    now: () => 904_694_400_000,
    calendarConnected: () => true,
  };
  const creation = createPlanCreationOperations({
    ...dependencies,
    repository: createPlanCreationRepository(store),
    eventCandidates: { read: async () => [] },
    eventSources: { read: async () => [] },
    today: () => "1998-09-02",
  });
  const drain = createPlanCalendarDrain({ ...dependencies, calendar, logger: { warn: vi.fn() } });
  onTestFinished(async () => {
    await drain.idle();
    await store.close();
  });
  const activate = async () => {
    const start = await creation["plan_creation.start"]({ commandId: `start-${++sequence}` });
    if (start.status !== "started") throw new Error("Expected creation");
    let card = start.planCreation;
    const answers: PlanCreationAnswerInput[] = [
      { kind: "goal", goal: { kind: "fitness" } },
      { kind: "plan-length", weeks: 4 },
      { kind: "schedule-mode", mode: "fixed" },
      {
        kind: "availability",
        mode: "fixed",
        weeklyHoursLimit: 8,
        longestWorkoutHours: 3,
        usableWeekdays: [1, 2, 3, 4, 5, 6, 7],
      },
      { kind: "start-timing", timing: { kind: "as-soon-as-possible" } },
      { kind: "commitments", commitments: { kind: "none" } },
      { kind: "baseline", baseline: "regular" },
      { kind: "success", success: { kind: "fitness-choice", choice: "climb-stronger" } },
      { kind: "restriction", restriction: { kind: "none" } },
    ];
    for (const answer of answers) {
      const result = await creation["plan_creation.answer"]({
        commandId: `answer-${++sequence}`,
        creationId: card.creationId,
        expectedVersion: card.version,
        answer,
      });
      if (result.status !== "answered") throw new Error("Expected answer");
      card = result.planCreation;
    }
    const preview = await creation["plan_creation.preview"]({
      commandId: `preview-${++sequence}`,
      creationId: card.creationId,
      expectedVersion: card.version,
    });
    if (preview.status !== "previewed") throw new Error("Expected Draft");
    const { active } = await creation["plan.list"]({});
    const result = await creation["plan_creation.activate"]({
      commandId: `activate-${++sequence}`,
      incumbent: active === null ? null : { planId: active.planId, version: active.version },
      creationId: card.creationId,
      expectedVersion: preview.planCreation.version,
    });
    if (result.planId === null) throw new Error("Expected active Plan");
    return result.planId;
  };
  const reconciliation = createPlanReconciliationRepository(store);
  return {
    calendar,
    creation,
    drain,
    outage,
    activate,
    cleanup: (planId: string) => reconciliation.readLatestJob(planId, "cleanup"),
    eventsOf: (planId: string, fromDateKey: number) =>
      calendar.events.filter(
        (event) =>
          event.externalId?.startsWith(planMirrorExternalIdPrefix(planId)) &&
          event.dateKey >= fromDateKey,
      ),
  };
}

describe("Plan calendar cleanup barrier", () => {
  it("keeps the new Plan off the calendar until the old Plan's cleanup is verified", async () => {
    const test = await harness();
    const oldPlan = await test.activate();
    await test.drain.kick();
    const oldToday = test.eventsOf(oldPlan, today).filter((event) => event.dateKey === today);
    expect(oldToday).toHaveLength(1);
    expect(test.eventsOf(oldPlan, tomorrow).length).toBeGreaterThan(0);

    test.outage.deletes = true;
    const newPlan = await test.activate();
    await test.drain.kick();

    expect(await test.cleanup(oldPlan)).toMatchObject({ status: "failed" });
    expect(
      test.eventsOf(newPlan, today).map((event) => event.dateKey),
      "new Plan workouts written while the old Plan's cleanup is not verified",
    ).toEqual([]);
    expect(
      (await test.creation["plan.list"]({})).active?.calendar,
      "active Plan card while its calendar waits for the failed cleanup",
    ).toMatchObject({ status: "failed", error: retryableCleanup });

    test.outage.deletes = false;
    await test.drain.kick();

    expect(await test.cleanup(oldPlan)).toMatchObject({ status: "verified" });
    expect(test.eventsOf(oldPlan, today)).toEqual(oldToday);
    const newDates = test.eventsOf(newPlan, today).map((event) => event.dateKey);
    expect(newDates.length).toBeGreaterThan(0);
    expect(Math.min(...newDates)).toBe(tomorrow);
    expect((await test.creation["plan.list"]({})).active?.calendar.status).toBe("verified");
  });

  it("lets the athlete retry a cleanup that failed five times", async () => {
    const test = await harness();
    const oldPlan = await test.activate();
    await test.drain.kick();
    test.outage.deletes = true;
    const newPlan = await test.activate();
    for (let attempt = 0; attempt < 5; attempt += 1) await test.drain.kick();
    expect(await test.cleanup(oldPlan)).toMatchObject({ status: "failed", failureCount: 5 });

    const library = await test.creation["plan.list"]({});
    expect(
      library.closed[0]?.calendar.error,
      "closed Plan offers Retry after five failed cleanups",
    ).toBe(retryableCleanup);
    expect(
      library.active?.calendar.error,
      "active Plan offers Retry while it waits for the cleanup",
    ).toBe(retryableCleanup);
    expect(
      (await test.creation["plan.history"]({ planId: oldPlan }))?.plan.calendar?.error,
      "final details offer Retry after five failed cleanups",
    ).toBe(retryableCleanup);

    test.outage.deletes = false;
    const lists = test.calendar.lists.length;
    await test.drain.kick();
    expect(test.calendar.lists, "automatic retries stay stopped after five failures").toHaveLength(
      lists,
    );
    expect(test.eventsOf(oldPlan, tomorrow).length).toBeGreaterThan(0);

    const retried = await test.creation["plan.list"]({ retryCalendar: true });
    expect(retried.closed[0]?.calendar.status).toBe("pending");
    expect(retried.active?.calendar.status).toBe("pending");
    await test.drain.kick();

    expect(await test.cleanup(oldPlan)).toMatchObject({ status: "verified", failureCount: 5 });
    expect(test.eventsOf(oldPlan, tomorrow)).toEqual([]);
    expect(Math.min(...test.eventsOf(newPlan, today).map((event) => event.dateKey))).toBe(tomorrow);
    expect((await test.creation["plan.list"]({})).active?.calendar.status).toBe("verified");
  });

  it("recovers a cleanup that failed four times on the next healthy kick", async () => {
    const test = await harness();
    const oldPlan = await test.activate();
    await test.drain.kick();
    test.outage.deletes = true;
    const newPlan = await test.activate();
    for (let attempt = 0; attempt < 4; attempt += 1) await test.drain.kick();
    expect(await test.cleanup(oldPlan)).toMatchObject({ status: "failed", failureCount: 4 });

    test.outage.deletes = false;
    await test.drain.kick();

    expect(await test.cleanup(oldPlan)).toMatchObject({ status: "verified" });
    expect(test.eventsOf(oldPlan, tomorrow)).toEqual([]);
    expect(test.eventsOf(newPlan, tomorrow).length).toBeGreaterThan(0);
  });
});
