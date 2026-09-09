import { createCyclingPlanFtpAdapter } from "@enduragent/sport-cycling";
import { createHash } from "node:crypto";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { PlanCreationDraftSchema, type PlanCreationAnswerInput } from "@enduragent/coach-contract";
import { planMirrorExternalId } from "@enduragent/engine";
import {
  addCivilDays,
  createPlanCreationRepository,
  createPlanChangeRepository,
  createPlanReconciliationRepository,
  createPlanRepository,
} from "@enduragent/kernel/planning";
import { runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { createMemoryPlanCalendar } from "../../../apps/desktop/tests/helpers/plan-calendar-fake.js";
import { createPlanCalendarDrain } from "../src/plan-calendar-drain.js";
import { createPlanChangeOperations } from "../src/plan-change-operations.js";
import { createPlanCreationOperations } from "../src/plan-creation-operations.js";

async function harness() {
  const store = openSqliteStorage(":memory:");
  await runMigrations(store, MIGRATIONS);
  let sequence = 100;
  let today = 19980902;
  let connected = true;
  const calendar = createMemoryPlanCalendar();
  const logger = { warn: vi.fn() };
  const identity = {
    deviceId: async () => "calendar-drain-test-device",
    newUlid: () => String(++sequence).padStart(26, "0"),
    hlcStamp: () => ({ physicalMs: 904_694_400_000, counter: sequence }),
  };
  const dependencies = {
    store,
    identity,
    crypto: globalThis.crypto,
    todayDateKey: () => today,
    now: () => 904_694_400_000,
    calendarConnected: () => connected,
  };
  const creation = createPlanCreationOperations({
    ...dependencies,
    repository: createPlanCreationRepository(store),
    eventCandidates: { read: async () => [] },
    eventSources: { read: async () => [] },
    today: () => String(today).replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3"),
  });
  const changes = createPlanChangeOperations({
    eventSources: { read: async () => [] },
    ftp: createCyclingPlanFtpAdapter({
      readManual: async () => null,
      readIntervalsFtp: async () => null,
      readIntervalsEftp: async () => null,
      saveManual: async () => {},
      refreshIntervals: async () => {},
    }),
    logger: { warn: () => {} },
    ...dependencies,
    calendarConnected: async () => connected,
  });
  const drain = createPlanCalendarDrain({ ...dependencies, calendar, logger });
  onTestFinished(async () => {
    await drain.idle();
    await store.close();
  });
  const reconciliation = createPlanReconciliationRepository(store);
  const plans = createPlanRepository(store);
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
    if (preview.status !== "previewed" || preview.planCreation.draft === null)
      throw new Error("Expected Draft");
    const { active } = await creation["plan.list"]({});
    const result = await creation["plan_creation.activate"]({
      commandId: `activate-${++sequence}`,
      incumbent: active === null ? null : { planId: active.planId, version: active.version },
      creationId: card.creationId,
      expectedVersion: preview.planCreation.version,
    });
    return { ...result, draft: preview.planCreation.draft };
  };
  const previewWorkoutChange = async (
    planId: string,
    workoutId: string,
    patch: { date?: string; name?: string },
  ) => {
    const plan = (await plans.listPlans()).find((row) => row.planId === planId);
    if (plan === undefined) throw new Error("Expected Plan");
    const workout = (await plans.readWorkouts(planId)).find((row) => row.id === workoutId);
    if (workout === undefined) throw new Error("Expected Workout");
    const structure: unknown = JSON.parse(workout.structureJson);
    if (
      structure === null ||
      typeof structure !== "object" ||
      !("id" in structure) ||
      typeof structure.id !== "string"
    )
      throw new Error("Expected Draft Workout id");
    const draftWorkoutId = structure.id;
    const repository = createPlanChangeRepository(store, {
      newId: () => identity.newUlid(),
      sha256: (text) => createHash("sha256").update(text).digest("hex"),
    });
    const preview = await repository.preview({
      command: {
        commandId: `workout-preview-${++sequence}`,
        requestDigest: "a".repeat(64),
        nowMs: 904_694_400_000,
        deviceId: "calendar-drain-test-device",
        hlcPhysicalMs: 904_694_400_000,
        hlcCounter: sequence,
      },
      planId,
      expectedVersion: plan.version,
      nowMs: 904_694_400_000,
      changeId: identity.newUlid(),
      build({ snapshotJson }) {
        const snapshot = PlanCreationDraftSchema.parse(JSON.parse(snapshotJson));
        const before = snapshot.weeks
          .flatMap((week) => week.workouts)
          .find((row) => row.id === draftWorkoutId);
        if (before === undefined) throw new Error("Expected Workout");
        const after = { ...before, ...patch };
        const weeks = snapshot.weeks.map((week) => ({
          number: week.number,
          minutes: week.workouts.reduce((sum, row) => sum + row.minutes, 0),
        }));
        const totals = { plan: weeks.reduce((sum, week) => sum + week.minutes, 0), weeks };
        for (const week of snapshot.weeks) {
          week.workouts = week.workouts.map((row) => (row.id === draftWorkoutId ? after : row));
        }
        const intent: Record<string, string | null> =
          patch.date === undefined
            ? { kind: "rename", name: after.name }
            : { kind: "move", date: after.date };
        return {
          afterSnapshotJson: JSON.stringify(snapshot),
          envelope: {
            title: "Update Workout",
            intent,
            diff: [{ workoutId: draftWorkoutId, before, after }],
            totals: { before: totals, after: totals },
            supersedes: null,
            premises: [],
            confidence: "Confirmed update",
          },
        };
      },
    });
    if (preview.status !== "previewed") throw new Error("Expected Change");
    return async () => {
      expect(
        await changes["plan_change.apply"]({
          commandId: `workout-apply-${++sequence}`,
          planId,
          changeId: preview.change.changeId,
          expectedVersion: plan.version,
          decision: "apply",
        }),
      ).toMatchObject({ status: "applied" });
    };
  };
  return {
    store,
    creation,
    changes,
    drain,
    calendar,
    logger,
    identity,
    reconciliation,
    plans,
    activate,
    previewWorkoutChange,
    today: () => today,
    advanceDay: () => {
      today = addCivilDays(today, 1);
    },
    disconnect: () => {
      connected = false;
    },
    connect: () => {
      connected = true;
    },
  };
}

describe("Plan calendar drain", () => {
  it("resumes a recently running job only when a kick reclaims it", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    const pending = await test.reconciliation.readLatestJob(planId, "mirror");
    if (pending === undefined) throw new Error("Expected mirror job");
    await test.reconciliation.beginAttempt(pending.id, 904_694_400_000);

    await test.drain.kick();
    expect(await test.reconciliation.readJob(pending.id)).toMatchObject({
      status: "running",
      attemptCount: 1,
      resumedCount: 0,
    });
    expect(test.calendar.events).toEqual([]);
    expect(test.calendar.lists).toEqual([]);

    await test.drain.kick({ reclaimRunning: true });
    expect(await test.reconciliation.readJob(pending.id)).toMatchObject({
      status: "verified",
      attemptCount: 2,
      resumedCount: 1,
    });
    const selected = (await test.plans.readWorkouts(planId)).filter(
      (workout) =>
        workout.dateKey >= test.today() && workout.dateKey <= addCivilDays(test.today(), 6),
    );
    expect(selected.length).toBeGreaterThan(0);
    expect(test.calendar.events.map((event) => event.externalId).sort()).toEqual(
      selected.map((workout) => planMirrorExternalId(planId, workout.id)).sort(),
    );
    expect(test.logger.warn).not.toHaveBeenCalled();
  });

  it("mirrors and verifies the seven-day window after activation", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    const pending = await test.reconciliation.readLatestJob(planId, "mirror");
    expect(pending).toMatchObject({
      status: "pending",
      windowStartDateKey: 19980902,
      windowEndDateKey: 19980908,
    });
    expect(test.calendar.events).toEqual([]);
    await test.drain.kick();
    const selected = (await test.plans.readWorkouts(planId)).filter(
      (workout) =>
        workout.dateKey >= test.today() && workout.dateKey <= addCivilDays(test.today(), 6),
    );
    expect(selected.length).toBeGreaterThan(0);
    expect(test.calendar.events.map((event) => event.externalId).sort()).toEqual(
      selected.map((workout) => planMirrorExternalId(planId, workout.id)).sort(),
    );
    expect(await test.reconciliation.readLatestJob(planId, "mirror")).toMatchObject({
      id: pending?.id,
      status: "verified",
      attemptCount: 1,
    });
    expect(
      test.calendar.lists.every(
        (window) => window.startDateKey >= 19980902 && window.endDateKey <= 19980908,
      ),
    ).toBe(true);
    expect(test.logger.warn).not.toHaveBeenCalled();
    await expect(test.drain.idle()).resolves.toBeUndefined();
  });

  it("replaces an incumbent from tomorrow while retaining its event today", async () => {
    const test = await harness();
    const incumbent = await test.activate();
    await test.drain.kick();
    const oldToday = test.calendar.events.filter((event) => event.dateKey === test.today());
    expect(oldToday.length).toBeGreaterThan(0);
    const replacement = await test.activate();
    expect(replacement.closedPlanId).toBe(incumbent.planId);
    expect(await test.reconciliation.readLatestJob(incumbent.planId, "cleanup")).toMatchObject({
      status: "pending",
      windowStartDateKey: addCivilDays(test.today(), 1),
      windowEndDateKey: Number(incumbent.draft.end.replaceAll("-", "")),
    });
    const newWorkouts = await test.plans.readWorkouts(replacement.planId);
    expect(newWorkouts.some((workout) => workout.dateKey === test.today())).toBe(true);
    await test.drain.kick();
    expect(test.calendar.events.filter((event) => event.dateKey === test.today())).toEqual(
      oldToday,
    );
    const expected = newWorkouts.filter(
      (workout) =>
        workout.dateKey > test.today() && workout.dateKey <= addCivilDays(test.today(), 6),
    );
    expect(
      test.calendar.events
        .filter((event) => event.dateKey > test.today())
        .map((event) => event.externalId)
        .sort(),
    ).toEqual(
      expected.map((workout) => planMirrorExternalId(replacement.planId, workout.id)).sort(),
    );
    expect(await test.reconciliation.readLatestJob(replacement.planId, "mirror")).toMatchObject({
      status: "verified",
    });
    expect(await test.reconciliation.readLatestJob(incumbent.planId, "cleanup")).toMatchObject({
      status: "verified",
    });
  });

  it("keeps today with the incumbent after verified cleanup and a same-day Change", async () => {
    const test = await harness();
    const incumbent = await test.activate();
    await test.drain.kick();
    const oldToday = structuredClone(
      test.calendar.events.filter((event) => event.dateKey === test.today()),
    );
    expect(oldToday.length).toBeGreaterThan(0);
    const replacement = await test.activate();
    await test.drain.kick();
    expect(await test.reconciliation.readLatestJob(incumbent.planId, "cleanup")).toMatchObject({
      status: "verified",
    });
    const preview = await test.changes["plan_change.preview"]({
      commandId: "change-after-cleanup",
      planId: replacement.planId,
      expectedVersion: 1,
      intent: { kind: "longest-workout", minutes: 30 },
    });
    if (preview.status !== "previewed") throw new Error("Expected Change");
    expect(
      await test.changes["plan_change.apply"]({
        commandId: "apply-after-cleanup",
        planId: replacement.planId,
        changeId: preview.change.changeId,
        expectedVersion: 1,
        decision: "apply",
      }),
    ).toMatchObject({ status: "applied" });
    await test.drain.kick();
    expect(test.calendar.events.filter((event) => event.dateKey === test.today())).toEqual(
      oldToday,
    );
    const expected = (await test.plans.readWorkouts(replacement.planId)).filter(
      (workout) =>
        workout.dateKey > test.today() && workout.dateKey <= addCivilDays(test.today(), 6),
    );
    expect(
      test.calendar.events
        .filter((event) => event.dateKey > test.today())
        .map((event) => event.externalId)
        .sort(),
    ).toEqual(
      expected.map((workout) => planMirrorExternalId(replacement.planId, workout.id)).sort(),
    );
    expect(await test.reconciliation.readLatestJob(replacement.planId, "mirror")).toMatchObject({
      status: "verified",
      attemptCount: 2,
    });
    expect(test.logger.warn).not.toHaveBeenCalled();
  });

  it("keeps exhausted jobs outside the retry budget on every kick", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    for (let attempt = 0; attempt < 5; attempt++) {
      test.calendar.failNextList = true;
      await test.drain.kick();
    }
    expect(await test.reconciliation.readLatestJob(planId, "mirror")).toMatchObject({
      status: "failed",
      failureCount: 5,
      attemptCount: 5,
    });
    const listCount = test.calendar.lists.length;
    await test.drain.kick();
    expect(test.calendar.lists).toHaveLength(listCount);
    await test.drain.kick();
    expect(await test.reconciliation.readLatestJob(planId, "mirror")).toMatchObject({
      status: "failed",
      failureCount: 5,
      attemptCount: 5,
    });
    expect(test.calendar.lists).toHaveLength(listCount);
    expect(test.calendar.events).toEqual([]);
  });

  it("deletes a moved Workout's old event and verifies the rest after a Change outside the horizon", async () => {
    const test = await harness();
    const { planId, draft } = await test.activate();
    await test.drain.kick();
    const original = await test.reconciliation.readLatestJob(planId, "mirror");
    const workout = (await test.plans.readWorkouts(planId)).find(
      (row) => row.dateKey === test.today(),
    );
    if (workout === undefined || original === undefined)
      throw new Error("Expected mirrored Workout");
    const oldEvent = test.calendar.events.find(
      (event) => event.externalId === planMirrorExternalId(planId, workout.id),
    );
    if (oldEvent === undefined) throw new Error("Expected old event");
    const before = draft.weeks
      .flatMap((week) => week.workouts)
      .find((row) => row.date === "1998-09-02");
    if (before === undefined) throw new Error("Expected Draft Workout");
    const after = { ...before, date: "1998-09-09" };
    const repository = createPlanChangeRepository(test.store, {
      newId: () => test.identity.newUlid(),
      sha256: (text) => createHash("sha256").update(text).digest("hex"),
    });
    const weeks = draft.weeks.map((week) => ({
      number: week.number,
      minutes: week.workouts.reduce((sum, row) => sum + row.minutes, 0),
    }));
    const totals = { plan: weeks.reduce((sum, week) => sum + week.minutes, 0), weeks };
    const preview = await repository.preview({
      command: {
        commandId: "move-preview",
        requestDigest: "a".repeat(64),
        nowMs: 904_694_400_000,
        deviceId: "calendar-drain-test-device",
        hlcPhysicalMs: 904_694_400_000,
        hlcCounter: 1,
      },
      planId,
      expectedVersion: 1,
      nowMs: 904_694_400_000,
      changeId: test.identity.newUlid(),
      build({ snapshotJson }) {
        const snapshot = PlanCreationDraftSchema.parse(JSON.parse(snapshotJson));
        for (const week of snapshot.weeks) {
          week.workouts = week.workouts.map((row) => (row.id === before.id ? after : row));
        }
        return {
          afterSnapshotJson: JSON.stringify(snapshot),
          envelope: {
            title: "Move Workout",
            intent: { kind: "move", date: after.date },
            diff: [{ workoutId: before.id, before, after }],
            totals: { before: totals, after: totals },
            supersedes: null,
            premises: [],
            confidence: "Confirmed move",
          },
        };
      },
    });
    if (preview.status !== "previewed") throw new Error("Expected Change");
    expect(
      await test.changes["plan_change.apply"]({
        commandId: "move-apply",
        planId,
        changeId: preview.change.changeId,
        expectedVersion: 1,
        decision: "apply",
      }),
    ).toMatchObject({ status: "applied" });
    expect(
      (await test.plans.readWorkouts(planId)).find((row) => row.id === workout.id)?.dateKey,
    ).toBe(19980909);
    expect(
      (await test.reconciliation.readItems(original.id)).some(
        (item) => item.operation === "create" && item.planWorkoutId === workout.id,
      ),
    ).toBe(false);
    await test.drain.kick();
    expect(test.calendar.deletes).toEqual([oldEvent.id]);
    const remaining = (await test.plans.readWorkouts(planId)).filter(
      (row) => row.dateKey >= test.today() && row.dateKey <= addCivilDays(test.today(), 6),
    );
    expect(test.calendar.events.map((event) => event.externalId).sort()).toEqual(
      remaining.map((row) => planMirrorExternalId(planId, row.id)).sort(),
    );
    expect(await test.reconciliation.readJob(original.id)).toMatchObject({
      status: "verified",
      attemptCount: 2,
    });
    expect(test.logger.warn).not.toHaveBeenCalled();
  });

  it("keeps the restored event after a Workout moves outside and back inside the window", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    await test.drain.kick();
    const workout = (await test.plans.readWorkouts(planId)).find(
      (row) => row.dateKey === test.today(),
    );
    const job = await test.reconciliation.readLatestJob(planId, "mirror");
    if (workout === undefined || job === undefined) throw new Error("Expected mirrored Workout");
    const event = test.calendar.events.find(
      (row) => row.externalId === planMirrorExternalId(planId, workout.id),
    );
    if (event === undefined) throw new Error("Expected event");
    await (
      await test.previewWorkoutChange(planId, workout.id, { date: "1998-09-09" })
    )();
    vi.spyOn(test.calendar, "deleteEvent").mockRejectedValueOnce(new Error("unavailable"));
    await test.drain.kick();
    expect(await test.reconciliation.readJob(job.id)).toMatchObject({
      status: "failed",
      failureCount: 1,
    });
    expect(
      (await test.reconciliation.readItems(job.id)).some((item) => item.operation === "delete"),
    ).toBe(true);
    await (
      await test.previewWorkoutChange(planId, workout.id, { date: "1998-09-02" })
    )();
    expect(
      (await test.reconciliation.readItems(job.id)).some((item) => item.operation === "delete"),
    ).toBe(false);
    await test.drain.kick();
    expect(test.calendar.events).toContainEqual(event);
    expect(test.calendar.deleteEvent).toHaveBeenCalledTimes(1);
    expect(await test.reconciliation.readJob(job.id)).toMatchObject({
      status: "verified",
      attemptCount: 3,
    });
    expect(test.logger.warn).not.toHaveBeenCalled();
  });

  it("retires a retained create moved to excluded today and removes its old event", async () => {
    const test = await harness();
    await test.activate();
    await test.drain.kick();
    const { planId } = await test.activate();
    await test.drain.kick();
    const workout = (await test.plans.readWorkouts(planId)).find(
      (row) => row.dateKey > test.today() && row.dateKey <= addCivilDays(test.today(), 6),
    );
    const job = await test.reconciliation.readLatestJob(planId, "mirror");
    if (workout === undefined || job === undefined) throw new Error("Expected mirrored Workout");
    const externalId = planMirrorExternalId(planId, workout.id);
    expect(test.calendar.events.some((row) => row.externalId === externalId)).toBe(true);
    await (
      await test.previewWorkoutChange(planId, workout.id, { date: "1998-09-02" })
    )();
    await test.drain.kick();
    expect(await test.reconciliation.readJob(job.id)).toMatchObject({
      status: "verified",
      failureCount: 0,
    });
    expect(test.calendar.events.some((row) => row.externalId === externalId)).toBe(false);
    expect(
      (await test.reconciliation.readItems(job.id)).filter(
        (item) => item.externalId === externalId && item.operation === "create",
      ),
    ).toEqual([]);
    expect(test.logger.warn).not.toHaveBeenCalled();
  });

  it.each(["before-attempt", "during-list"])(
    "reruns a mirror when a Change commits after its Workout snapshot: %s",
    async (timing) => {
      const test = await harness();
      const { planId } = await test.activate();
      const workout = (await test.plans.readWorkouts(planId)).find(
        (row) => row.dateKey === test.today(),
      );
      if (workout === undefined) throw new Error("Expected Workout");
      const apply = await test.previewWorkoutChange(planId, workout.id, {
        name: "Changed Workout",
      });
      if (timing === "before-attempt") {
        const all = test.store.all.bind(test.store);
        let applied = false;
        vi.spyOn(test.store, "all").mockImplementation(async (sql, params) => {
          const rows = await all(sql, params);
          if (
            !applied &&
            sql === "SELECT * FROM plan_workout WHERE plan_id = ? ORDER BY date_key, id"
          ) {
            applied = true;
            await apply();
          }
          return rows;
        });
      } else {
        const listEvents = test.calendar.listEvents.bind(test.calendar);
        vi.spyOn(test.calendar, "listEvents").mockImplementationOnce(async (input) => {
          await apply();
          await test.drain.kick();
          return listEvents(input);
        });
      }
      await test.drain.kick();
      await test.drain.idle();
      expect(
        test.calendar.events.find(
          (event) => event.externalId === planMirrorExternalId(planId, workout.id),
        ),
      ).toMatchObject({ name: "Changed Workout" });
      expect(await test.reconciliation.readLatestJob(planId, "mirror")).toMatchObject({
        status: "verified",
        attemptCount: 2,
      });
    },
  );

  it("persists a list failure for the run and verifies on a later kick", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    test.calendar.failNextList = true;
    await test.drain.kick();
    expect(await test.reconciliation.readLatestJob(planId, "mirror")).toMatchObject({
      status: "failed",
      lastErrorCode: "calendar-list-failed",
      attemptCount: 1,
      failureCount: 1,
    });
    expect(test.calendar.events).toEqual([]);
    await test.drain.kick();
    expect(await test.reconciliation.readLatestJob(planId, "mirror")).toMatchObject({
      status: "verified",
      attemptCount: 2,
      failureCount: 1,
    });
    expect(test.calendar.events.length).toBeGreaterThan(0);
  });

  it("reopens the same window after a Change and updates retained external ids without duplicates", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    await test.drain.kick();
    const original = await test.reconciliation.readLatestJob(planId, "mirror");
    const before = structuredClone(test.calendar.events);
    const preview = await test.changes["plan_change.preview"]({
      commandId: "change-preview",
      planId,
      expectedVersion: 1,
      intent: { kind: "longest-workout", minutes: 30 },
    });
    if (preview.status !== "previewed") throw new Error(`Expected Change: ${preview.reason}`);
    expect(
      await test.changes["plan_change.apply"]({
        commandId: "change-apply",
        planId,
        changeId: preview.change.changeId,
        expectedVersion: 1,
        decision: "apply",
      }),
    ).toMatchObject({ status: "applied" });
    expect(await test.reconciliation.readLatestJob(planId, "mirror")).toMatchObject({
      id: original?.id,
      status: "pending",
    });
    await test.drain.kick();
    expect(await test.reconciliation.readLatestJob(planId, "mirror")).toMatchObject({
      id: original?.id,
      status: "verified",
      attemptCount: 2,
    });
    expect(test.calendar.updates.length).toBeGreaterThan(0);
    expect(test.calendar.events.map((event) => [event.id, event.externalId])).toEqual(
      before.map((event) => [event.id, event.externalId]),
    );
    expect(
      test.calendar.events.some((event, index) => event.durationS !== before[index]?.durationS),
    ).toBe(true);
    expect(new Set(test.calendar.events.map((event) => event.externalId)).size).toBe(
      test.calendar.events.length,
    );
    expect(test.calendar.creates).toHaveLength(before.length);
  });

  it.each([false, true])(
    "only verifies yesterday's items and creates today's rollover window with a missing event: %s",
    async (missingEvent) => {
      const test = await harness();
      const { planId } = await test.activate();
      await test.drain.kick();
      const previous = await test.reconciliation.readLatestJob(planId, "mirror");
      if (previous === undefined) throw new Error("Expected mirror job");
      await test.reconciliation.beginAttempt(previous.id, 904_694_400_000);
      await test.reconciliation.failJob(
        previous.id,
        "calendar-verification-failed",
        904_694_400_000,
      );
      const yesterday = test.calendar.events.find((event) => event.dateKey === test.today());
      if (yesterday === undefined) throw new Error("Expected today's event");
      if (missingEvent) test.calendar.events.splice(test.calendar.events.indexOf(yesterday), 1);
      test.calendar.lists.length = 0;
      test.calendar.creates.length = 0;
      test.advanceDay();
      await test.drain.kick();
      expect(test.calendar.lists[0]).toEqual({ startDateKey: 19980902, endDateKey: 19980908 });
      expect(await test.reconciliation.readJob(previous.id)).toMatchObject({
        status: missingEvent ? "failed" : "verified",
        attemptCount: 3,
        lastErrorCode: missingEvent ? "calendar-verification-failed" : null,
      });
      expect(test.calendar.events.some((event) => event.externalId === yesterday.externalId)).toBe(
        !missingEvent,
      );
      expect(test.calendar.creates.every((event) => event.dateKey >= test.today())).toBe(true);
      expect(test.calendar.updates).toEqual([]);
      expect(await test.reconciliation.readLatestJobByWindow(planId, "mirror")).toMatchObject({
        status: "verified",
        windowStartDateKey: 19980903,
        windowEndDateKey: 19980909,
      });
    },
  );

  it("retires an empty older window without sending it to the calendar", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    const previous = await test.reconciliation.readLatestJob(planId, "mirror");
    if (previous === undefined) throw new Error("Expected mirror job");
    test.advanceDay();
    await test.drain.kick();
    expect(await test.reconciliation.readJob(previous.id)).toMatchObject({
      status: "verified",
      attemptCount: 1,
    });
    expect(test.calendar.lists.every((window) => window.startDateKey >= test.today())).toBe(true);
    expect(await test.reconciliation.readLatestJobByWindow(planId, "mirror")).toMatchObject({
      status: "verified",
      windowStartDateKey: test.today(),
    });
  });

  it("does nothing when the calendar is disconnected", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    test.disconnect();
    test.advanceDay();
    await test.drain.kick();
    await test.drain.idle();
    expect(await test.reconciliation.readLatestJobByWindow(planId, "mirror")).toMatchObject({
      status: "pending",
      attemptCount: 0,
      windowStartDateKey: 19980902,
    });
    expect(test.calendar.lists).toEqual([]);
    expect(test.calendar.events).toEqual([]);
  });

  it("remembers a reclaim request made while disconnected until the next connected kick", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    const pending = await test.reconciliation.readLatestJob(planId, "mirror");
    if (pending === undefined) throw new Error("Expected mirror job");
    await test.reconciliation.beginAttempt(pending.id, 904_694_400_000);
    test.disconnect();
    await test.drain.kick({ reclaimRunning: true });
    await test.drain.idle();
    expect(await test.reconciliation.readJob(pending.id)).toMatchObject({
      status: "running",
      attemptCount: 1,
    });
    test.connect();
    await test.drain.kick();
    expect(await test.reconciliation.readJob(pending.id)).toMatchObject({
      status: "verified",
      attemptCount: 2,
      resumedCount: 1,
    });
    expect(test.logger.warn).not.toHaveBeenCalled();
  });

  it("serializes concurrent kicks into one run and one rerun and waits for both when idle", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    test.calendar.failNextList = true;
    test.calendar.delayMs = 10;
    const reads = vi.spyOn(test.store, "all");
    let complete = false;
    const running = test.drain.kick().then(() => {
      complete = true;
    });
    await Promise.all([test.drain.kick(), test.drain.kick()]);
    expect(complete).toBe(false);
    let idle = false;
    const settled = test.drain.idle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);
    await settled;
    await running;
    expect(idle).toBe(true);
    expect(await test.reconciliation.readLatestJob(planId, "mirror")).toMatchObject({
      status: "verified",
      attemptCount: 2,
      resumedCount: 0,
    });
    expect(
      reads.mock.calls.filter(([sql]) => sql.includes("status IN ('pending','retrying')")),
    ).toHaveLength(2);
  });

  it("cleans a closed Plan from tomorrow and leaves today", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    await test.drain.kick();
    const todayEvents = test.calendar.events.filter((event) => event.dateKey === test.today());
    expect(todayEvents.length).toBeGreaterThan(0);
    expect(
      await test.creation["plan.close"]({ commandId: "close", planId, expectedVersion: 1 }),
    ).toMatchObject({ status: "closed" });
    await test.drain.kick();
    expect(test.calendar.events).toEqual(todayEvents);
    expect(await test.reconciliation.readLatestJob(planId, "cleanup")).toMatchObject({
      status: "verified",
      windowStartDateKey: addCivilDays(test.today(), 1),
    });
  });

  it("skips a Plan closed after runnable jobs were listed", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    const current = await test.reconciliation.readLatestJob(planId, "mirror");
    if (current === undefined) throw new Error("Expected mirror job");
    const all = test.store.all.bind(test.store);
    let closed = false;
    vi.spyOn(test.store, "all").mockImplementation(async (sql, params) => {
      const rows = await all(sql, params);
      if (
        !closed &&
        sql.includes("FROM plan_reconciliation_job") &&
        sql.includes("ORDER BY window_start_date_key ASC")
      ) {
        closed = true;
        expect(rows.some((row) => row.id === current.id)).toBe(true);
        await test.creation["plan.close"]({
          commandId: "close-after-list",
          planId,
          expectedVersion: 1,
        });
      }
      return rows;
    });
    await test.drain.kick();
    expect(closed).toBe(true);
    expect(await test.reconciliation.readJob(current.id)).toMatchObject({
      status: "pending",
      attemptCount: 0,
    });
    expect(test.calendar.events).toEqual([]);
    expect(test.calendar.lists).toEqual([]);
    expect(test.logger.warn).not.toHaveBeenCalled();
  });

  it("skips inactive Plans' mirror jobs and future windows", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    const current = await test.reconciliation.readLatestJob(planId, "mirror");
    const future = await test.reconciliation.createOrGetJob({
      id: test.identity.newUlid(),
      planId,
      kind: "mirror",
      windowStartDateKey: addCivilDays(test.today(), 1),
      windowEndDateKey: addCivilDays(test.today(), 7),
      createdAtMs: 904_694_400_000,
    });
    await test.drain.kick();
    expect(await test.reconciliation.readJob(future.id)).toMatchObject({
      status: "pending",
      attemptCount: 0,
    });
    if (current === undefined) throw new Error("Expected mirror job");
    await test.reconciliation.beginAttempt(current.id, 904_694_400_000);
    await test.reconciliation.failJob(current.id, "calendar-list-failed", 904_694_400_000);
    await test.creation["plan.close"]({ commandId: "close", planId, expectedVersion: 1 });
    await test.drain.kick();
    expect(await test.reconciliation.readJob(current.id)).toMatchObject({
      status: "failed",
      attemptCount: 2,
    });
    expect(await test.reconciliation.readJob(future.id)).toMatchObject({
      status: "pending",
      attemptCount: 0,
    });
  });
});
