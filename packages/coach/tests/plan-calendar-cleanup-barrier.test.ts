import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { PlanCreationAnswerInput } from "@enduragent/coach-contract";
import { PLAN_MIRROR_EXTERNAL_ID_PREFIX, planMirrorExternalIdPrefix } from "@enduragent/engine";
import {
  addCivilDays,
  createPlanCreationRepository,
  createPlanReconciliationRepository,
} from "@enduragent/kernel/planning";
import { runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { createMemoryPlanCalendar } from "../../../apps/desktop/tests/helpers/plan-calendar-fake.js";
import { createPlanCalendarDrain } from "../src/plan-calendar-drain.js";
import { createPlanCreationOperations } from "../src/plan-creation-operations.js";

const closedOn = 19980902;
const retryableCleanup = "Calendar cleanup failed. Retry available.";

async function harness() {
  const store = openSqliteStorage(":memory:");
  await runMigrations(store, MIGRATIONS);
  let sequence = 100;
  let today = closedOn;
  let nowMs = 904_694_400_000;
  let connected = true;
  const calendar = createMemoryPlanCalendar();
  const identity = {
    deviceId: async () => "cleanup-barrier-device",
    newUlid: () => String(++sequence).padStart(26, "0"),
    hlcStamp: () => ({ physicalMs: nowMs, counter: sequence }),
  };
  const dependencies = {
    store,
    identity,
    crypto: globalThis.crypto,
    todayDateKey: () => today,
    now: () => nowMs,
    calendarConnected: () => connected,
  };
  const creation = createPlanCreationOperations({
    ...dependencies,
    repository: createPlanCreationRepository(store),
    eventCandidates: { read: async () => [] },
    eventSources: { read: async () => [] },
    today: () => String(today).replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3"),
  });
  const drain = createPlanCalendarDrain({ ...dependencies, calendar, logger: { warn: vi.fn() } });
  onTestFinished(async () => {
    await drain.idle();
    await store.close();
  });
  const activate = async () => {
    nowMs += 1_000;
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
  const owner = (externalId: string | null | undefined) =>
    externalId?.startsWith(PLAN_MIRROR_EXTERNAL_ID_PREFIX) === true
      ? externalId.slice(PLAN_MIRROR_EXTERNAL_ID_PREFIX.length).split(":")[0]
      : undefined;
  return {
    calendar,
    creation,
    drain,
    activate,
    today: () => today,
    advanceDay: () => {
      today = addCivilDays(today, 1);
      nowMs += 86_400_000;
    },
    advanceMs: (ms: number) => {
      nowMs += ms;
    },
    disconnect: () => {
      connected = false;
    },
    cleanup: (planId: string) => reconciliation.readLatestJob(planId, "cleanup"),
    retry: async () => {
      await creation["plan.list"]({ retryCalendar: true });
      await drain.kick();
    },
    writesOf: (planId: string) =>
      calendar.creates
        .filter((event) => event.externalId.startsWith(planMirrorExternalIdPrefix(planId)))
        .map((event) => event.dateKey),
    datesOf: (planId: string) =>
      calendar.events
        .filter((event) => owner(event.externalId) === planId)
        .map((event) => event.dateKey)
        .sort((left, right) => left - right),
    sharedDays: (except: ReadonlySet<number> = new Set()) => {
      const owners = new Map<number, Set<string>>();
      for (const event of calendar.events) {
        const planId = owner(event.externalId);
        if (planId === undefined || except.has(event.id)) continue;
        owners.set(event.dateKey, (owners.get(event.dateKey) ?? new Set()).add(planId));
      }
      return [...owners].filter(([, planIds]) => planIds.size > 1).map(([dateKey]) => dateKey);
    },
  };
}

async function mirroredPlanReplacedWhileDeletesFail() {
  const test = await harness();
  const oldPlan = await test.activate();
  await test.drain.kick();
  const oldDates = test.datesOf(oldPlan);
  expect(oldDates).toContain(closedOn);
  expect(Math.max(...oldDates)).toBeGreaterThan(closedOn);
  test.calendar.refuseDeletes = true;
  const newPlan = await test.activate();
  return { test, oldPlan, oldDates, newPlan };
}

describe("Plan calendar cleanup barrier", () => {
  it("writes no new-Plan workout while the old Plan's cleanup keeps failing", async () => {
    const { test, oldPlan, newPlan } = await mirroredPlanReplacedWhileDeletesFail();
    for (let run = 0; run < 7; run += 1) {
      test.advanceMs(900_000);
      await test.drain.kick();
    }

    expect(await test.cleanup(oldPlan)).toMatchObject({ status: "failed", failureCount: 7 });
    expect(
      test.writesOf(newPlan),
      "new Plan workouts written while the old Plan's cleanup is not verified",
    ).toEqual([]);

    test.calendar.refuseDeletes = false;
    test.advanceMs(900_000);
    await test.drain.kick();

    expect(await test.cleanup(oldPlan)).toMatchObject({ status: "verified" });
    expect(test.datesOf(oldPlan)).toEqual([closedOn]);
    expect(Math.min(...test.datesOf(newPlan))).toBeGreaterThanOrEqual(addCivilDays(closedOn, 1));
    expect(test.sharedDays()).toEqual([]);
  });

  it("holds the new Plan behind an older failed cleanup after a later replacement's cleanup verifies", async () => {
    const {
      test,
      oldPlan: firstPlan,
      newPlan: secondPlan,
    } = await mirroredPlanReplacedWhileDeletesFail();
    await test.drain.kick();
    expect(await test.cleanup(firstPlan)).toMatchObject({ status: "failed" });
    expect(test.writesOf(secondPlan)).toEqual([]);

    const thirdPlan = await test.activate();
    await test.drain.kick();

    expect(await test.cleanup(secondPlan)).toMatchObject({ status: "verified" });
    expect(await test.cleanup(firstPlan)).toMatchObject({ status: "failed" });
    expect(
      test.writesOf(thirdPlan),
      "new Plan workouts written next to an older Plan whose cleanup failed",
    ).toEqual([]);
    expect(
      (await test.creation["plan.list"]({})).active?.calendar,
      "active Plan card while an older cleanup still holds it",
    ).toMatchObject({ status: "failed", error: retryableCleanup });

    test.calendar.refuseDeletes = false;
    await test.retry();

    expect(await test.cleanup(firstPlan)).toMatchObject({ status: "verified" });
    expect(test.datesOf(firstPlan)).toEqual([closedOn]);
    expect(test.datesOf(secondPlan)).toEqual([]);
    expect(Math.min(...test.datesOf(thirdPlan))).toBeGreaterThanOrEqual(addCivilDays(closedOn, 1));
    expect(test.sharedDays()).toEqual([]);
    expect((await test.creation["plan.list"]({})).active?.calendar.status).toBe("verified");
  });

  it("offers Retry on a cleanup that failed five times and runs it again at once", async () => {
    const { test, oldPlan, newPlan } = await mirroredPlanReplacedWhileDeletesFail();
    for (let run = 0; run < 5; run += 1) {
      test.advanceMs(1_000);
      await test.drain.kick();
    }
    expect(await test.cleanup(oldPlan)).toMatchObject({ status: "failed", failureCount: 5 });

    const library = await test.creation["plan.list"]({});
    expect(
      library.closed[0]?.calendar.error,
      "closed Plan offers Retry after five failed cleanups",
    ).toBe(retryableCleanup);
    expect(
      (await test.creation["plan.history"]({ planId: oldPlan }))?.plan.calendar?.error,
      "final details offer Retry after five failed cleanups",
    ).toBe(retryableCleanup);

    test.calendar.refuseDeletes = false;
    const lists = test.calendar.lists.length;
    await test.drain.kick();
    expect(
      test.calendar.lists,
      "the automatic retry waits 15 minutes after five failures",
    ).toHaveLength(lists);

    await test.retry();

    expect(await test.cleanup(oldPlan)).toMatchObject({ status: "verified", failureCount: 5 });
    expect(test.datesOf(oldPlan)).toEqual([closedOn]);
    expect(Math.min(...test.datesOf(newPlan))).toBeGreaterThanOrEqual(addCivilDays(closedOn, 1));
    expect((await test.creation["plan.list"]({})).active?.calendar.status).toBe("verified");
  });

  it("tells the truth on the active Plan card while the barrier holds", async () => {
    const { test, newPlan } = await mirroredPlanReplacedWhileDeletesFail();
    expect(
      (await test.creation["plan.list"]({})).active?.calendar,
      "active Plan card before the old Plan's cleanup runs",
    ).toMatchObject({ status: "pending" });

    await test.drain.kick();

    expect(test.writesOf(newPlan)).toEqual([]);
    expect(
      (await test.creation["plan.list"]({})).active?.calendar,
      "active Plan card while its calendar waits for the failed cleanup",
    ).toMatchObject({ status: "failed", error: retryableCleanup });
    for (let run = 0; run < 5; run += 1) {
      test.advanceMs(1_000);
      await test.drain.kick();
    }
    expect(
      (await test.creation["plan.list"]({})).active?.calendar,
      "active Plan card after five failed cleanups",
    ).toMatchObject({ status: "failed", error: retryableCleanup });

    test.calendar.refuseDeletes = false;
    await test.retry();

    expect((await test.creation["plan.list"]({})).active?.calendar).toMatchObject({
      status: "verified",
      window: { start: "1998-09-02" },
    });
    expect(test.writesOf(newPlan).length).toBeGreaterThan(0);
  });

  it("shows the waiting calendar as not connected once intervals.icu is not connected", async () => {
    const { test, newPlan } = await mirroredPlanReplacedWhileDeletesFail();
    await test.drain.kick();
    test.disconnect();

    expect(test.writesOf(newPlan)).toEqual([]);
    expect(
      (await test.creation["plan.list"]({})).active?.calendar,
      "active Plan card while its calendar waits and intervals.icu is not connected",
    ).toMatchObject({ status: "not-connected" });
  });

  it("removes the old Plan from the day after it closed on a late Retry and never shares a day", async () => {
    const test = await harness();
    const oldPlan = await test.activate();
    await test.drain.kick();
    const later = test.calendar.events.filter((event) => event.dateKey > addCivilDays(closedOn, 2));
    const edited = later[0];
    if (edited === undefined) throw new Error("Expected a later old-Plan workout");
    test.calendar.editByAthlete(edited.id, { name: "Mine now" });
    await test.drain.kick();
    test.calendar.refuseDeletes = true;
    const newPlan = await test.activate();
    await test.drain.kick();
    expect(await test.cleanup(oldPlan)).toMatchObject({ status: "failed", failureCount: 1 });

    test.advanceDay();
    test.advanceDay();
    test.calendar.refuseDeletes = false;
    await test.creation["plan.list"]({});
    await test.drain.kick();

    expect(await test.cleanup(oldPlan)).toMatchObject({ status: "verified" });
    expect(
      test.datesOf(oldPlan),
      "the old Plan keeps the day it closed and the athlete's change, and nothing else",
    ).toEqual([closedOn, edited.dateKey]);
    const newDates = test.datesOf(newPlan);
    expect(newDates.length).toBeGreaterThan(0);
    expect(Math.min(...newDates)).toBeGreaterThanOrEqual(test.today());
    expect(test.sharedDays(new Set([edited.id])), "two Plans' workouts on one day").toEqual([]);
  });
});
