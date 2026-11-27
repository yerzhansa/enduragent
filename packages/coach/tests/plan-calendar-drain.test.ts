import {
  PlanCalendarRpcParamsSchema,
  PlanCalendarRpcResultSchema,
} from "@enduragent/coach-contract";
import { createCyclingPlanFtpAdapter } from "@enduragent/sport-cycling";
import { createHash } from "node:crypto";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { PlanCreationDraftSchema, type PlanCreationAnswerInput } from "@enduragent/coach-contract";
import { planMirrorExternalId } from "@enduragent/engine";
import { trainingWeek } from "@enduragent/engine/calendar";
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
import { createLegacyPlanRepository } from "@enduragent/kernel-node/planning";
import { createMemoryPlanCalendar } from "../../../apps/desktop/tests/helpers/plan-calendar-fake.js";
import { createPlanCalendarDrain } from "../src/plan-calendar-drain.js";
import { createPlanChangeOperations } from "../src/plan-change-operations.js";
import { createPlanCalendarOperations } from "../src/plan-calendar-operations.js";
import { createPlanCreationOperations } from "../src/plan-creation-operations.js";

async function harness() {
  const store = openSqliteStorage(":memory:");
  await runMigrations(store, MIGRATIONS);
  let sequence = 100;
  let today = 19980902;
  let connected = true;
  let nowMs = 904_694_400_000;
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
  const changed = vi.fn(async (): Promise<void> => undefined);
  const calendarOperations = createPlanCalendarOperations({
    store,
    calendar,
    identity,
    applyChange: (request) => changes["plan_change.apply"](request),
    todayDateKey: () => today,
    now: () => nowMs,
    calendarConnected: () => connected,
    dateKeyOfMs: (ms) => Number(new Date(ms).toISOString().slice(0, 10).replaceAll("-", "")),
    changed,
  });
  const approve = (planId: string, week?: number) =>
    calendarOperations["plan.calendar"]({
      action: "approve-weeks",
      planId,
      scope: week === undefined ? { kind: "first-weeks" } : { kind: "week", week },
    });
  const legacyPlans = createLegacyPlanRepository(store);
  const expectedOnIcu = async (planId: string, weeks: readonly number[]) => {
    const plan = await legacyPlans.read(planId);
    if (plan === undefined) throw new Error("Expected Plan");
    const ranges = weeks.map((week) => trainingWeek(plan, week));
    return (await plans.readWorkouts(planId))
      .filter(
        (workout) =>
          workout.origin === "coach" &&
          workout.dateKey >= today &&
          ranges.some(
            (range) => workout.dateKey >= range.startDateKey && workout.dateKey <= range.endDateKey,
          ),
      )
      .map((workout) => planMirrorExternalId(planId, workout.id))
      .sort();
  };
  const onIcu = (planId: string) =>
    calendar.events
      .filter((event) => event.externalId?.includes(planId) === true)
      .map((event) => event.externalId)
      .sort();
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
    legacyPlans,
    calendarOperations,
    changed,
    approve,
    expectedOnIcu,
    onIcu,
    activate,
    previewWorkoutChange,
    today: () => today,
    advanceDay: () => {
      today = addCivilDays(today, 1);
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
  };
}

async function choose(
  test: Awaited<ReturnType<typeof harness>>,
  action: "keep-change" | "put-back",
  card: { readonly planId: string; readonly planWorkoutId: string },
  basis?: string,
) {
  const seen =
    basis ??
    (await (async () => {
      const detail = await test.calendarOperations["plan.calendar"]({
        action: "change-detail",
        ...card,
      });
      return detail.status === "change-detail" ? detail.basis : "absent";
    })());
  return test.calendarOperations["plan.calendar"]({ action, ...card, basis: seen });
}

describe("Plan calendar drain", () => {
  it("sends this Training Week and next by itself for a Plan activated before Approve existed", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    await test.store.run("DELETE FROM plan_week_delivery WHERE plan_id=?", [planId]);
    await test.drain.kick();
    expect(test.onIcu(planId)).toEqual(await test.expectedOnIcu(planId, [1, 2]));
    expect(await test.approve(planId)).toEqual({ status: "refused", reason: "already-approved" });
  });

  it("sends nothing after activation until the first Approve, then this Training Week and next", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    expect(
      await test.store.get("SELECT state_kind FROM plan_week_delivery WHERE plan_id=?", [planId]),
    ).toEqual({ state_kind: "waiting-for-first-approve" });
    await test.drain.kick();
    expect(test.calendar.creates).toEqual([]);
    expect(test.changed).not.toHaveBeenCalled();
    expect(await test.approve(planId)).toEqual({ status: "approved", weeks: [1, 2] });
    expect(test.changed).toHaveBeenCalledOnce();
    await test.drain.kick();
    const expected = await test.expectedOnIcu(planId, [1, 2]);
    expect(expected.length).toBeGreaterThan(0);
    expect(test.onIcu(planId)).toEqual(expected);
    expect(test.logger.warn).not.toHaveBeenCalled();
  });

  it("leaves a mirrored week alone on later runs, though intervals.icu recounts its length", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    await test.store.run(
      "UPDATE plan_workout SET structure_json=json_set(structure_json,'$.description',?) WHERE plan_id=?",
      ["- 10m 45-65%", planId],
    );
    await test.approve(planId);
    await test.drain.kick();
    const creates = test.calendar.creates.length;
    expect(creates).toBeGreaterThan(0);
    expect(
      test.calendar.events.every(
        (event) =>
          event.durationS === null || event.durationS === undefined || event.durationS % 60 === 1,
      ),
    ).toBe(true);
    await test.drain.kick();
    await test.drain.kick();
    expect(test.calendar.creates).toHaveLength(creates);
    expect(test.calendar.updates).toEqual([]);
    expect(test.calendar.deletes).toEqual([]);
  });

  it("keeps an edit made in intervals.icu and does not send the Plan's version over it", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    await test.approve(planId);
    await test.drain.kick();
    const event = test.calendar.events[0];
    if (event === undefined) throw new Error("Expected an event");
    test.calendar.editByAthlete(event.id, { name: "My own ride" });
    await test.drain.kick();
    await test.drain.kick();
    expect(test.calendar.updates).toEqual([]);
    expect(test.calendar.events.find((row) => row.id === event.id)?.name).toBe("My own ride");
    expect(
      await test.store.get("SELECT state_kind FROM plan_icu_copy WHERE plan_workout_id=?", [
        event.externalId?.split(":").at(-1) ?? "",
      ]),
    ).toEqual({ state_kind: "changed-in-icu" });
  });

  it("sends a coach change with one update, and none over an edit seen in the same run", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    await test.approve(planId);
    await test.drain.kick();
    const [first, second] = (await test.plans.readWorkouts(planId)).filter((workout) =>
      test.onIcu(planId).includes(planMirrorExternalId(planId, workout.id)),
    );
    if (first === undefined || second === undefined) throw new Error("Expected two Workouts");
    const firstEvent = test.calendar.events.find(
      (event) => event.externalId === planMirrorExternalId(planId, first.id),
    );
    if (firstEvent === undefined) throw new Error("Expected an event");
    test.calendar.editByAthlete(firstEvent.id, { name: "Changed there" });
    const applyFirst = await test.previewWorkoutChange(planId, first.id, { name: "Coach rename" });
    await applyFirst();
    await test.drain.kick();
    expect(test.calendar.updates).toEqual([]);
    expect(test.calendar.events.find((event) => event.id === firstEvent.id)?.name).toBe(
      "Changed there",
    );
    const applySecond = await test.previewWorkoutChange(planId, second.id, {
      name: "Second rename",
    });
    await applySecond();
    await test.drain.kick();
    expect(test.calendar.updates.map((update) => update.name)).toEqual(["Second rename"]);
  });

  it("sends the next Training Week on its send day, and every due week after a long gap", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    await test.approve(planId);
    await test.drain.kick();
    const plan = await test.legacyPlans.read(planId);
    if (plan === undefined) throw new Error("Expected Plan");
    while (test.today() < trainingWeek(plan, 3).startDateKey) test.advanceDay();
    await test.drain.kick();
    expect(test.onIcu(planId)).toEqual(
      expect.arrayContaining(await test.expectedOnIcu(planId, [3, 4])),
    );
    expect(test.logger.warn).not.toHaveBeenCalled();
  });

  it("waits for each later week's Approve when Approve each week is on", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    await test.calendarOperations["plan.calendar"]({
      action: "save-settings",
      weekDelivery: "approve-each-week",
    });
    await test.approve(planId);
    await test.drain.kick();
    const plan = await test.legacyPlans.read(planId);
    if (plan === undefined) throw new Error("Expected Plan");
    while (test.today() < trainingWeek(plan, 2).startDateKey) test.advanceDay();
    await test.drain.kick();
    const weekThree = await test.expectedOnIcu(planId, [3]);
    expect(test.onIcu(planId).filter((id) => weekThree.includes(id ?? ""))).toEqual([]);
    expect(await test.approve(planId, 3)).toEqual({ status: "approved", weeks: [3] });
    await test.drain.kick();
    expect(test.onIcu(planId)).toEqual(expect.arrayContaining(weekThree));
  });

  it("records a failed create, and Retry asks for the run that sends it without a copy", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    await test.approve(planId);
    test.calendar.failNextCreate = true;
    await test.drain.kick();
    expect(
      await test.store.get("SELECT count(*) AS n FROM plan_icu_copy WHERE last_write='failed'"),
    ).toEqual({ n: 1 });
    test.changed.mockReset();
    test.changed.mockImplementation(() => test.drain.kick().then(() => test.drain.idle()));
    await expect(
      test.calendarOperations["plan.calendar"]({ action: "send-again" }),
    ).resolves.toEqual({ status: "sending" });
    expect(test.changed).toHaveBeenCalledOnce();
    expect(test.onIcu(planId)).toEqual(await test.expectedOnIcu(planId, [1, 2]));
    expect(new Set(test.onIcu(planId)).size).toBe(test.onIcu(planId).length);
  });

  it("cleans a closed Plan from tomorrow, keeping today and the athlete's changes", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    await test.approve(planId);
    await test.drain.kick();
    const later = test.calendar.events.filter((event) => event.dateKey > test.today());
    const edited = later[0];
    if (edited === undefined) throw new Error("Expected a later event");
    test.calendar.editByAthlete(edited.id, { name: "Mine now" });
    await test.drain.kick();
    const todayEvents = test.calendar.events.filter((event) => event.dateKey === test.today());
    expect(
      await test.creation["plan.close"]({ commandId: "close", planId, expectedVersion: 1 }),
    ).toMatchObject({ status: "closed" });
    await test.drain.kick();
    expect(test.calendar.events.map((event) => event.id).sort()).toEqual(
      [...todayEvents.map((event) => event.id), edited.id].sort(),
    );
    expect(await test.reconciliation.readLatestJob(planId, "cleanup")).toMatchObject({
      status: "verified",
      windowStartDateKey: addCivilDays(test.today(), 1),
    });
  });

  it("sends a replacement's weeks only after the old Plan's later workouts are removed", async () => {
    const test = await harness();
    const incumbent = await test.activate();
    await test.approve(incumbent.planId);
    await test.drain.kick();
    test.calendar.failNextList = true;
    const replacement = await test.activate();
    expect(replacement.closedPlanId).toBe(incumbent.planId);
    await test.approve(replacement.planId);
    await test.drain.kick();
    expect(test.onIcu(replacement.planId)).toEqual([]);
    await test.drain.kick();
    const oldLater = test.calendar.events.filter(
      (event) =>
        event.externalId?.includes(incumbent.planId) === true && event.dateKey > test.today(),
    );
    expect(oldLater).toEqual([]);
    expect(test.onIcu(replacement.planId).length).toBeGreaterThan(0);
    expect(
      test.calendar.events.filter(
        (event) =>
          event.externalId?.includes(replacement.planId) === true && event.dateKey === test.today(),
      ),
    ).toEqual([]);
  });

  it("keeps retrying the old Plan's cleanup after five failures, then sends the replacement", async () => {
    const test = await harness();
    const incumbent = await test.activate();
    await test.approve(incumbent.planId);
    await test.drain.kick();
    const replacement = await test.activate();
    expect(replacement.closedPlanId).toBe(incumbent.planId);
    await test.approve(replacement.planId);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      test.calendar.failNextList = true;
      test.advanceMs(1_000);
      await test.drain.kick();
    }
    expect(await test.reconciliation.readLatestJob(incumbent.planId, "cleanup")).toMatchObject({
      status: "failed",
      failureCount: 5,
    });
    await test.drain.kick();
    expect(test.onIcu(replacement.planId)).toEqual([]);
    test.advanceMs(900_000);
    await test.drain.kick();
    expect(await test.reconciliation.readLatestJob(incumbent.planId, "cleanup")).toMatchObject({
      status: "verified",
    });
    const sent = test.calendar.events.filter(
      (event) => event.externalId?.includes(replacement.planId) === true,
    );
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((event) => event.dateKey > test.today())).toBe(true);
  });

  it("retires an old mirror job that still has items without stopping the run", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    await test.approve(planId);
    const workout = (await test.plans.readWorkouts(planId))[0];
    if (workout === undefined) throw new Error("Expected a Workout");
    const old = await test.reconciliation.createOrGetJob({
      id: test.identity.newUlid(),
      planId,
      kind: "mirror",
      windowStartDateKey: test.today(),
      windowEndDateKey: addCivilDays(test.today(), 6),
      createdAtMs: 904_694_400_000,
    });
    await test.reconciliation.prepareItem({
      id: test.identity.newUlid(),
      jobId: old.id,
      planWorkoutId: workout.id,
      operation: "create",
      dateKey: workout.dateKey,
      externalId: planMirrorExternalId(planId, workout.id),
      expectedJson: "{}",
      createdAtMs: 904_694_400_000,
    });
    await test.drain.kick();
    expect(await test.reconciliation.readJob(old.id)).toMatchObject({ status: "verified" });
    expect(test.onIcu(planId)).toEqual(await test.expectedOnIcu(planId, [1, 2]));
  });

  it("puts the Plan's version back over an edit made in intervals.icu", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    await test.approve(planId);
    await test.drain.kick();
    const event = test.calendar.events.find((entry) => entry.dateKey > test.today());
    if (event === undefined) throw new Error("Expected a later event");
    const plannedName = event.name;
    test.calendar.editByAthlete(event.id, { name: "Mine now" });
    await test.drain.kick();
    const workoutId = event.externalId?.split(":").at(-1) ?? "";
    const card = { planId, planWorkoutId: workoutId };
    expect(
      await test.calendarOperations["plan.calendar"]({ action: "change-detail", ...card }),
    ).toMatchObject({
      status: "change-detail",
      change: "edited",
      plan: { name: plannedName },
      intervals: { name: "Mine now" },
    });
    expect(await choose(test, "put-back", card)).toEqual({
      status: "change-resolved",
      outcome: "put-back",
    });
    expect(test.calendar.events.find((entry) => entry.id === event.id)?.name).toBe(plannedName);
    expect(await choose(test, "put-back", card)).toEqual({
      status: "change-resolved",
      outcome: "no-card",
    });
    const writes = test.calendar.updates.length;
    await test.drain.kick();
    expect(test.calendar.updates).toHaveLength(writes);
  });

  it("keeps a delete made in intervals.icu as Removed by you", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    await test.approve(planId);
    await test.drain.kick();
    const event = test.calendar.events.find((entry) => entry.dateKey > test.today());
    if (event === undefined) throw new Error("Expected a later event");
    test.calendar.deleteByAthlete(event.id);
    await test.drain.kick();
    const planWorkoutId = event.externalId?.split(":").at(-1) ?? "";
    expect(await choose(test, "keep-change", { planId, planWorkoutId })).toEqual({
      status: "change-resolved",
      outcome: "kept",
    });
    await test.drain.kick();
    expect(test.calendar.events.some((entry) => entry.id === event.id)).toBe(false);
    expect(
      await test.store.get("SELECT state_kind FROM plan_icu_copy WHERE plan_workout_id=?", [
        planWorkoutId,
      ]),
    ).toEqual({ state_kind: "removed-by-you" });
  });

  it("keeps a moved and shortened workout by changing the Plan, and sends nothing over it", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    await test.approve(planId);
    await test.drain.kick();
    const event = test.calendar.events.find(
      (entry) => entry.dateKey > addCivilDays(test.today(), 1),
    );
    if (event === undefined) throw new Error("Expected a later event");
    const planWorkoutId = event.externalId?.split(":").at(-1) ?? "";
    const before = (await test.plans.readWorkouts(planId)).find((row) => row.id === planWorkoutId);
    if (before === undefined) throw new Error("Expected the Plan workout");
    const moved = addCivilDays(event.dateKey, 1);
    test.calendar.editByAthlete(event.id, { dateKey: moved, durationS: 1_800 });
    await test.drain.kick();
    expect(await choose(test, "keep-change", { planId, planWorkoutId })).toEqual({
      status: "change-resolved",
      outcome: "kept",
    });
    const after = (await test.plans.readWorkouts(planId)).find((row) => row.id === planWorkoutId);
    expect(after).toMatchObject({ dateKey: moved, durationS: 1_800 });
    const writes = test.calendar.updates.length + test.calendar.creates.length;
    await test.drain.kick();
    expect(test.calendar.updates.length + test.calendar.creates.length).toBe(writes);
    expect(
      await test.store.get("SELECT state_kind FROM plan_icu_copy WHERE plan_workout_id=?", [
        planWorkoutId,
      ]),
    ).toEqual({ state_kind: "on-icu" });
  });

  it("shows the newest edit first when the athlete changes a workout again before choosing", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    await test.approve(planId);
    await test.drain.kick();
    const event = test.calendar.events.find((entry) => entry.dateKey > test.today());
    if (event === undefined) throw new Error("Expected a later event");
    const planWorkoutId = event.externalId?.split(":").at(-1) ?? "";
    test.calendar.editByAthlete(event.id, { name: "First edit" });
    await test.drain.kick();
    const card = { planId, planWorkoutId };
    const seen = await test.calendarOperations["plan.calendar"]({
      action: "change-detail",
      ...card,
    });
    if (seen.status !== "change-detail") throw new Error("Expected the card");
    expect(seen.intervals?.name).toBe("First edit");
    test.calendar.editByAthlete(event.id, { name: "Second edit" });
    await test.drain.kick();
    expect(await choose(test, "put-back", card, seen.basis)).toEqual({
      status: "change-resolved",
      outcome: "refreshed",
    });
    expect(test.calendar.events.find((entry) => entry.id === event.id)?.name).toBe("Second edit");
    expect(await choose(test, "keep-change", card)).toEqual({
      status: "change-resolved",
      outcome: "kept",
    });
    expect(
      (await test.plans.readWorkouts(planId)).find((row) => row.id === planWorkoutId)?.name,
    ).toBe("Second edit");
  });

  it("closes the card when the athlete changes the workout back to the Plan's version", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    await test.approve(planId);
    await test.drain.kick();
    const event = test.calendar.events.find((entry) => entry.dateKey > test.today());
    if (event === undefined) throw new Error("Expected a later event");
    const planWorkoutId = event.externalId?.split(":").at(-1) ?? "";
    const name = event.name;
    test.calendar.editByAthlete(event.id, { name: "Briefly mine" });
    await test.drain.kick();
    test.calendar.editByAthlete(event.id, { name });
    expect(
      await test.calendarOperations["plan.calendar"]({
        action: "change-detail",
        planId,
        planWorkoutId,
      }),
    ).toEqual({ status: "change-resolved", outcome: "no-card" });
    const read = await test.calendarOperations["plan.calendar"]({
      action: "read",
      startDateKey: test.today(),
      endDateKey: addCivilDays(test.today(), 27),
    });
    if (read.status !== "calendar") throw new Error("Expected the calendar");
    expect(read.plan?.workouts.find((workout) => workout.id === planWorkoutId)?.copy.kind).toBe(
      "on-intervals",
    );
  });

  it("keeps the length the sheet showed when the athlete adds steps and shortens the ride", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    await test.approve(planId);
    await test.drain.kick();
    const event = test.calendar.events.find((entry) => entry.dateKey > test.today());
    if (event === undefined) throw new Error("Expected a later event");
    const planWorkoutId = event.externalId?.split(":").at(-1) ?? "";
    test.calendar.editByAthlete(event.id, {
      description: "- 20m 60%\n- 10m 90%",
      durationS: 1_800,
    });
    await test.drain.kick();
    const detail = await test.calendarOperations["plan.calendar"]({
      action: "change-detail",
      planId,
      planWorkoutId,
    });
    if (detail.status !== "change-detail") throw new Error("Expected the card");
    expect(detail.intervals?.durationS).toBe(1_800);
    expect(await choose(test, "keep-change", { planId, planWorkoutId }, detail.basis)).toEqual({
      status: "change-resolved",
      outcome: "kept",
    });
    expect(
      (await test.plans.readWorkouts(planId)).find((row) => row.id === planWorkoutId)?.durationS,
    ).toBe(1_800);
  });

  it("opens and resolves a card whose intervals.icu description is very long", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    await test.approve(planId);
    await test.drain.kick();
    const event = test.calendar.events.find((entry) => entry.dateKey > test.today());
    if (event === undefined) throw new Error("Expected a later event");
    const planWorkoutId = event.externalId?.split(":").at(-1) ?? "";
    test.calendar.editByAthlete(event.id, { description: "Ride by feel. ".repeat(700) });
    await test.drain.kick();
    const detail = await test.calendarOperations["plan.calendar"]({
      action: "change-detail",
      planId,
      planWorkoutId,
    });
    expect(PlanCalendarRpcResultSchema.safeParse(detail).success).toBe(true);
    if (detail.status !== "change-detail") throw new Error("Expected the card");
    const request = {
      action: "put-back" as const,
      planId,
      planWorkoutId,
      basis: detail.basis,
    };
    expect(PlanCalendarRpcParamsSchema.safeParse(request).success).toBe(true);
    expect(await test.calendarOperations["plan.calendar"](request)).toEqual({
      status: "change-resolved",
      outcome: "put-back",
    });
  });

  it("says refreshed when the athlete edits again between the read and the Put back write", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    await test.approve(planId);
    await test.drain.kick();
    const event = test.calendar.events.find((entry) => entry.dateKey > test.today());
    if (event === undefined) throw new Error("Expected a later event");
    const planWorkoutId = event.externalId?.split(":").at(-1) ?? "";
    test.calendar.editByAthlete(event.id, { name: "First edit" });
    await test.drain.kick();
    const card = { planId, planWorkoutId };
    const seen = await test.calendarOperations["plan.calendar"]({
      action: "change-detail",
      ...card,
    });
    if (seen.status !== "change-detail") throw new Error("Expected the card");
    const read = test.calendar.mirror.readEvent;
    let reads = 0;
    vi.spyOn(test.calendar.mirror, "readEvent").mockImplementation(async (input) => {
      reads += 1;
      if (reads === 2) test.calendar.editByAthlete(event.id, { name: "Late edit" });
      return read(input);
    });
    expect(await choose(test, "put-back", card, seen.basis)).toEqual({
      status: "change-resolved",
      outcome: "refreshed",
    });
    expect(test.calendar.events.find((entry) => entry.id === event.id)?.name).toBe("Late edit");
  });

  it("keeps a steps-only edit without changing the Plan, and Keep again changes nothing", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    await test.approve(planId);
    await test.drain.kick();
    const event = test.calendar.events.find((entry) => entry.dateKey > test.today());
    if (event === undefined) throw new Error("Expected a later event");
    const planWorkoutId = event.externalId?.split(":").at(-1) ?? "";
    test.calendar.editByAthlete(event.id, { description: "Ride by feel" });
    await test.drain.kick();
    const changes = async () =>
      test.store.get("SELECT count(*) AS n FROM plan_change WHERE plan_id=? AND status='applied'", [
        planId,
      ]);
    const before = await changes();
    expect(await choose(test, "keep-change", { planId, planWorkoutId })).toEqual({
      status: "change-resolved",
      outcome: "kept",
    });
    expect(await changes()).toEqual(before);
  });

  it("lists the Plan and refuses Undo after the athlete keeps a change", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    await test.approve(planId);
    await test.drain.kick();
    const event = test.calendar.events.find((entry) => entry.dateKey > test.today());
    if (event === undefined) throw new Error("Expected a later event");
    const planWorkoutId = event.externalId?.split(":").at(-1) ?? "";
    test.calendar.editByAthlete(event.id, { durationS: 1_800 });
    await test.drain.kick();
    expect(await choose(test, "keep-change", { planId, planWorkoutId })).toEqual({
      status: "change-resolved",
      outcome: "kept",
    });
    const listed = await test.creation["plan.list"]({});
    const kept = listed.changes.find((change) => change.intent.kind === "keep-intervals-change");
    expect(kept).toMatchObject({
      status: "applied",
      undo: { eligible: false, reason: "athlete-change" },
    });
    if (kept === undefined) throw new Error("Expected the kept change");
    expect(
      await test.changes["plan_change.preview"]({
        commandId: "undo-kept",
        planId,
        expectedVersion: kept.baseRevisionNumber + 1,
        intent: { kind: "inverse", changeId: kept.changeId },
      }),
    ).toMatchObject({ status: "rejected" });
  });

  async function movable(test: Awaited<ReturnType<typeof harness>>, planId: string) {
    await test.approve(planId);
    await test.drain.kick();
    const workouts = await test.plans.readWorkouts(planId);
    const busy = new Set(workouts.map((workout) => workout.dateKey));
    const later = workouts
      .filter((workout) => workout.dateKey > test.today() && workout.origin === "coach")
      .sort((left, right) => left.dateKey - right.dateKey);
    const first = later[0];
    const second = later[1];
    if (first === undefined || second === undefined) throw new Error("Expected two later workouts");
    let free = addCivilDays(first.dateKey, 1);
    while (busy.has(free)) free = addCivilDays(free, 1);
    return { first, second, free };
  }

  const move = (
    test: Awaited<ReturnType<typeof harness>>,
    request: { planId: string; planWorkoutId: string; toDateKey: number; swap?: boolean },
  ) =>
    test.calendarOperations["plan.calendar"]({
      action: "move-workout",
      planId: request.planId,
      planWorkoutId: request.planWorkoutId,
      toDateKey: request.toDateKey,
      swap: request.swap ?? false,
    });

  it("moves a workout to a free day in the Plan and on intervals.icu, and labels it Moved by you", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    const { first, free } = await movable(test, planId);
    const event = test.calendar.events.find((entry) => entry.externalId?.endsWith(first.id));
    if (event === undefined) throw new Error("Expected the workout on intervals.icu");
    expect(await move(test, { planId, planWorkoutId: first.id, toDateKey: free })).toEqual({
      status: "moved",
    });
    expect(
      (await test.plans.readWorkouts(planId)).find((row) => row.id === first.id),
    ).toMatchObject({ dateKey: free, durationS: first.durationS, name: first.name });
    await test.drain.kick();
    expect(test.calendar.events.find((entry) => entry.id === event.id)?.dateKey).toBe(free);
    expect(
      test.calendar.creates.filter((entry) => entry.externalId?.endsWith(first.id)),
    ).toHaveLength(1);
    const read = await test.calendarOperations["plan.calendar"]({
      action: "read",
      startDateKey: test.today(),
      endDateKey: addCivilDays(test.today(), 27),
    });
    if (read.status !== "calendar") throw new Error("Expected the calendar");
    expect(read.plan?.workouts.find((workout) => workout.id === first.id)).toMatchObject({
      dateKey: free,
      movedByYou: { fromDateKey: first.dateKey },
      copy: { kind: "on-intervals" },
    });
  });

  it("swaps with the workout already on the target day when asked", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    const { first, second } = await movable(test, planId);
    expect(
      await move(test, { planId, planWorkoutId: first.id, toDateKey: second.dateKey, swap: true }),
    ).toEqual({ status: "moved" });
    const after = await test.plans.readWorkouts(planId);
    expect(after.find((row) => row.id === first.id)?.dateKey).toBe(second.dateKey);
    expect(after.find((row) => row.id === second.id)?.dateKey).toBe(first.dateKey);
    await test.drain.kick();
    const onIcu = (id: string) =>
      test.calendar.events.find((entry) => entry.externalId?.endsWith(id))?.dateKey;
    expect(onIcu(first.id)).toBe(second.dateKey);
    expect(onIcu(second.id)).toBe(first.dateKey);
  });

  it("refuses to move a workout with an open change card, a past day, or a day after the Plan", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    const { first, second, free } = await movable(test, planId);
    const event = test.calendar.events.find((entry) => entry.externalId?.endsWith(first.id));
    if (event === undefined) throw new Error("Expected the workout on intervals.icu");
    test.calendar.editByAthlete(event.id, { name: "My own ride" });
    await test.drain.kick();
    expect(await move(test, { planId, planWorkoutId: first.id, toDateKey: free })).toEqual({
      status: "refused",
      reason: "change-card-open",
    });
    expect(
      await move(test, {
        planId,
        planWorkoutId: second.id,
        toDateKey: addCivilDays(test.today(), -1),
      }),
    ).toEqual({ status: "refused", reason: "outside-plan" });
    expect(
      await move(test, { planId, planWorkoutId: second.id, toDateKey: addCivilDays(free, 400) }),
    ).toEqual({ status: "refused", reason: "outside-plan" });
    expect(
      (await test.plans.readWorkouts(planId)).find((row) => row.id === first.id)?.dateKey,
    ).toBe(first.dateKey);
  });

  it("will not move a workout the athlete kept as their own edit", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    const { first, free } = await movable(test, planId);
    const event = test.calendar.events.find((entry) => entry.externalId?.endsWith(first.id));
    if (event === undefined) throw new Error("Expected the workout on intervals.icu");
    test.calendar.editByAthlete(event.id, { description: "My notes" });
    await test.drain.kick();
    expect(await choose(test, "keep-change", { planId, planWorkoutId: first.id })).toEqual({
      status: "change-resolved",
      outcome: "kept",
    });
    const read = await test.calendarOperations["plan.calendar"]({
      action: "read",
      startDateKey: test.today(),
      endDateKey: addCivilDays(test.today(), 27),
    });
    if (read.status !== "calendar") throw new Error("Expected the calendar");
    expect(read.plan?.workouts.find((workout) => workout.id === first.id)?.movable).toBe(false);
    expect(await move(test, { planId, planWorkoutId: first.id, toDateKey: free })).toEqual({
      status: "refused",
      reason: "workout-not-movable",
    });
    expect(test.calendar.events.find((entry) => entry.id === event.id)?.description).toBe(
      "My notes",
    );
  });

  it("takes a workout moved past next week off intervals.icu until its week goes out", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    const { first } = await movable(test, planId);
    const plan = await test.legacyPlans.read(planId);
    if (plan === undefined) throw new Error("Expected the Plan");
    const third = trainingWeek(plan, 3);
    const busy = new Set((await test.plans.readWorkouts(planId)).map((row) => row.dateKey));
    let target = third.startDateKey;
    while (busy.has(target)) target = addCivilDays(target, 1);
    const event = test.calendar.events.find((entry) => entry.externalId?.endsWith(first.id));
    if (event === undefined) throw new Error("Expected the workout on intervals.icu");
    expect(await move(test, { planId, planWorkoutId: first.id, toDateKey: target })).toEqual({
      status: "moved",
    });
    await test.drain.kick();
    expect(test.calendar.events.some((entry) => entry.id === event.id)).toBe(false);
    expect(
      (await test.plans.readWorkouts(planId)).find((row) => row.id === first.id)?.dateKey,
    ).toBe(target);
  });

  it("swaps only with workouts still shown on the target day", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    const { first, second } = await movable(test, planId);
    const removed = test.calendar.events.find((entry) => entry.externalId?.endsWith(second.id));
    if (removed === undefined) throw new Error("Expected the second workout on intervals.icu");
    test.calendar.deleteByAthlete(removed.id);
    await test.drain.kick();
    expect(await choose(test, "keep-change", { planId, planWorkoutId: second.id })).toEqual({
      status: "change-resolved",
      outcome: "kept",
    });
    expect(
      await move(test, { planId, planWorkoutId: first.id, toDateKey: second.dateKey, swap: true }),
    ).toEqual({ status: "moved" });
    const after = await test.plans.readWorkouts(planId);
    expect(after.find((row) => row.id === first.id)?.dateKey).toBe(second.dateKey);
    expect(after.find((row) => row.id === second.id)?.dateKey).toBe(second.dateKey);
  });

  it("keeps the Plan library readable after a move, and labels only the latest move", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    const { first, free } = await movable(test, planId);
    expect(await move(test, { planId, planWorkoutId: first.id, toDateKey: free })).toEqual({
      status: "moved",
    });
    const listed = await test.creation["plan.list"]({});
    expect(listed.changes.find((change) => change.intent.kind === "move-by-you")).toMatchObject({
      status: "applied",
      undo: { eligible: false, reason: "athlete-change" },
    });
    let next = addCivilDays(free, 1);
    const busy = new Set((await test.plans.readWorkouts(planId)).map((row) => row.dateKey));
    while (busy.has(next)) next = addCivilDays(next, 1);
    expect(await move(test, { planId, planWorkoutId: first.id, toDateKey: next })).toEqual({
      status: "moved",
    });
    const read = await test.calendarOperations["plan.calendar"]({
      action: "read",
      startDateKey: test.today(),
      endDateKey: addCivilDays(test.today(), 27),
    });
    if (read.status !== "calendar") throw new Error("Expected the calendar");
    expect(read.plan?.workouts.find((workout) => workout.id === first.id)?.movedByYou).toEqual({
      fromDateKey: free,
    });
  });

  it("lists the Plan's history and what End Plan removes, keeping the athlete's changes apart", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    await test.approve(planId);
    await test.drain.kick();
    const later = test.calendar.events
      .filter((event) => event.dateKey > test.today())
      .sort((left, right) => left.dateKey - right.dateKey);
    const edited = later[0];
    if (edited === undefined) throw new Error("Expected a later event");
    const editedWorkout = edited.externalId?.split(":").at(-1) ?? "";
    test.calendar.editByAthlete(edited.id, { durationS: 1_800 });
    await test.drain.kick();
    expect(await choose(test, "keep-change", { planId, planWorkoutId: editedWorkout })).toEqual({
      status: "change-resolved",
      outcome: "kept",
    });
    const details = await test.calendarOperations["plan.calendar"]({
      action: "plan-details",
      planId,
    });
    if (details.status !== "plan-details") throw new Error("Expected Plan details");
    expect(details.history[0]).toMatchObject({
      kind: "kept",
      dateKey: edited.dateKey,
      durationS: 1_800,
    });
    expect(details.history.at(-1)?.kind).toBe("saved");
    expect(details.ending.athleteChanges.map((entry) => entry.planWorkoutId)).toEqual([
      editedWorkout,
    ]);
    expect(details.ending.athleteChanges[0]?.tick).toMatchObject({
      planWorkoutId: editedWorkout,
      eventId: edited.id,
      dateKey: edited.dateKey,
    });
    expect(details.ending.removes.map((entry) => entry.planWorkoutId).sort()).toEqual(
      later
        .slice(1)
        .map((event) => event.externalId?.split(":").at(-1) ?? "")
        .sort(),
    );
  });

  it("removes the athlete's ticked changes at End and keeps the ones left unticked", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    await test.approve(planId);
    await test.drain.kick();
    const later = test.calendar.events
      .filter((event) => event.dateKey > test.today())
      .sort((left, right) => left.dateKey - right.dateKey);
    const [ticked, kept] = later;
    if (ticked === undefined || kept === undefined) throw new Error("Expected two later events");
    test.calendar.editByAthlete(ticked.id, { name: "Remove this one" });
    test.calendar.editByAthlete(kept.id, { name: "Keep this one" });
    await test.drain.kick();
    const details = await test.calendarOperations["plan.calendar"]({
      action: "plan-details",
      planId,
    });
    if (details.status !== "plan-details") throw new Error("Expected Plan details");
    const tick = details.ending.athleteChanges.find((entry) => entry.tick.eventId === ticked.id);
    if (tick === undefined) throw new Error("Expected the ticked change");
    expect(
      await test.calendarOperations["plan.calendar"]({
        action: "save-end-choice",
        planId,
        ticked: [tick.tick],
      }),
    ).toEqual({ status: "end-choice-saved" });
    const todayEvents = test.calendar.events.filter((event) => event.dateKey === test.today());
    expect(
      await test.creation["plan.close"]({ commandId: "close", planId, expectedVersion: 1 }),
    ).toMatchObject({ status: "closed" });
    await test.drain.kick();
    expect(test.calendar.events.map((event) => event.id).sort()).toEqual(
      [...todayEvents.map((event) => event.id), kept.id].sort(),
    );
  });

  it("keeps the athlete's changes on Replace even when a failed End left them ticked", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    await test.approve(planId);
    await test.drain.kick();
    const edited = test.calendar.events
      .filter((event) => event.dateKey > test.today())
      .sort((left, right) => left.dateKey - right.dateKey)[0];
    if (edited === undefined) throw new Error("Expected a later event");
    test.calendar.editByAthlete(edited.id, { name: "My own ride" });
    await test.drain.kick();
    const details = await test.calendarOperations["plan.calendar"]({
      action: "plan-details",
      planId,
    });
    if (details.status !== "plan-details") throw new Error("Expected Plan details");
    const ticks = details.ending.athleteChanges.map((entry) => entry.tick);
    expect(ticks.map((tick) => tick.eventId)).toEqual([edited.id]);
    await test.calendarOperations["plan.calendar"]({
      action: "save-end-choice",
      planId,
      ticked: ticks,
    });
    const replacement = await test.activate();
    expect(replacement.closedPlanId).toBe(planId);
    await test.drain.kick();
    expect(
      test.calendar.events.find((event) => event.id === edited.id)?.name,
      "the athlete's own edit after Replace",
    ).toBe("My own ride");
  });

  it("does nothing when the calendar is disconnected", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    await test.approve(planId);
    test.disconnect();
    await test.drain.kick();
    expect(test.calendar.lists).toEqual([]);
    test.connect();
    await test.drain.kick();
    expect(test.onIcu(planId)).toEqual(await test.expectedOnIcu(planId, [1, 2]));
  });

  it("serializes concurrent kicks into one run and one rerun and waits for both when idle", async () => {
    const test = await harness();
    const { planId } = await test.activate();
    await test.approve(planId);
    test.calendar.failNextList = true;
    test.calendar.delayMs = 10;
    let complete = false;
    const running = test.drain.kick().then(() => {
      complete = true;
    });
    await Promise.all([test.drain.kick(), test.drain.kick()]);
    expect(complete).toBe(false);
    await test.drain.idle();
    await running;
    expect(test.calendar.lists).toHaveLength(2);
    expect(test.onIcu(planId)).toEqual(await test.expectedOnIcu(planId, [1, 2]));
  });
});
