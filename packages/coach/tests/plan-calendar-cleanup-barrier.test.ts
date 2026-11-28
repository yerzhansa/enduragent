import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { PlanCalendarTick, PlanCreationAnswerInput } from "@enduragent/coach-contract";
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
import { createPlanCalendarOperations } from "../src/plan-calendar-operations.js";
import { createPlanCreationOperations } from "../src/plan-creation-operations.js";

const closedOn = 19980902;
const retryableCleanup = "Calendar cleanup failed. Retry available.";

type SqlStoreOf = ReturnType<typeof openSqliteStorage>;

function pausingReads(store: SqlStoreOf, afterRead: (sql: string) => Promise<void>): SqlStoreOf {
  return new Proxy(store, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (key === "get") {
        return async (sql: string, params?: Parameters<SqlStoreOf["get"]>[1]) => {
          const row = await target.get(sql, params);
          await afterRead(sql);
          return row;
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function harness(start = closedOn, afterDrainRead?: (sql: string) => Promise<void>) {
  const store = openSqliteStorage(":memory:");
  await runMigrations(store, MIGRATIONS);
  let sequence = 100;
  let today = start;
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
  const drain = createPlanCalendarDrain({
    ...dependencies,
    store: afterDrainRead === undefined ? store : pausingReads(store, afterDrainRead),
    calendar,
    logger: { warn: vi.fn() },
  });
  const calendarOperations = createPlanCalendarOperations({
    store,
    todayDateKey: () => today,
    now: () => nowMs,
    calendarConnected: () => connected,
    dateKeyOfMs: () => today,
    changed: async () => undefined,
    calendar,
    identity,
    applyChange: async () => {
      throw new TypeError("Plan Change operations are not used here");
    },
  });
  onTestFinished(async () => {
    await drain.idle();
    await store.close();
  });
  const activate = async (approve = true) => {
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
    if (!approve) return result.planId;
    const approved = await calendarOperations["plan.calendar"]({
      action: "approve-weeks",
      planId: result.planId,
      scope: { kind: "first-weeks" },
    });
    if (approved.status !== "approved") throw new Error("Expected Approve");
    return result.planId;
  };
  const reconciliation = createPlanReconciliationRepository(store);
  const read = async () => {
    const calendar = await calendarOperations["plan.calendar"]({
      action: "read",
      startDateKey: today,
      endDateKey: addCivilDays(today, 13),
    });
    if (calendar.status !== "calendar") throw new Error("Expected the Calendar");
    return calendar;
  };
  const owner = (externalId: string | null | undefined) =>
    externalId?.startsWith(PLAN_MIRROR_EXTERNAL_ID_PREFIX) === true
      ? externalId.slice(PLAN_MIRROR_EXTERNAL_ID_PREFIX.length).split(":")[0]
      : undefined;
  return {
    calendar,
    creation,
    drain,
    activate,
    calendarOperations,
    approve: async (planId: string) => {
      const approved = await calendarOperations["plan.calendar"]({
        action: "approve-weeks",
        planId,
        scope: { kind: "first-weeks" },
      });
      if (approved.status !== "approved") throw new Error("Expected Approve");
    },
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
    connect: () => {
      connected = true;
    },
    approveTicking: async (planId: string, ticked: readonly PlanCalendarTick[]) => {
      const approved = await calendarOperations["plan.calendar"]({
        action: "approve-weeks",
        planId,
        scope: { kind: "first-weeks" },
        ticked: [...ticked],
      });
      if (approved.status !== "approved") throw new Error("Expected Approve");
    },
    end: async (planId: string) => {
      const { active } = await creation["plan.list"]({});
      if (active?.planId !== planId) throw new Error("Expected the Plan to be active");
      const closed = await creation["plan.close"]({
        commandId: `end-${++sequence}`,
        planId,
        expectedVersion: active.version,
      });
      if (closed.status !== "closed") throw new Error("Expected End");
    },
    store,
    replacing: async () => (await read()).replacing,
    sendsFrom: async () => (await read()).plan?.sendsFromDateKey,
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

async function mirroredPlanEndedWhileDeletesFail() {
  const test = await harness();
  const oldPlan = await test.activate();
  await test.drain.kick();
  expect(test.datesOf(oldPlan)).toContain(closedOn);
  test.calendar.refuseDeletes = true;
  await test.end(oldPlan);
  await test.drain.kick();
  expect(await test.cleanup(oldPlan)).toMatchObject({ status: "failed" });
  const newPlan = await test.activate(false);
  return { test, oldPlan, newPlan };
}

async function mirroredPlanReplacedWhileDeletesFail(approve = true) {
  const test = await harness();
  const oldPlan = await test.activate();
  await test.drain.kick();
  const oldDates = test.datesOf(oldPlan);
  expect(oldDates).toContain(closedOn);
  expect(Math.max(...oldDates)).toBeGreaterThan(closedOn);
  test.calendar.refuseDeletes = true;
  const newPlan = await test.activate(approve);
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
    expect(test.datesOf(newPlan).length).toBeGreaterThan(0);
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

  it("shows a failed End cleanup ahead of Waiting for Approve, then Waiting for Approve once it is fixed", async () => {
    const { test, newPlan } = await mirroredPlanEndedWhileDeletesFail();
    expect(
      (await test.creation["plan.list"]({})).active?.calendar,
      "active Plan card while an ended Plan's cleanup fails and the new Plan waits for Approve",
    ).toMatchObject({ status: "failed", error: retryableCleanup, waitingForApprove: true });

    test.calendar.refuseDeletes = false;
    await test.retry();

    expect(test.writesOf(newPlan)).toEqual([]);
    expect((await test.creation["plan.list"]({})).active?.calendar).toMatchObject({
      status: "waiting-for-approve",
    });
  });

  it("never says Up to date after an Approve that sent nothing", async () => {
    const test = await harness();
    const planId = await test.activate(false);
    await test.drain.kick();
    test.disconnect();
    await test.approve(planId);
    expect(
      (await test.creation["plan.list"]({})).active?.calendar,
      "active Plan card after Approve while intervals.icu is not connected",
    ).toMatchObject({ status: "not-connected" });
    expect(test.writesOf(planId)).toEqual([]);
  });

  it("says the approved weeks are pending until the drain sends them", async () => {
    const test = await harness();
    const planId = await test.activate(false);
    await test.drain.kick();
    await test.approve(planId);
    expect((await test.creation["plan.list"]({})).active?.calendar).toMatchObject({
      status: "pending",
    });
    await test.drain.kick();
    expect((await test.creation["plan.list"]({})).active?.calendar).toMatchObject({
      status: "verified",
    });
    expect(test.writesOf(planId).length).toBeGreaterThan(0);
  });

  it("runs a cleanup that failed five times again when the athlete approves", async () => {
    const { test, oldPlan, newPlan } = await mirroredPlanEndedWhileDeletesFail();
    for (let run = 0; run < 5; run += 1) {
      test.advanceMs(1_000);
      await test.drain.kick();
    }
    expect(await test.cleanup(oldPlan)).toMatchObject({ status: "failed", failureCount: 5 });
    test.calendar.refuseDeletes = false;
    await test.approve(newPlan);
    await test.drain.kick();
    await test.drain.kick();
    expect(await test.cleanup(oldPlan)).toMatchObject({ status: "verified" });
    expect(test.writesOf(newPlan).length).toBeGreaterThan(0);
  });

  it("runs a cleanup that failed five times again when the Calendar's Retry sends again", async () => {
    const { test, oldPlan, newPlan } = await mirroredPlanReplacedWhileDeletesFail();
    for (let run = 0; run < 6; run += 1) {
      test.advanceMs(1_000);
      await test.drain.kick();
    }
    expect(await test.cleanup(oldPlan)).toMatchObject({ status: "failed", failureCount: 5 });
    test.calendar.refuseDeletes = false;
    await test.drain.kick();
    expect(test.writesOf(newPlan), "before Retry").toEqual([]);
    await test.calendarOperations["plan.calendar"]({ action: "send-again" });
    await test.drain.kick();
    await test.drain.kick();
    expect(test.writesOf(newPlan).length, "after Retry").toBeGreaterThan(0);
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

async function mirroredPlanWithAnEdit() {
  const test = await harness();
  const oldPlan = await test.activate();
  await test.drain.kick();
  const edited = test.calendar.events
    .filter((event) => event.dateKey > addCivilDays(closedOn, 2))
    .sort((left, right) => left.dateKey - right.dateKey)[0];
  if (edited === undefined) throw new Error("Expected a later old-Plan workout");
  test.calendar.editByAthlete(edited.id, { name: "My own ride" });
  await test.drain.kick();
  const later = test.datesOf(oldPlan).filter((dateKey) => dateKey > closedOn);
  expect(later.length).toBeGreaterThan(1);
  return { test, oldPlan, edited, before: test.datesOf(oldPlan) };
}

describe("Replace as one Change Set", () => {
  it("leaves the old Plan on intervals.icu and sends nothing new after Replace and Not now", async () => {
    const { test, oldPlan, edited, before } = await mirroredPlanWithAnEdit();
    const newPlan = await test.activate(false);
    for (let run = 0; run < 3; run += 1) {
      test.advanceMs(900_000);
      await test.drain.kick();
    }

    expect(test.datesOf(oldPlan), "the old Plan's workouts before Approve").toEqual(before);
    expect(test.calendar.deletes, "deletes before Approve").toEqual([]);
    expect(test.writesOf(newPlan), "new Plan workouts written before Approve").toEqual([]);
    expect(await test.cleanup(oldPlan), "cleanup job before Approve").toBeUndefined();
    expect((await test.creation["plan.list"]({})).active?.calendar).toMatchObject({
      status: "waiting-for-approve",
    });
    const replacing = await test.replacing();
    expect(replacing).toMatchObject({ cleanup: "held", planName: "Improve fitness" });
    expect(replacing?.staysToday.map((entry) => entry.dateKey)).toEqual([closedOn]);
    expect(replacing?.athleteChanges.map((entry) => entry.tick.eventId)).toEqual([edited.id]);
    expect(replacing?.removes.map((entry) => entry.dateKey)).toEqual(
      before.filter((dateKey) => dateKey > closedOn && dateKey !== edited.dateKey),
    );
    expect(await test.sendsFrom(), "the first day the new Plan can go on").toBe(
      addCivilDays(closedOn, 1),
    );
  });

  it("takes the old Plan's workouts off and checks them before the new Plan's weeks go on", async () => {
    const { test, oldPlan, edited } = await mirroredPlanWithAnEdit();
    const newPlan = await test.activate(false);
    await test.drain.kick();
    let oldLaterAtFirstWrite: readonly number[] | undefined;
    test.calendar.beforeWrite = () => {
      oldLaterAtFirstWrite ??= test
        .datesOf(oldPlan)
        .filter((dateKey) => dateKey > closedOn && dateKey !== edited.dateKey);
    };
    await test.approve(newPlan);
    expect(await test.replacing()).toMatchObject({ cleanup: "pending" });
    await test.drain.kick();

    expect(
      oldLaterAtFirstWrite,
      "old Plan workouts left when the new Plan's first one went on",
    ).toEqual([]);
    expect(await test.cleanup(oldPlan)).toMatchObject({
      status: "verified",
      windowStartDateKey: addCivilDays(closedOn, 1),
    });
    expect(test.datesOf(oldPlan), "today's workout and the athlete's edit stay").toEqual([
      closedOn,
      edited.dateKey,
    ]);
    expect(test.calendar.events.find((event) => event.id === edited.id)?.name).toBe("My own ride");
    expect(test.writesOf(newPlan).length).toBeGreaterThan(0);
    expect(Math.min(...test.writesOf(newPlan))).toBeGreaterThan(closedOn);
    expect(test.sharedDays(new Set([edited.id]))).toEqual([]);
    expect(await test.replacing()).toBeNull();
    expect(await test.sendsFrom()).toBe(addCivilDays(closedOn, 1));
  });

  it("removes the old Plan from the day after the Approve when the athlete approves days later", async () => {
    const { test, oldPlan, edited, before } = await mirroredPlanWithAnEdit();
    const newPlan = await test.activate(false);
    test.advanceDay();
    await test.drain.kick();
    await test.approve(newPlan);
    await test.drain.kick();

    const approvedOn = addCivilDays(closedOn, 1);
    expect(await test.cleanup(oldPlan)).toMatchObject({
      status: "verified",
      windowStartDateKey: addCivilDays(approvedOn, 1),
    });
    expect(test.datesOf(oldPlan)).toEqual(
      before.filter((dateKey) => dateKey <= approvedOn || dateKey === edited.dateKey),
    );
    expect(Math.min(...test.writesOf(newPlan))).toBeGreaterThan(approvedOn);
  });

  it("removes the athlete's changes too when they tick them in the Approve sheet", async () => {
    const { test, oldPlan, edited } = await mirroredPlanWithAnEdit();
    const newPlan = await test.activate(false);
    const replacing = await test.replacing();
    const ticks = replacing?.athleteChanges.map((entry) => entry.tick) ?? [];
    expect(ticks.map((tick) => tick.eventId)).toEqual([edited.id]);
    await test.approveTicking(newPlan, ticks);
    await test.drain.kick();

    expect(test.datesOf(oldPlan)).toEqual([closedOn]);
    expect(test.calendar.events.find((event) => event.id === edited.id)).toBeUndefined();
    expect(test.writesOf(newPlan).length).toBeGreaterThan(0);
  });

  it("keeps an edit the athlete makes in intervals.icu after Replace and before Approve", async () => {
    const { test, oldPlan, edited } = await mirroredPlanWithAnEdit();
    const newPlan = await test.activate(false);
    await test.drain.kick();
    const later = test.calendar.events.filter(
      (event) =>
        event.dateKey > closedOn &&
        event.id !== edited.id &&
        event.externalId?.startsWith(planMirrorExternalIdPrefix(oldPlan)) === true,
    )[0];
    if (later === undefined) throw new Error("Expected another later old-Plan workout");
    test.calendar.editByAthlete(later.id, { name: "Changed during the hold" });
    await test.approve(newPlan);
    await test.drain.kick();

    expect(await test.cleanup(oldPlan)).toMatchObject({ status: "verified" });
    expect(test.calendar.events.find((event) => event.id === later.id)?.name).toBe(
      "Changed during the hold",
    );
    expect(test.calendar.events.find((event) => event.id === edited.id)?.name).toBe("My own ride");
  });

  it("still removes the old Plan when the athlete ends the new Plan without approving", async () => {
    const { test, oldPlan, edited, before } = await mirroredPlanWithAnEdit();
    const newPlan = await test.activate(false);
    await test.drain.kick();
    expect(test.datesOf(oldPlan)).toEqual(before);
    await test.end(newPlan);
    await test.drain.kick();

    expect(await test.cleanup(oldPlan)).toMatchObject({ status: "verified" });
    expect(test.datesOf(oldPlan)).toEqual([closedOn, edited.dateKey]);
    expect(test.writesOf(newPlan)).toEqual([]);
    expect(await test.cleanup(newPlan)).toMatchObject({ status: "verified" });
  });

  it("holds the first Plan's cleanup through a second Replace and runs it at the last Approve", async () => {
    const { test, oldPlan, edited, before } = await mirroredPlanWithAnEdit();
    const middlePlan = await test.activate(false);
    const newPlan = await test.activate(false);
    for (let run = 0; run < 2; run += 1) {
      test.advanceMs(900_000);
      await test.drain.kick();
    }
    expect(test.datesOf(oldPlan), "the first Plan after two Replaces and Not now").toEqual(before);
    expect(test.writesOf(middlePlan)).toEqual([]);
    expect(test.writesOf(newPlan)).toEqual([]);
    expect(await test.replacing()).toMatchObject({ cleanup: "held", planName: "Improve fitness" });
    expect(
      await test.approve(middlePlan).then(
        () => "approved",
        () => "refused",
      ),
      "the replaced middle Plan cannot be approved",
    ).toBe("refused");

    await test.approve(newPlan);
    await test.drain.kick();

    expect(await test.cleanup(oldPlan)).toMatchObject({ status: "verified" });
    expect(await test.cleanup(middlePlan)).toMatchObject({ status: "verified" });
    expect(test.datesOf(oldPlan)).toEqual([closedOn, edited.dateKey]);
    expect(test.writesOf(middlePlan)).toEqual([]);
    expect(test.writesOf(newPlan).length).toBeGreaterThan(0);
    expect(test.sharedDays(new Set([edited.id]))).toEqual([]);
  });

  it("releases the hold on an Approve while intervals.icu is not connected, and cleans up first once it is", async () => {
    const { test, oldPlan, edited, before } = await mirroredPlanWithAnEdit();
    const newPlan = await test.activate(false);
    await test.drain.kick();
    test.disconnect();
    await test.approve(newPlan);
    await test.drain.kick();

    expect((await test.creation["plan.list"]({})).active?.calendar).toMatchObject({
      status: "not-connected",
    });
    expect(await test.cleanup(oldPlan)).toMatchObject({ status: "pending" });
    expect(test.datesOf(oldPlan)).toEqual(before);
    expect(test.writesOf(newPlan)).toEqual([]);

    test.connect();
    await test.drain.kick();

    expect(test.datesOf(oldPlan)).toEqual([closedOn, edited.dateKey]);
    expect(test.writesOf(newPlan).length).toBeGreaterThan(0);
    expect(test.sharedDays(new Set([edited.id]))).toEqual([]);
  });

  it.each([19980930, 19981231])(
    "reads the Calendar after an Approve on %i, the last day of a month or a year",
    async (lastDay) => {
      const test = await harness(lastDay);
      const oldPlan = await test.activate();
      await test.drain.kick();
      expect(test.datesOf(oldPlan).filter((dateKey) => dateKey > lastDay).length).toBeGreaterThan(
        0,
      );
      const newPlan = await test.activate(false);
      expect(await test.replacing()).toMatchObject({ cleanup: "held" });
      test.calendar.refuseDeletes = true;
      await test.approve(newPlan);
      expect(await test.replacing(), "while the cleanup waits to run").toMatchObject({
        cleanup: "pending",
      });
      await test.drain.kick();
      const failed = await test.replacing();
      expect(failed, "while the cleanup failed").toMatchObject({ cleanup: "failed" });
      expect(failed?.removes.every((entry) => entry.dateKey > lastDay)).toBe(true);
      expect(await test.cleanup(oldPlan)).toMatchObject({
        windowStartDateKey: addCivilDays(lastDay, 1),
      });
    },
  );

  it("never lists a past day as today, or one workout as both staying and coming off, on a late retry", async () => {
    const test = await harness();
    const oldPlan = await test.activate();
    await test.drain.kick();
    const newPlan = await test.activate(false);
    test.calendar.refuseDeletes = true;
    await test.approve(newPlan);
    await test.drain.kick();
    test.advanceDay();
    const replacing = await test.replacing();
    expect(replacing).toMatchObject({ cleanup: "failed" });
    expect(replacing?.staysToday.every((entry) => entry.dateKey === test.today())).toBe(true);
    const removed = new Set(replacing?.removes.map((entry) => entry.planWorkoutId));
    expect(replacing?.staysToday.filter((entry) => removed.has(entry.planWorkoutId))).toEqual([]);
    test.calendar.refuseDeletes = false;
    await test.retry();
    expect(await test.cleanup(oldPlan)).toMatchObject({ status: "verified" });
  });

  it("never lets the new Plan onto intervals.icu beside the old one, wherever an Approve lands in a drain run", async () => {
    for (let point = 1; point < 400; point += 1) {
      let armed = false;
      let reads = 0;
      let reached: () => void = () => undefined;
      let release: () => void = () => undefined;
      const atPoint = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        release = resolve;
      });
      const test = await harness(closedOn, async () => {
        if (!armed) return;
        reads += 1;
        if (reads !== point) return;
        reached();
        await resume;
      });
      const oldPlan = await test.activate();
      await test.drain.kick();
      const newPlan = await test.activate(false);
      await test.drain.kick();
      let oldLaterAtFirstWrite: readonly number[] | undefined;
      test.calendar.beforeWrite = () => {
        oldLaterAtFirstWrite ??= test.datesOf(oldPlan).filter((dateKey) => dateKey > closedOn);
      };
      armed = true;
      const kicking = test.drain.kick();
      const paused = await Promise.race([atPoint.then(() => true), kicking.then(() => false)]);
      armed = false;
      const approving = test.approve(newPlan);
      release();
      await kicking;
      await approving;
      await test.drain.kick();
      await test.drain.kick();
      expect(
        oldLaterAtFirstWrite,
        `old Plan workouts left at the new Plan's first write, Approve after read ${point}`,
      ).toEqual([]);
      expect(test.sharedDays(), `days with both Plans, Approve after read ${point}`).toEqual([]);
      expect(test.writesOf(newPlan).length).toBeGreaterThan(0);
      if (!paused) break;
    }
  });

  it("sees the athlete's edits, moves and deletes made in intervals.icu during the hold", async () => {
    const { test, oldPlan, edited } = await mirroredPlanWithAnEdit();
    const newPlan = await test.activate(false);
    await test.drain.kick();
    const later = test.calendar.events
      .filter(
        (event) =>
          event.dateKey > closedOn &&
          event.id !== edited.id &&
          event.externalId?.startsWith(planMirrorExternalIdPrefix(oldPlan)) === true,
      )
      .sort((left, right) => left.dateKey - right.dateKey);
    const [changed, moved, deleted] = later;
    if (changed === undefined || moved === undefined || deleted === undefined)
      throw new Error("Expected three later old-Plan workouts");
    const before = await test.replacing();
    test.calendar.editByAthlete(changed.id, { name: "Changed during the hold" });
    test.calendar.editByAthlete(moved.id, { dateKey: addCivilDays(moved.dateKey, 1) });
    test.calendar.deleteByAthlete(deleted.id);
    test.advanceMs(300_000);
    await test.drain.kick();

    const replacing = await test.replacing();
    const offDays = replacing?.removes.map((entry) => entry.planWorkoutId) ?? [];
    const changes = replacing?.athleteChanges.map((entry) => entry.tick.eventId) ?? [];
    expect(replacing?.removes.length).toBe((before?.removes.length ?? 0) - 3);
    expect(test.calendar.deletes, "nothing is written during the hold").toEqual([]);
    expect(changes).toEqual(expect.arrayContaining([edited.id, changed.id, moved.id]));
    expect(changes).not.toContain(deleted.id);
    expect(offDays).toHaveLength(new Set(offDays).size);
    expect(
      replacing?.athleteChanges.find((entry) => entry.tick.eventId === moved.id)?.dateKey,
    ).toBe(addCivilDays(moved.dateKey, 1));

    await test.approve(newPlan);
    await test.drain.kick();
    expect(await test.cleanup(oldPlan)).toMatchObject({ status: "verified" });
    for (const kept of [edited, changed, moved]) {
      expect(test.calendar.events.some((event) => event.id === kept.id)).toBe(true);
    }
  });

  it("reads a held Plan back from intervals.icu at most every five minutes, and only when it has workouts there", async () => {
    const { test, oldPlan } = await mirroredPlanWithAnEdit();
    await test.activate(false);
    const heldLists = () =>
      test.calendar.lists.filter((list) => list.startDateKey === addCivilDays(closedOn, 1)).length;
    const before = heldLists();
    await test.drain.kick();
    expect(heldLists(), "the first run after Replace").toBe(before + 1);
    await test.drain.kick();
    await test.drain.kick();
    expect(heldLists(), "runs within five minutes").toBe(before + 1);
    test.advanceMs(300_000);
    await test.drain.kick();
    expect(heldLists(), "five minutes later").toBe(before + 2);
    expect(test.datesOf(oldPlan).length).toBeGreaterThan(1);

    const unsent = await harness();
    await unsent.activate(false);
    await unsent.activate(false);
    await unsent.drain.kick();
    expect(unsent.calendar.lists, "a held Plan with nothing on intervals.icu").toEqual([]);
  });

  it("counts and lists the old Plan's held workouts when the athlete ends the waiting Plan", async () => {
    const { test, oldPlan, edited, before } = await mirroredPlanWithAnEdit();
    const newPlan = await test.activate(false);
    await test.drain.kick();
    const details = await test.calendarOperations["plan.calendar"]({
      action: "plan-details",
      planId: newPlan,
    });
    if (details.status !== "plan-details") throw new Error("Expected Plan details");
    expect(details.ending.removes.map((entry) => entry.dateKey)).toEqual(
      before.filter((dateKey) => dateKey > closedOn && dateKey !== edited.dateKey),
    );
    expect(details.ending.athleteChanges.map((entry) => entry.tick.eventId)).toEqual([edited.id]);
    expect(details.ending.staysToday.map((entry) => entry.dateKey)).toEqual([closedOn]);
    const { active } = await test.creation["plan.list"]({});
    await test.calendarOperations["plan.calendar"]({
      action: "save-end-choice",
      planId: newPlan,
      commandId: "end-waiting-plan",
      ticked: [],
    });
    expect(
      await test.creation["plan.close"]({
        commandId: "end-waiting-plan",
        planId: newPlan,
        expectedVersion: active?.version ?? 0,
      }),
    ).toMatchObject({ status: "closed" });
    await test.drain.kick();
    expect(test.datesOf(oldPlan), "today's workout and the athlete's edit stay").toEqual([
      closedOn,
      edited.dateKey,
    ]);
  });

  it("removes the old Plan's changed workout too when the athlete ticks it in the waiting Plan's End", async () => {
    const { test, oldPlan, edited } = await mirroredPlanWithAnEdit();
    const newPlan = await test.activate(false);
    const details = await test.calendarOperations["plan.calendar"]({
      action: "plan-details",
      planId: newPlan,
    });
    if (details.status !== "plan-details") throw new Error("Expected Plan details");
    const { active } = await test.creation["plan.list"]({});
    await test.calendarOperations["plan.calendar"]({
      action: "save-end-choice",
      planId: newPlan,
      commandId: "end-ticked",
      ticked: details.ending.athleteChanges.map((entry) => entry.tick),
    });
    await test.creation["plan.close"]({
      commandId: "end-ticked",
      planId: newPlan,
      expectedVersion: active?.version ?? 0,
    });
    await test.drain.kick();
    expect(test.datesOf(oldPlan)).toEqual([closedOn]);
    expect(test.calendar.events.some((event) => event.id === edited.id)).toBe(false);
  });

  it("keeps the old Plan's changed workout when a different command ends the waiting Plan after an unconfirmed End", async () => {
    const { test, oldPlan, edited } = await mirroredPlanWithAnEdit();
    const newPlan = await test.activate(false);
    const details = await test.calendarOperations["plan.calendar"]({
      action: "plan-details",
      planId: newPlan,
    });
    if (details.status !== "plan-details") throw new Error("Expected Plan details");
    await test.calendarOperations["plan.calendar"]({
      action: "save-end-choice",
      planId: newPlan,
      commandId: "end-not-confirmed",
      ticked: details.ending.athleteChanges.map((entry) => entry.tick),
    });
    await test.end(newPlan);
    await test.drain.kick();
    expect(test.datesOf(oldPlan)).toEqual([closedOn, edited.dateKey]);
  });

  it("says Waiting for Approve for the held old Plan in the library and in its final details", async () => {
    const { test, oldPlan } = await mirroredPlanWithAnEdit();
    await test.activate(false);
    const library = await test.creation["plan.list"]({});
    const history = await test.creation["plan.history"]({ planId: oldPlan });
    expect(library.closed.find((plan) => plan.planId === oldPlan)?.calendar).toMatchObject({
      status: "waiting-for-approve",
    });
    expect(history?.plan.calendar).toMatchObject({ status: "waiting-for-approve" });
  });
});
