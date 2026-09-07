import { createCyclingPlanFtpAdapter } from "@enduragent/sport-cycling";
import type { PlanFtpSourceValue } from "@enduragent/engine/sport";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  PlanCreationDraftSchema,
  type PlanCreationAnswerInput,
  type PlanChangeIntent,
  type PlanChangeEventSource,
} from "@enduragent/coach-contract";
import { canonicalJson } from "@enduragent/kernel/archive";
import {
  createPlanCreationRepository,
  createPlanWorkoutMatchRepository,
} from "@enduragent/kernel/planning";
import { dumpStore, runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { createPlanCreationOperations } from "../src/plan-creation-operations.js";
import { createPlanChangeOperations } from "../src/plan-change-operations.js";

async function activatedPlan(
  todayDateKey = () => 19980902,
  initialSync: { connected: boolean; lastSuccessfulSyncAtMs: number | null } = {
    connected: false,
    lastSuccessfulSyncAtMs: null,
  },
  eventDate: string | null = null,
  mode: "fixed" | "flexible" = "fixed",
) {
  const store = openSqliteStorage(":memory:");
  onTestFinished(() => store.close());
  await runMigrations(store, MIGRATIONS);
  let sequence = 100;
  let nowMs = 904_694_400_000;
  let connected = initialSync.connected;
  const calendarConnected = vi.fn(async () => connected);
  const recordSync = async (atMs: number) => {
    await store.run(
      `INSERT INTO source_artifact (artifact_key,source,lane,external_id,artifact_kind,archive_address,archive_rel_path,archive_epoch_s)
      VALUES (?, 'intervals-icu', 'activities', 'synthetic-sync', 'snapshot', ?, 'synthetic/sync.json', ?)`,
      [`sync-${++sequence}`, "a".repeat(64), Math.floor(atMs / 1000)],
    );
  };
  if (initialSync.lastSuccessfulSyncAtMs !== null)
    await recordSync(initialSync.lastSuccessfulSyncAtMs);
  const identity = {
    deviceId: async () => "plan-change-test-device",
    newUlid: () => String(++sequence).padStart(26, "0"),
    hlcStamp: () => ({ physicalMs: 904_694_400_000, counter: sequence }),
  };
  const dependencies = {
    store,
    identity,
    crypto: globalThis.crypto,
    todayDateKey,
    now: () => nowMs,
    calendarConnected,
  };
  const creation = createPlanCreationOperations({
    ...dependencies,
    repository: createPlanCreationRepository(store),
    calendarConnected: () => connected,
    eventCandidates: { read: async () => [] },
    today: () => "1998-09-02",
  });
  let manual: PlanFtpSourceValue | null = null;
  let intervalsFtp: PlanFtpSourceValue | null = null;
  let intervalsEftp: PlanFtpSourceValue | null = null;
  const saveManual = vi.fn(async (watts: number) => {
    manual = { watts, refreshedAtMs: nowMs };
  });
  const ftp = createCyclingPlanFtpAdapter({
    readManual: async () => manual,
    readIntervalsFtp: async () => intervalsFtp,
    readIntervalsEftp: async () => intervalsEftp,
    saveManual,
    refreshIntervals: async () => {},
  });
  const logger = { warn: vi.fn() };
  let candidates: PlanChangeEventSource[] = [];
  const eventSources = { read: vi.fn(async () => structuredClone(candidates)) };
  const changes = createPlanChangeOperations({ ...dependencies, ftp, logger, eventSources });
  const start = await creation["plan_creation.start"]({ commandId: "start" });
  if (start.status !== "started") throw new Error("Expected creation");
  let card = start.planCreation;
  const answers: PlanCreationAnswerInput[] = [
    ...(eventDate === null
      ? ([
          { kind: "goal", goal: { kind: "fitness" } },
          { kind: "plan-length", weeks: 4 },
        ] satisfies PlanCreationAnswerInput[])
      : ([
          { kind: "goal", goal: { kind: "event-manual", name: "Autumn ride", date: eventDate } },
        ] satisfies PlanCreationAnswerInput[])),
    { kind: "schedule-mode", mode },
    mode === "fixed"
      ? {
          kind: "availability",
          mode,
          weeklyHoursLimit: 8,
          longestWorkoutHours: 3,
          usableWeekdays: [6, 2, 4],
        }
      : { kind: "availability", mode, weeklyHoursLimit: 8, longestWorkoutHours: 3 },
    { kind: "start-timing", timing: { kind: "as-soon-as-possible" } },
    { kind: "commitments", commitments: { kind: "none" } },
    { kind: "baseline", baseline: "regular" },
    {
      kind: "success",
      success:
        eventDate === null
          ? { kind: "fitness-choice", choice: "climb-stronger" }
          : { kind: "event-finish", choice: "finish-fast" },
    },
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
  const draftResult = await creation["plan_creation.preview"]({
    commandId: "draft",
    creationId: card.creationId,
    expectedVersion: card.version,
  });
  if (draftResult.status !== "previewed" || draftResult.planCreation.draft === null)
    throw new Error("Expected Draft");
  const activated = await creation["plan_creation.activate"]({
    commandId: "activate",
    incumbent: null,
    creationId: card.creationId,
    expectedVersion: draftResult.planCreation.version,
  });
  expect(activated.planId).toBeTruthy();
  const listed = await creation["plan.list"]({});
  if (listed.active === null) throw new Error("Expected active Plan summary");
  const planId = listed.active.planId;
  const preview = async (
    intent: PlanChangeIntent = { kind: "longest-workout", minutes: 30 },
    commandId = "change-preview",
    expectedVersion = 1,
  ) => {
    const result = await changes["plan_change.preview"]({
      commandId,
      planId,
      expectedVersion,
      intent,
    });
    if (result.status !== "previewed") throw new Error(`Expected Change preview: ${result.reason}`);
    return result;
  };
  const workouts = () =>
    store.all("SELECT * FROM plan_workout WHERE plan_id = ? ORDER BY id", [planId]);
  return {
    store,
    ftp,
    saveManual,
    logger,
    eventSources,
    setEventSources: (sources: PlanChangeEventSource[]) => {
      candidates = structuredClone(sources);
    },
    setFtpSources: (sources: {
      manual?: PlanFtpSourceValue | null;
      intervalsFtp?: PlanFtpSourceValue | null;
      intervalsEftp?: PlanFtpSourceValue | null;
    }) => {
      if (sources.manual !== undefined) manual = sources.manual;
      if (sources.intervalsFtp !== undefined) intervalsFtp = sources.intervalsFtp;
      if (sources.intervalsEftp !== undefined) intervalsEftp = sources.intervalsEftp;
    },
    setNow: (value: number) => {
      nowMs = value;
    },
    setConnected: (value: boolean) => {
      connected = value;
    },
    recordSync,
    calendarConnected,
    creation,
    changes,
    planId,
    preview,
    workouts,
    draft: draftResult.planCreation.draft,
  };
}

async function matchWorkout(
  test: Awaited<ReturnType<typeof activatedPlan>>,
  workoutId: string,
  source: "platform" | "heuristic",
  decision: "suggested" | "confirmed" | "rejected" | "unpaired",
) {
  const workout = await test.store.get(
    "SELECT id,date_key FROM plan_workout WHERE plan_id=? AND json_extract(structure_json,'$.id')=?",
    [test.planId, workoutId],
  );
  if (typeof workout?.id !== "string" || typeof workout.date_key !== "number")
    throw new Error("Expected dated Workout");
  return createPlanWorkoutMatchRepository(test.store).observe({
    id: "900".padStart(26, "0"),
    planId: test.planId,
    planWorkoutId: workout.id,
    activityId: "a".repeat(64),
    providerActivityId: source === "platform" ? "synthetic-activity" : null,
    providerEventId: source === "platform" ? 42 : null,
    source,
    decision,
    activityDateKey: workout.date_key,
    activitySport: "Ride",
    activityDurationS: 3600,
    observedAtMs: 904_694_400_000,
    decidedAtMs: decision === "suggested" ? null : 904_694_400_000,
    deviceId: "plan-change-test-device",
    hlcPhysicalMs: 904_694_400_000,
    hlcCounter: 0,
  });
}

describe("Plan Change operations", () => {
  it.each(["platform", "heuristic"] as const)(
    "excludes a Workout completed today through a %s match from preview and preserves it on apply",
    async (source) => {
      const test = await activatedPlan(() => 19980903);
      const completed = test.draft.weeks
        .flatMap((week) => week.workouts)
        .find((workout) => workout.date === "1998-09-03");
      if (completed === undefined) throw new Error("Expected today's Workout");
      const match = await matchWorkout(test, completed.id, source, "confirmed");
      const before = await test.workouts();
      const preview = await test.preview({ kind: "weekday-unavailable", day: 4 });
      expect(preview.change.diff.some((row) => row.workoutId === completed.id)).toBe(false);
      expect(preview.change.diff.length).toBeGreaterThan(0);
      await expect(
        test.changes["plan_change.apply"]({
          commandId: "apply-completed-preview",
          planId: test.planId,
          changeId: preview.change.changeId,
          expectedVersion: 1,
          decision: "apply",
        }),
      ).resolves.toMatchObject({ status: "applied" });
      expect((await test.workouts()).find((row) => row.id === match.planWorkoutId)).toEqual(
        before.find((row) => row.id === match.planWorkoutId),
      );
      expect(await createPlanWorkoutMatchRepository(test.store).readForPlan(test.planId)).toEqual([
        match,
      ]);
    },
  );

  it.each([
    { source: "heuristic", decision: "suggested" },
    { source: "heuristic", decision: "rejected" },
    { source: "platform", decision: "unpaired" },
  ] as const)(
    "keeps a $decision match eligible for preview and apply",
    async ({ source, decision }) => {
      const test = await activatedPlan(() => 19980903);
      const workout = test.draft.weeks
        .flatMap((week) => week.workouts)
        .find((row) => row.date === "1998-09-03");
      if (workout === undefined) throw new Error("Expected today's Workout");
      await matchWorkout(test, workout.id, source, decision);
      const preview = await test.preview({ kind: "weekday-unavailable", day: 4 });
      expect(
        preview.change.diff.some((row) => row.workoutId === workout.id && row.after === null),
      ).toBe(true);
      await expect(
        test.changes["plan_change.apply"]({
          commandId: "apply-uncompleted",
          planId: test.planId,
          changeId: preview.change.changeId,
          expectedVersion: 1,
          decision: "apply",
        }),
      ).resolves.toMatchObject({ status: "applied" });
    },
  );

  it.each([
    { kind: "weekday-unavailable", day: 4 },
    { kind: "longest-workout", minutes: 15 },
  ] satisfies PlanChangeIntent[])(
    "rejects $kind when a completion appears after preview without any writes",
    async (intent) => {
      const test = await activatedPlan(() => 19980903);
      const preview = await test.preview(intent);
      const changed = preview.change.diff.find((row) => row.before?.date === "1998-09-03");
      if (changed === undefined) throw new Error("Expected today's changed Workout");
      await matchWorkout(test, changed.workoutId, "heuristic", "confirmed");
      const before = await dumpStore(test.store);
      await expect(
        test.changes["plan_change.apply"]({
          commandId: "apply-completed",
          planId: test.planId,
          changeId: preview.change.changeId,
          expectedVersion: 1,
          decision: "apply",
        }),
      ).resolves.toEqual({ status: "rejected", reason: "stale-version" });
      expect(await dumpStore(test.store)).toBe(before);
      expect((await test.creation["plan.list"]({})).changes).toMatchObject([
        { status: "pending", resultRevisionNumber: null },
      ]);
      const fresh = await test.preview(intent, "fresh-preview");
      expect(fresh.change.diff.some((row) => row.workoutId === changed.workoutId)).toBe(false);
    },
  );

  it("stores a pending preview in plan.list without changing training and replays its captured result", async () => {
    const test = await activatedPlan();
    const before = await test.workouts();
    const first = await test.preview();
    expect(first.change).toMatchObject({
      status: "pending",
      title: "Limit the longest Workout",
      baseRevisionNumber: 1,
      confidence:
        "Moderate confidence. Based on your confirmed limits and the available training record.",
      premises: [
        {
          id: "confirmed-limits",
          label: "Confirmed Plan limits",
          source: "Your confirmed answers",
          value: { kind: "longest-workout", minutes: 30 },
        },
      ],
    });
    expect(first.change.diff.length).toBeGreaterThan(0);
    expect(first.change.totals.after.plan).toBeLessThan(first.change.totals.before.plan);
    expect(await test.workouts()).toEqual(before);
    expect((await test.creation["plan.list"]({})).changes).toEqual([first.change]);
    expect(await test.preview()).toEqual(first);
    const second = await test.preview({ kind: "weekly-duration", hours: 2 }, "replacement");
    expect((await test.creation["plan.list"]({})).changes).toMatchObject([
      {
        changeId: first.change.changeId,
        status: "superseded",
        supersededBy: second.change.changeId,
      },
      { changeId: second.change.changeId, status: "pending", supersedes: first.change.changeId },
    ]);
    expect(await test.preview()).toEqual(first);
  });

  it("rejects invalid intents and stale versions without writing a Change", async () => {
    const test = await activatedPlan();
    await expect(
      test.changes["plan_change.preview"]({
        commandId: "invalid",
        planId: test.planId,
        expectedVersion: 1,
        intent: { kind: "weekday-duration", day: 8, minutes: 0 },
      }),
    ).resolves.toEqual({ status: "rejected", reason: "invalid-intent" });
    await expect(
      test.changes["plan_change.preview"]({
        commandId: "stale",
        planId: test.planId,
        expectedVersion: 2,
        intent: { kind: "longest-workout", minutes: 30 },
      }),
    ).resolves.toEqual({ status: "rejected", reason: "stale-version" });
    expect((await test.creation["plan.list"]({})).changes).toEqual([]);
    expect(
      await test.store.all(
        "SELECT * FROM planning_command WHERE command_name = 'plan_change.preview'",
      ),
    ).toEqual([]);
  });

  it("applies the captured Draft as revision 2 and preserves retained Workout row ids", async () => {
    const test = await activatedPlan();
    const before = await test.workouts();
    const preview = await test.preview({ kind: "weekday-unavailable", day: 4 });
    const request = {
      commandId: "apply",
      planId: test.planId,
      changeId: preview.change.changeId,
      expectedVersion: 1,
      decision: "apply" as const,
    };
    await expect(
      test.changes["plan_change.apply"]({ ...request, expectedVersion: 2 }),
    ).resolves.toEqual({ status: "rejected", reason: "stale-version" });
    const result = await test.changes["plan_change.apply"](request);
    expect(result).toEqual({
      status: "applied",
      changeId: preview.change.changeId,
      revisionNumber: 2,
      version: 2,
    });
    const after = await test.workouts();
    const removed = new Set(
      preview.change.diff.filter((row) => row.after === null).map((row) => row.workoutId),
    );
    expect(removed.size).toBeGreaterThan(0);
    const retained = before.filter(
      (row) =>
        !removed.has(
          PlanCreationDraftSchema.shape.weeks.element.shape.workouts.element.parse(
            JSON.parse(String(row.structure_json)),
          ).id,
        ),
    );
    expect(after).toEqual(retained);
    expect(after.map((row) => row.structure_json)).toEqual(
      retained.map((row) => row.structure_json),
    );
    const revision = await test.store.get(
      "SELECT * FROM plan_revision WHERE plan_id = ? AND revision_number = 2",
      [test.planId],
    );
    const expected = structuredClone(test.draft);
    for (const week of expected.weeks)
      week.workouts = week.workouts.filter((row) => !removed.has(row.id));
    const captured = PlanCreationDraftSchema.parse(JSON.parse(String(revision?.snapshot_json)));
    expect(captured.weeks).toEqual(expected.weeks);
    expect(revision).toMatchObject({
      source_kind: "plan-change",
      source_id: preview.change.changeId,
      parent_revision_number: 1,
    });
    expect((await test.creation["plan.list"]({})).changes).toMatchObject([
      { status: "applied", resultRevisionNumber: 2 },
    ]);
    expect(await test.changes["plan_change.apply"](request)).toEqual(result);
    expect(await test.workouts()).toEqual(after);
    expect(
      await test.store.all("SELECT * FROM plan_revision WHERE plan_id = ?", [test.planId]),
    ).toHaveLength(2);
  });

  it("preserves provider notes on retained Workouts while applying affected Workouts", async () => {
    const test = await activatedPlan();
    const preview = await test.preview({ kind: "weekday-unavailable", day: 4 });
    const diffIds = new Set(preview.change.diff.map((row) => row.workoutId));
    const retained = test.draft.weeks
      .flatMap((week) => week.workouts)
      .find((workout) => workout.date !== null && !diffIds.has(workout.id));
    if (retained === undefined) throw new Error("Expected a retained Workout");
    await test.store.run(
      "UPDATE plan_workout SET structure_json=? WHERE plan_id=? AND json_extract(structure_json,'$.id')=?",
      [canonicalJson({ ...retained, description: "Provider notes" }), test.planId, retained.id],
    );
    const before = await test.workouts();
    const affected = before.filter((row) =>
      preview.change.diff.some((change) => row.structure_json === canonicalJson(change.before)),
    );
    expect(affected).toHaveLength(diffIds.size);
    expect(affected.length).toBeGreaterThan(0);
    expect(preview.change.diff.every((row) => row.after === null)).toBe(true);
    await expect(
      test.changes["plan_change.apply"]({
        commandId: "apply-provider-notes",
        planId: test.planId,
        changeId: preview.change.changeId,
        expectedVersion: 1,
        decision: "apply",
      }),
    ).resolves.toMatchObject({ status: "applied", revisionNumber: 2, version: 2 });
    const after = await test.workouts();
    expect(JSON.stringify(after)).toBe(
      JSON.stringify(before.filter((row) => !affected.some((changed) => changed.id === row.id))),
    );
  });

  it("materializes changed durations and canonical Draft structures", async () => {
    const test = await activatedPlan();
    const preview = await test.preview();
    const before = await test.workouts();
    await test.changes["plan_change.apply"]({
      commandId: "apply",
      planId: test.planId,
      changeId: preview.change.changeId,
      expectedVersion: 1,
      decision: "apply",
    });
    const after = await test.workouts();
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
    for (const row of after) {
      const draft = PlanCreationDraftSchema.shape.weeks.element.shape.workouts.element.parse(
        JSON.parse(String(row.structure_json)),
      );
      expect(row).toMatchObject({
        sport: "Ride",
        origin: "coach",
        duration_s: Math.round(draft.minutes * 60),
        date_key: Number(draft.date?.replaceAll("-", "")),
        structure_json: canonicalJson(draft),
      });
      expect(draft.minutes).toBeLessThanOrEqual(30);
    }
  });

  it("rejects an athlete edit to a changed Workout without writes through plan_change.apply", async () => {
    const test = await activatedPlan();
    const preview = await test.preview();
    const [changed] = preview.change.diff;
    if (changed?.before === null || changed?.before === undefined)
      throw new Error("Expected a changed Workout");
    await test.store.run(
      "UPDATE plan_workout SET structure_json=? WHERE plan_id=? AND json_extract(structure_json,'$.id')=?",
      [
        canonicalJson({ ...changed.before, minutes: changed.before.minutes + 5 }),
        test.planId,
        changed.workoutId,
      ],
    );
    const before = await dumpStore(test.store);
    await expect(
      test.changes["plan_change.apply"]({
        commandId: "apply-drifted",
        planId: test.planId,
        changeId: preview.change.changeId,
        expectedVersion: 1,
        decision: "apply",
      }),
    ).resolves.toEqual({ status: "rejected", reason: "stale-version" });
    expect(await dumpStore(test.store)).toBe(before);
  });

  it("cancels and replays without changing revision or Workouts", async () => {
    const test = await activatedPlan();
    const before = await test.workouts();
    const preview = await test.preview();
    const request = {
      commandId: "cancel",
      planId: test.planId,
      changeId: preview.change.changeId,
      expectedVersion: 1,
      decision: "cancel" as const,
    };
    const result = await test.changes["plan_change.apply"](request);
    expect(result).toEqual({ status: "cancelled", changeId: preview.change.changeId, version: 1 });
    expect(await test.changes["plan_change.apply"](request)).toEqual(result);
    expect(
      await test.changes["plan_change.apply"]({
        ...request,
        commandId: "apply-cancelled",
        decision: "apply",
      }),
    ).toEqual({ status: "rejected", reason: "not-pending" });
    expect(await test.workouts()).toEqual(before);
    expect(
      await test.store.all("SELECT * FROM plan_revision WHERE plan_id = ?", [test.planId]),
    ).toHaveLength(1);
    expect((await test.creation["plan.list"]({})).changes).toMatchObject([
      { status: "cancelled", supersededBy: null },
    ]);
    await test.creation["plan.close"]({
      commandId: "close",
      planId: test.planId,
      expectedVersion: 1,
    });
    expect((await test.creation["plan.list"]({})).changes).toEqual([]);
  });
});

async function applyChange(
  test: Awaited<ReturnType<typeof activatedPlan>>,
  changeId: string,
  expectedVersion: number,
  commandId: string,
) {
  const request = {
    commandId,
    planId: test.planId,
    changeId,
    expectedVersion,
    decision: "apply" as const,
  };
  const result = await test.changes["plan_change.apply"](request);
  expect(result).toMatchObject({ status: "applied", revisionNumber: expectedVersion + 1 });
  return { request, result };
}

async function revisionSnapshot(test: Awaited<ReturnType<typeof activatedPlan>>, revision: number) {
  const row = await test.store.get(
    "SELECT snapshot_json FROM plan_revision WHERE plan_id=? AND revision_number=?",
    [test.planId, revision],
  );
  return PlanCreationDraftSchema.parse(JSON.parse(String(row?.snapshot_json)));
}

describe("confirmed inverse Changes", () => {
  it.each([
    { kind: "weekday-duration", day: 4, minutes: 20 },
    { kind: "weekday-unavailable", day: 4 },
    { kind: "hard-weekday", day: 4 },
    { kind: "weekly-duration", hours: 1 },
    { kind: "longest-workout", minutes: 20 },
  ] satisfies PlanChangeIntent[])(
    "restores the exact prior snapshot after $kind and replays the inverse apply",
    async (intent) => {
      const test = await activatedPlan();
      const original = await revisionSnapshot(test, 1);
      const beforeRows = await test.workouts();
      const forward = await test.preview(intent);
      expect(forward.change.diff.length).toBeGreaterThan(0);
      await applyChange(test, forward.change.changeId, 1, "apply-forward");
      expect((await test.creation["plan.list"]({})).changes).toMatchObject([
        { changeId: forward.change.changeId, undo: { eligible: true } },
      ]);
      const changedRows = await test.workouts();
      const inverse = await test.preview(
        { kind: "inverse", changeId: forward.change.changeId },
        "inverse-preview",
        2,
      );
      expect(inverse.change).toMatchObject({
        title: "Undo the latest Change",
        status: "pending",
        undo: null,
        intent: { kind: "inverse", changeId: forward.change.changeId },
        premises: [
          { id: "confirmed-limits", value: { kind: "inverse", changeId: forward.change.changeId } },
          {
            id: "undone-change",
            value: { changeId: forward.change.changeId, title: forward.change.title },
          },
        ],
      });
      expect(
        [...inverse.change.diff].sort((a, b) => a.workoutId.localeCompare(b.workoutId)),
      ).toEqual(
        forward.change.diff
          .map((row) => ({ workoutId: row.workoutId, before: row.after, after: row.before }))
          .sort((a, b) => a.workoutId.localeCompare(b.workoutId)),
      );
      expect(inverse.change.totals).toEqual({
        before: forward.change.totals.after,
        after: forward.change.totals.before,
      });
      expect(await test.workouts()).toEqual(changedRows);
      const applied = await applyChange(test, inverse.change.changeId, 2, "apply-inverse");
      expect(await revisionSnapshot(test, 3)).toEqual(original);
      const restoredRows = await test.workouts();
      expect(restoredRows.map((row) => row.structure_json).sort()).toEqual(
        beforeRows.map((row) => row.structure_json).sort(),
      );
      for (const row of changedRows) {
        expect(restoredRows.find((restored) => restored.id === row.id)?.structure_json).toBe(
          beforeRows.find((before) => before.id === row.id)?.structure_json,
        );
      }
      expect((await test.creation["plan.list"]({})).changes).toMatchObject([
        {
          changeId: forward.change.changeId,
          status: "applied",
          undo: { eligible: false, reason: "not-newest" },
        },
        {
          changeId: inverse.change.changeId,
          status: "applied",
          resultRevisionNumber: 3,
          undo: { eligible: false, reason: "inverse" },
        },
      ]);
      const beforeReplay = await dumpStore(test.store);
      expect(await test.changes["plan_change.apply"](applied.request)).toEqual(applied.result);
      expect(await dumpStore(test.store)).toBe(beforeReplay);
      expect(
        await test.changes["plan_change.preview"]({
          commandId: "redo",
          planId: test.planId,
          expectedVersion: 3,
          intent: { kind: "inverse", changeId: inverse.change.changeId },
        }),
      ).toEqual({ status: "rejected", reason: "invalid-intent" });
    },
  );

  it("rejects pending and unknown targets without replacing the current preview", async () => {
    const test = await activatedPlan();
    const pending = await test.preview();
    for (const changeId of [pending.change.changeId, "01J00000000000000000000999"]) {
      const before = await dumpStore(test.store);
      expect(
        await test.changes["plan_change.preview"]({
          commandId: `inverse-${changeId}`,
          planId: test.planId,
          expectedVersion: 1,
          intent: { kind: "inverse", changeId },
        }),
      ).toEqual({ status: "rejected", reason: "invalid-intent" });
      expect(await dumpStore(test.store)).toBe(before);
    }
  });

  it("rejects changed input under a reused inverse preview command id", async () => {
    const test = await activatedPlan();
    const forward = await test.preview();
    await applyChange(test, forward.change.changeId, 1, "apply-forward");
    const inverse = await test.preview(
      { kind: "inverse", changeId: forward.change.changeId },
      "inverse",
      2,
    );
    const before = await dumpStore(test.store);
    expect(
      await test.changes["plan_change.preview"]({
        commandId: "inverse",
        planId: test.planId,
        expectedVersion: 2,
        intent: { kind: "inverse", changeId: inverse.change.changeId },
      }),
    ).toEqual({ status: "rejected", reason: "command-conflict" });
    expect(await dumpStore(test.store)).toBe(before);
  });

  it("preserves eligibility across replacement, cancellation, replay, and rejects a target after a newer apply", async () => {
    const test = await activatedPlan();
    const forward = await test.preview();
    await applyChange(test, forward.change.changeId, 1, "apply-forward");
    const current = await test.workouts();
    const inverseIntent: PlanChangeIntent = { kind: "inverse", changeId: forward.change.changeId };
    const inverse = await test.preview(inverseIntent, "inverse-preview", 2);
    const replacement = await test.preview(
      { kind: "longest-workout", minutes: 20 },
      "replacement",
      2,
    );
    expect((await test.creation["plan.list"]({})).changes).toMatchObject([
      { undo: { eligible: true } },
      { status: "superseded", undo: null },
      { status: "pending", undo: null },
    ]);
    await test.changes["plan_change.apply"]({
      commandId: "cancel-replacement",
      planId: test.planId,
      changeId: replacement.change.changeId,
      expectedVersion: 2,
      decision: "cancel",
    });
    expect(await test.preview(inverseIntent, "inverse-preview", 2)).toEqual(inverse);
    expect((await test.creation["plan.list"]({})).changes).toMatchObject([
      { undo: { eligible: true } },
      { status: "superseded", undo: null },
      { status: "cancelled", undo: null },
    ]);
    const cancelledInverse = await test.preview(inverseIntent, "cancelled-inverse", 2);
    await test.changes["plan_change.apply"]({
      commandId: "cancel-inverse",
      planId: test.planId,
      changeId: cancelledInverse.change.changeId,
      expectedVersion: 2,
      decision: "cancel",
    });
    expect(await test.workouts()).toEqual(current);
    expect(
      await test.store.all("SELECT * FROM plan_revision WHERE plan_id=?", [test.planId]),
    ).toHaveLength(2);
    const second = await test.preview(
      { kind: "longest-workout", minutes: 15 },
      "second-forward",
      2,
    );
    await applyChange(test, second.change.changeId, 2, "apply-second");
    const listed = (await test.creation["plan.list"]({})).changes;
    expect(listed.find((row) => row.changeId === forward.change.changeId)?.undo).toEqual({
      eligible: false,
      reason: "not-newest",
    });
    expect(listed.find((row) => row.changeId === second.change.changeId)?.undo).toEqual({
      eligible: true,
    });
    const before = await dumpStore(test.store);
    expect(
      await test.changes["plan_change.preview"]({
        commandId: "old-inverse",
        planId: test.planId,
        expectedVersion: 3,
        intent: inverseIntent,
      }),
    ).toEqual({ status: "rejected", reason: "invalid-intent" });
    expect(await dumpStore(test.store)).toBe(before);
  });

  it("keeps completed and past training from the current snapshot while restoring today's and future training", async () => {
    let today = 19980902;
    const test = await activatedPlan(() => today);
    const forward = await test.preview();
    await applyChange(test, forward.change.changeId, 1, "apply-forward");
    const current = await revisionSnapshot(test, 2);
    const completed = current.weeks
      .flatMap((week) => week.workouts)
      .find((workout) => workout.date === "1998-09-10");
    if (!completed) throw new Error("Expected completed Workout");
    await matchWorkout(test, completed.id, "heuristic", "confirmed");
    today = 19980908;
    const inverse = await test.preview(
      { kind: "inverse", changeId: forward.change.changeId },
      "inverse",
      2,
    );
    expect(inverse.change.diff.length).toBeGreaterThan(0);
    expect(inverse.change.diff.length).toBeLessThan(forward.change.diff.length);
    expect(
      inverse.change.diff.every(
        (row) => row.before?.date !== null && String(row.before?.date) >= "1998-09-08",
      ),
    ).toBe(true);
    expect(inverse.change.diff.some((row) => row.before?.date === "1998-09-08")).toBe(true);
    await applyChange(test, inverse.change.changeId, 2, "apply-inverse");
    const restored = await revisionSnapshot(test, 3);
    const restoredRows = new Map(
      restored.weeks.flatMap((week) => week.workouts).map((row) => [row.id, row]),
    );
    for (const workout of current.weeks.flatMap((week) => week.workouts)) {
      if (workout.id === completed.id || String(workout.date) < "1998-09-08")
        expect(restoredRows.get(workout.id)).toEqual(workout);
    }
  });

  it("reports nothing to restore for an elapsed-only difference and preserves the pending preview on refusal", async () => {
    let today = 19980902;
    const test = await activatedPlan(() => today);
    const forward = await test.preview({ kind: "weekday-unavailable", day: 4 });
    await applyChange(test, forward.change.changeId, 1, "apply-forward");
    const pending = await test.preview({ kind: "longest-workout", minutes: 20 }, "pending", 2);
    today = 19980925;
    expect(
      (await test.creation["plan.list"]({})).changes.find(
        (row) => row.changeId === forward.change.changeId,
      )?.undo,
    ).toEqual({ eligible: false, reason: "nothing-to-restore" });
    const before = await dumpStore(test.store);
    expect(
      await test.changes["plan_change.preview"]({
        commandId: "empty-inverse",
        planId: test.planId,
        expectedVersion: 2,
        intent: { kind: "inverse", changeId: forward.change.changeId },
      }),
    ).toEqual({ status: "rejected", reason: "invalid-intent" });
    expect(await dumpStore(test.store)).toBe(before);
    expect(
      (await test.creation["plan.list"]({})).changes.find(
        (row) => row.changeId === pending.change.changeId,
      )?.status,
    ).toBe("pending");
  });

  it("rejects inverse restoration when a removed Workout becomes past during review", async () => {
    let today = 19980902;
    const test = await activatedPlan(() => today);
    const forward = await test.preview({ kind: "weekday-unavailable", day: 4 });
    await applyChange(test, forward.change.changeId, 1, "apply-forward");
    const inverse = await test.preview(
      { kind: "inverse", changeId: forward.change.changeId },
      "inverse",
      2,
    );
    expect(inverse.change.diff.every((row) => row.before === null)).toBe(true);
    today = 19980904;
    const before = await dumpStore(test.store);
    expect(
      await test.changes["plan_change.apply"]({
        commandId: "apply-inverse",
        planId: test.planId,
        changeId: inverse.change.changeId,
        expectedVersion: 2,
        decision: "apply",
      }),
    ).toEqual({ status: "rejected", reason: "stale-version" });
    expect(await dumpStore(test.store)).toBe(before);
  });

  it("rejects inverse restoration when a current row was absent from the base snapshot", async () => {
    const test = await activatedPlan();
    const forward = await test.preview({ kind: "weekday-unavailable", day: 4 });
    await applyChange(test, forward.change.changeId, 1, "apply-forward");
    const inverse = await test.preview(
      { kind: "inverse", changeId: forward.change.changeId },
      "inverse",
      2,
    );
    const restored = inverse.change.diff[0]?.after;
    if (!restored) throw new Error("Expected restored Workout");
    await test.store.run(
      "INSERT INTO plan_workout (id,plan_id,date_key,sport,name,duration_s,structure_json,origin,device_id,hlc_physical_ms,hlc_counter) SELECT ?,plan_id,date_key,sport,?,?,?,'athlete',device_id,hlc_physical_ms,hlc_counter FROM plan_workout WHERE plan_id=? LIMIT 1",
      [
        "00000000000000000000000999",
        restored.name,
        restored.minutes * 60,
        canonicalJson(restored),
        test.planId,
      ],
    );
    const before = await dumpStore(test.store);
    expect(
      await test.changes["plan_change.apply"]({
        commandId: "apply-inverse",
        planId: test.planId,
        changeId: inverse.change.changeId,
        expectedVersion: 2,
        decision: "apply",
      }),
    ).toEqual({ status: "rejected", reason: "stale-version" });
    expect(await dumpStore(test.store)).toBe(before);
  });

  it.each(["elapsed", "completed", "ownership", "snapshot"] as const)(
    "rejects inverse apply after %s drift without writes",
    async (drift) => {
      let today = 19980902;
      const test = await activatedPlan(() => today);
      const forward = await test.preview();
      await applyChange(test, forward.change.changeId, 1, "apply-forward");
      const inverse = await test.preview(
        { kind: "inverse", changeId: forward.change.changeId },
        "inverse",
        2,
      );
      const changed = inverse.change.diff[0];
      if (!changed?.before) throw new Error("Expected changed Workout");
      if (drift === "elapsed") today = 19980925;
      if (drift === "completed")
        await matchWorkout(test, changed.workoutId, "platform", "confirmed");
      if (drift === "ownership")
        await test.store.run(
          "UPDATE plan_workout SET origin='athlete' WHERE plan_id=? AND json_extract(structure_json,'$.id')=?",
          [test.planId, changed.workoutId],
        );
      if (drift === "snapshot")
        await test.store.run(
          "UPDATE plan_workout SET structure_json=? WHERE plan_id=? AND json_extract(structure_json,'$.id')=?",
          [canonicalJson({ ...changed.before, minutes: 17 }), test.planId, changed.workoutId],
        );
      const before = await dumpStore(test.store);
      expect(
        await test.changes["plan_change.apply"]({
          commandId: "apply-inverse",
          planId: test.planId,
          changeId: inverse.change.changeId,
          expectedVersion: 2,
          decision: "apply",
        }),
      ).toEqual({ status: "rejected", reason: "stale-version" });
      expect(await dumpStore(test.store)).toBe(before);
    },
  );
});

describe("Plan Change transaction races", () => {
  it.each(["schedule", "inverse"] as const)(
    "excludes completion committed before the %s preview transaction",
    async (kind) => {
      const test = await activatedPlan();
      const forward = await test.preview();
      if (kind === "inverse") await applyChange(test, forward.change.changeId, 1, "apply-forward");
      const completed = forward.change.diff[0];
      if (!completed) throw new Error("Expected changed Workout");
      const transaction = test.store.transaction.bind(test.store);
      const hook = vi.spyOn(test.store, "transaction").mockImplementationOnce(async (fn) => {
        await matchWorkout(test, completed.workoutId, "platform", "confirmed");
        return transaction(fn);
      });
      const preview = await test.preview(
        kind === "inverse"
          ? { kind: "inverse", changeId: forward.change.changeId }
          : { kind: "longest-workout", minutes: 30 },
        "racing-preview",
        kind === "inverse" ? 2 : 1,
      );
      hook.mockRestore();
      expect(preview.change.diff.length).toBeGreaterThan(0);
      expect(preview.change.diff.some((row) => row.workoutId === completed.workoutId)).toBe(false);
      const before = await test.workouts();
      await applyChange(test, preview.change.changeId, kind === "inverse" ? 2 : 1, "apply-race");
      const protectedRow = before.find(
        (row) =>
          PlanCreationDraftSchema.shape.weeks.element.shape.workouts.element.parse(
            JSON.parse(String(row.structure_json)),
          ).id === completed.workoutId,
      );
      expect(protectedRow).toBeDefined();
      expect((await test.workouts()).find((row) => row.id === protectedRow?.id)).toEqual(
        protectedRow,
      );
    },
  );

  it.each(["changed", "restored"] as const)(
    "rejects a %s Workout that elapses before apply enters its transaction",
    async (kind) => {
      let today = 19980903;
      const todayDateKey = vi.fn(() => today);
      const test = await activatedPlan(todayDateKey);
      const forward = await test.preview(
        kind === "restored"
          ? { kind: "weekday-unavailable", day: 4 }
          : { kind: "longest-workout", minutes: 30 },
      );
      await applyChange(test, forward.change.changeId, 1, "apply-forward");
      const inverse = await test.preview(
        { kind: "inverse", changeId: forward.change.changeId },
        "inverse",
        2,
      );
      expect(inverse.change.diff.some((row) => row.after?.date === "1998-09-03")).toBe(true);
      const before = await dumpStore(test.store);
      todayDateKey.mockClear();
      const transaction = test.store.transaction.bind(test.store);
      const hook = vi.spyOn(test.store, "transaction").mockImplementationOnce((fn) => {
        today = 19980904;
        return transaction(fn);
      });
      expect(
        await test.changes["plan_change.apply"]({
          commandId: "apply-midnight",
          planId: test.planId,
          changeId: inverse.change.changeId,
          expectedVersion: 2,
          decision: "apply",
        }),
      ).toEqual({ status: "rejected", reason: "stale-version" });
      hook.mockRestore();
      expect(todayDateKey).toHaveBeenCalledTimes(1);
      expect(await dumpStore(test.store)).toBe(before);
    },
  );

  it("uses the transaction date for preview and the entire apply mirror window", async () => {
    let today = 19980903;
    const todayDateKey = vi.fn(() => today);
    const test = await activatedPlan(todayDateKey);
    const transaction = test.store.transaction.bind(test.store);
    const hook = vi.spyOn(test.store, "transaction").mockImplementationOnce((fn) => {
      today = 19980904;
      return transaction(fn);
    });
    todayDateKey.mockClear();
    const preview = await test.preview();
    expect(todayDateKey).toHaveBeenCalledTimes(1);
    expect(preview.change.diff.length).toBeGreaterThan(0);
    expect(preview.change.diff.every((row) => String(row.before?.date) >= "1998-09-04")).toBe(true);
    hook.mockImplementationOnce((fn) => {
      today = 19980905;
      return transaction(fn);
    });
    todayDateKey.mockClear();
    todayDateKey.mockImplementation(() => today++);
    await applyChange(test, preview.change.changeId, 1, "apply-midnight");
    hook.mockRestore();
    expect(todayDateKey).toHaveBeenCalledTimes(1);
    expect(
      await test.store.all(
        "SELECT window_start_date_key,window_end_date_key FROM plan_reconciliation_job WHERE kind='mirror' AND window_start_date_key=?",
        [19980905],
      ),
    ).toEqual([{ window_start_date_key: 19980905, window_end_date_key: 19980911 }]);
  });
});

describe("Plan Change sync age", () => {
  const now = 904_694_400_000;
  const day = 24 * 60 * 60 * 1000;

  it.each(["preview", "apply"] as const)(
    "rejects %s when sync becomes stale at transaction entry without mutations",
    async (operation) => {
      const test = await activatedPlan(undefined, { connected: true, lastSuccessfulSyncAtMs: now });
      const pending = await test.preview();
      test.setNow(now + day);
      const before = await dumpStore(test.store);
      const transaction = test.store.transaction.bind(test.store);
      const hook = vi.spyOn(test.store, "transaction").mockImplementationOnce((fn) => {
        test.setNow(now + day + 1);
        return transaction(fn);
      });
      const result =
        operation === "preview"
          ? await test.changes["plan_change.preview"]({
              commandId: "sync-race-preview",
              planId: test.planId,
              expectedVersion: 1,
              intent: { kind: "longest-workout", minutes: 20 },
            })
          : await test.changes["plan_change.apply"]({
              commandId: "sync-race-apply",
              planId: test.planId,
              expectedVersion: 1,
              changeId: pending.change.changeId,
              decision: "apply",
            });
      expect(hook).toHaveBeenCalledOnce();
      expect(result).toEqual({ status: "rejected", reason: "sync-stale" });
      expect(await dumpStore(test.store)).toBe(before);
    },
  );

  it.each([
    { name: "fresh", connected: true, lastSuccessfulSyncAtMs: now - day + 1000, paused: false },
    { name: "exactly 24 hours", connected: true, lastSuccessfulSyncAtMs: now - day, paused: false },
    { name: "stale", connected: true, lastSuccessfulSyncAtMs: now - day - 1000, paused: true },
    { name: "never synced", connected: true, lastSuccessfulSyncAtMs: null, paused: false },
    {
      name: "not connected",
      connected: false,
      lastSuccessfulSyncAtMs: now - day - 1000,
      paused: false,
    },
  ])("projects and enforces $name sync without gating creation", async (state) => {
    const test = await activatedPlan(undefined, state);
    const listed = await test.creation["plan.list"]({});
    expect(listed.changesPaused).toEqual(
      state.paused
        ? { reason: "sync-stale", lastSuccessfulSyncAtMs: state.lastSuccessfulSyncAtMs }
        : null,
    );
    const before = await dumpStore(test.store);
    const result = await test.changes["plan_change.preview"]({
      commandId: "sync-preview",
      planId: test.planId,
      expectedVersion: 1,
      intent: { kind: "longest-workout", minutes: 30 },
    });
    if (state.paused) {
      expect(result).toEqual({ status: "rejected", reason: "sync-stale" });
      expect(await dumpStore(test.store)).toBe(before);
    } else {
      if (result.status !== "previewed") throw new Error("Expected preview");
      await applyChange(test, result.change.changeId, 1, "sync-apply");
    }
  });

  it.each([null, now, now - day - 1000])(
    "uses successful sync age even when a later sync failed, last success %s",
    async (lastSuccessfulSyncAtMs) => {
      const test = await activatedPlan(undefined, { connected: true, lastSuccessfulSyncAtMs });
      await test.store.run(
        "INSERT INTO sync_failure (source,severity,detail,logical_ordinal) VALUES ('intervals-icu','warn','source temporarily unavailable',1)",
      );
      const paused = lastSuccessfulSyncAtMs !== null && now - lastSuccessfulSyncAtMs > day;
      expect((await test.creation["plan.list"]({})).changesPaused).toEqual(
        paused ? { reason: "sync-stale", lastSuccessfulSyncAtMs } : null,
      );
      const result = await test.changes["plan_change.preview"]({
        commandId: "after-sync-failure",
        planId: test.planId,
        expectedVersion: 1,
        intent: { kind: "longest-workout", minutes: 30 },
      });
      expect(result.status).toBe(paused ? "rejected" : "previewed");
      if (result.status === "previewed")
        await applyChange(test, result.change.changeId, 1, "apply-after-failure");
    },
  );

  it("recomputes the pause after disconnection and only projects it for an active Plan", async () => {
    const test = await activatedPlan(undefined, {
      connected: true,
      lastSuccessfulSyncAtMs: now - day - 1000,
    });
    expect((await test.creation["plan.list"]({})).changesPaused).not.toBeNull();
    test.setConnected(false);
    expect((await test.creation["plan.list"]({})).changesPaused).toBeNull();
    test.setConnected(true);
    await test.creation["plan.close"]({
      commandId: "close-stale",
      planId: test.planId,
      expectedVersion: 1,
    });
    expect(await test.creation["plan.list"]({})).toMatchObject({
      active: null,
      changesPaused: null,
      changes: [],
    });
  });

  it.each(["schedule", "inverse"] as const)(
    "keeps a %s preview pending while stale and still permits cancel",
    async (kind) => {
      const test = await activatedPlan(undefined, { connected: true, lastSuccessfulSyncAtMs: now });
      const forward = await test.preview();
      if (kind === "inverse") await applyChange(test, forward.change.changeId, 1, "forward");
      const version = kind === "inverse" ? 2 : 1;
      const intent: PlanChangeIntent =
        kind === "inverse"
          ? { kind: "inverse", changeId: forward.change.changeId }
          : { kind: "longest-workout", minutes: 20 };
      const pending = await test.preview(intent, "pending", version);
      test.setNow(now + day + 1);
      const before = await dumpStore(test.store);
      await expect(
        test.changes["plan_change.preview"]({
          commandId: "stale-preview",
          planId: test.planId,
          expectedVersion: version,
          intent,
        }),
      ).resolves.toEqual({ status: "rejected", reason: "sync-stale" });
      await expect(
        test.changes["plan_change.apply"]({
          commandId: "stale-apply",
          planId: test.planId,
          expectedVersion: version,
          changeId: pending.change.changeId,
          decision: "apply",
        }),
      ).resolves.toEqual({ status: "rejected", reason: "sync-stale" });
      expect(await dumpStore(test.store)).toBe(before);
      expect((await test.creation["plan.list"]({})).changes).toContainEqual(pending.change);
      await expect(
        test.changes["plan_change.apply"]({
          commandId: "cancel-stale",
          planId: test.planId,
          expectedVersion: version,
          changeId: pending.change.changeId,
          decision: "cancel",
        }),
      ).resolves.toMatchObject({ status: "cancelled", version });
    },
  );

  it.each(["fresh", "never synced", "not connected"])(
    "permits cancellation when %s",
    async (state) => {
      const test = await activatedPlan(undefined, {
        connected: state !== "not connected",
        lastSuccessfulSyncAtMs: state === "never synced" ? null : now,
      });
      const pending = await test.preview();
      await expect(
        test.changes["plan_change.apply"]({
          commandId: "cancel",
          planId: test.planId,
          expectedVersion: 1,
          changeId: pending.change.changeId,
          decision: "cancel",
        }),
      ).resolves.toMatchObject({ status: "cancelled", version: 1 });
    },
  );

  it("rechecks an aged preview at apply and clears the pause after a new activity sync", async () => {
    const test = await activatedPlan(undefined, { connected: true, lastSuccessfulSyncAtMs: now });
    const pending = await test.preview();
    test.setNow(now + day + 1);
    const request = {
      commandId: "apply-after-sync",
      planId: test.planId,
      expectedVersion: 1,
      changeId: pending.change.changeId,
      decision: "apply" as const,
    };
    await expect(test.changes["plan_change.apply"](request)).resolves.toEqual({
      status: "rejected",
      reason: "sync-stale",
    });
    expect((await test.creation["plan.list"]({})).changesPaused).not.toBeNull();
    await test.recordSync(now + day);
    expect((await test.creation["plan.list"]({})).changesPaused).toBeNull();
    await expect(test.changes["plan_change.apply"](request)).resolves.toMatchObject({
      status: "applied",
    });
  });

  it.each(["schedule", "inverse"] as const)(
    "replays recorded %s apply while stale and preserves command conflicts",
    async (kind) => {
      const test = await activatedPlan(undefined, { connected: true, lastSuccessfulSyncAtMs: now });
      const forward = await test.preview();
      const appliedForward = await applyChange(test, forward.change.changeId, 1, "forward");
      const applied =
        kind === "inverse"
          ? await applyChange(
              test,
              (
                await test.preview(
                  { kind: "inverse", changeId: forward.change.changeId },
                  "inverse",
                  2,
                )
              ).change.changeId,
              2,
              "inverse-apply",
            )
          : appliedForward;
      test.setNow(now + day + 1);
      test.calendarConnected.mockRejectedValue(new Error("Sync status is unavailable"));
      const before = await dumpStore(test.store);
      await expect(test.changes["plan_change.apply"](applied.request)).resolves.toEqual(
        applied.result,
      );
      await expect(
        test.changes["plan_change.apply"]({ ...applied.request, expectedVersion: 99 }),
      ).resolves.toEqual({ status: "rejected", reason: "command-conflict" });
      expect(await dumpStore(test.store)).toBe(before);
    },
  );
});

describe("race-window protection", () => {
  it("checks stale sync before race-window and version rejections without changing pending previews", async () => {
    const now = 904_694_400_000;
    const staleNow = now + 86_400_000 + 1;
    let today = 19980902;
    const test = await activatedPlan(
      () => today,
      { connected: true, lastSuccessfulSyncAtMs: now },
      "1998-09-09",
    );
    const forward = await test.preview({ kind: "weekday-unavailable", day: 4 });
    await applyChange(test, forward.change.changeId, 1, "reduce-training");
    const intent: PlanChangeIntent = { kind: "inverse", changeId: forward.change.changeId };
    const pending = await test.preview(intent, "restore-training", 2);
    today = 19980903;
    test.setNow(staleNow);
    const before = await dumpStore(test.store);
    for (const expectedVersion of [2, 1]) {
      await expect(
        test.changes["plan_change.preview"]({
          commandId: `stale-preview-${expectedVersion}`,
          planId: test.planId,
          expectedVersion,
          intent,
        }),
      ).resolves.toEqual({ status: "rejected", reason: "sync-stale" });
      expect(await dumpStore(test.store)).toBe(before);
      await expect(
        test.changes["plan_change.apply"]({
          commandId: `apply-restoration-${expectedVersion}`,
          planId: test.planId,
          expectedVersion,
          changeId: pending.change.changeId,
          decision: "apply",
        }),
      ).resolves.toEqual({ status: "rejected", reason: "sync-stale" });
      expect(await dumpStore(test.store)).toBe(before);
      expect((await test.creation["plan.list"]({})).changes).toContainEqual(pending.change);
    }
    await test.recordSync(staleNow);
    const afterSync = await dumpStore(test.store);
    await expect(
      test.changes["plan_change.preview"]({
        commandId: "stale-preview-2",
        planId: test.planId,
        expectedVersion: 2,
        intent,
      }),
    ).resolves.toEqual({
      status: "rejected",
      reason: "race-window",
      window: { start: "1998-09-03", end: "1998-09-09" },
    });
    expect(await dumpStore(test.store)).toBe(afterSync);
    await expect(
      test.changes["plan_change.apply"]({
        commandId: "apply-restoration-2",
        planId: test.planId,
        expectedVersion: 2,
        changeId: pending.change.changeId,
        decision: "apply",
      }),
    ).resolves.toEqual({ status: "rejected", reason: "race-window" });
    expect(await dumpStore(test.store)).toBe(afterSync);
    expect((await test.creation["plan.list"]({})).changes).toContainEqual(pending.change);
  });

  it.each([
    { kind: "weekday-unavailable", day: 4 },
    { kind: "weekday-duration", day: 4, minutes: 20 },
    { kind: "hard-weekday", day: 4 },
  ] satisfies PlanChangeIntent[])(
    "allows $kind reductions and refuses their inverse in the event window without writes",
    async (intent) => {
      const test = await activatedPlan(() => 19980903, undefined, "1998-09-09");
      const forward = await test.preview(intent);
      expect(forward.change.diff.some((row) => row.before?.date === "1998-09-03")).toBe(true);
      await applyChange(test, forward.change.changeId, 1, "reduce-training");
      const before = await dumpStore(test.store);
      await expect(
        test.changes["plan_change.preview"]({
          commandId: "restore-training",
          planId: test.planId,
          expectedVersion: 2,
          intent: { kind: "inverse", changeId: forward.change.changeId },
        }),
      ).resolves.toEqual({
        status: "rejected",
        reason: "race-window",
        window: { start: "1998-09-03", end: "1998-09-09" },
      });
      expect(await dumpStore(test.store)).toBe(before);
    },
  );

  it("allows a fitness Plan inverse on the same civil day", async () => {
    const test = await activatedPlan(() => 19980903);
    const forward = await test.preview({ kind: "weekday-unavailable", day: 4 });
    await applyChange(test, forward.change.changeId, 1, "reduce-training");
    const inverse = await test.preview(
      { kind: "inverse", changeId: forward.change.changeId },
      "restore-training",
      2,
    );
    await applyChange(test, inverse.change.changeId, 2, "apply-restoration");
  });

  it("allows increases dated outside the window while today is inside it", async () => {
    const test = await activatedPlan(() => 19980903, undefined, "1998-09-03");
    const forward = await test.preview({ kind: "weekday-unavailable", day: 6 });
    await applyChange(test, forward.change.changeId, 1, "reduce-training");
    const inverse = await test.preview(
      { kind: "inverse", changeId: forward.change.changeId },
      "restore-training",
      2,
    );
    expect(inverse.change.diff.every((row) => row.after?.date === "1998-09-05")).toBe(true);
    await applyChange(test, inverse.change.changeId, 2, "apply-restoration");
  });

  it("rechecks an inverse when today enters the window and preserves pending state, cancel, and replay", async () => {
    let today = 19980902;
    const todayDateKey = vi.fn(() => today);
    const test = await activatedPlan(todayDateKey, undefined, "1998-09-09");
    const forward = await test.preview({ kind: "weekday-unavailable", day: 4 });
    const applied = await applyChange(test, forward.change.changeId, 1, "reduce-training");
    const inverseIntent: PlanChangeIntent = { kind: "inverse", changeId: forward.change.changeId };
    const inverse = await test.preview(inverseIntent, "restore-training", 2);
    const before = await dumpStore(test.store);
    todayDateKey.mockClear();
    const transaction = test.store.transaction.bind(test.store);
    const hook = vi.spyOn(test.store, "transaction").mockImplementationOnce((fn) => {
      today = 19980903;
      return transaction(fn);
    });
    await expect(
      test.changes["plan_change.apply"]({
        commandId: "apply-restoration",
        planId: test.planId,
        expectedVersion: 2,
        changeId: inverse.change.changeId,
        decision: "apply",
      }),
    ).resolves.toEqual({ status: "rejected", reason: "race-window" });
    expect(todayDateKey).toHaveBeenCalledOnce();
    expect(hook).toHaveBeenCalledOnce();
    hook.mockRestore();
    expect(await dumpStore(test.store)).toBe(before);
    expect((await test.creation["plan.list"]({})).changes).toContainEqual(inverse.change);
    expect(await test.preview(inverseIntent, "restore-training", 2)).toEqual(inverse);
    expect(await test.changes["plan_change.apply"](applied.request)).toEqual(applied.result);
    expect(await dumpStore(test.store)).toBe(before);
    await expect(
      test.changes["plan_change.apply"]({
        commandId: "cancel-restoration",
        planId: test.planId,
        expectedVersion: 2,
        changeId: inverse.change.changeId,
        decision: "cancel",
      }),
    ).resolves.toMatchObject({ status: "cancelled", version: 2 });
  });

  it("replays an applied increasing inverse after today enters the window", async () => {
    let today = 19980902;
    const test = await activatedPlan(() => today, undefined, "1998-09-09");
    const forward = await test.preview({ kind: "weekday-unavailable", day: 4 });
    await applyChange(test, forward.change.changeId, 1, "reduce-training");
    const inverse = await test.preview(
      { kind: "inverse", changeId: forward.change.changeId },
      "restore-training",
      2,
    );
    const applied = await applyChange(test, inverse.change.changeId, 2, "apply-restoration");
    today = 19980903;
    const before = await dumpStore(test.store);
    expect(await test.changes["plan_change.apply"](applied.request)).toEqual(applied.result);
    expect(await dumpStore(test.store)).toBe(before);
  });
});

describe("FTP Plan Changes", () => {
  it.each([
    { manual: null, intervalsFtp: null, intervalsEftp: null, candidates: [] },
    {
      manual: 210,
      intervalsFtp: null,
      intervalsEftp: null,
      candidates: [{ source: "manual", watts: 210, selected: true }],
    },
    {
      manual: null,
      intervalsFtp: 205,
      intervalsEftp: null,
      candidates: [{ source: "intervals-ftp", watts: 205, selected: true }],
    },
    {
      manual: null,
      intervalsFtp: null,
      intervalsEftp: 215,
      candidates: [{ source: "intervals-eftp", watts: 215, selected: true }],
    },
    {
      manual: 210,
      intervalsFtp: 205,
      intervalsEftp: 215,
      candidates: [
        { source: "manual", watts: 210, selected: true },
        { source: "intervals-ftp", watts: 205, selected: false },
        { source: "intervals-eftp", watts: 215, selected: false },
      ],
    },
  ])("records the source values for $manual/$intervalsFtp/$intervalsEftp", async (sources) => {
    const test = await activatedPlan();
    const value = (watts: number | null) =>
      watts === null ? null : { watts, refreshedAtMs: 904_694_400_000 };
    test.setFtpSources({
      manual: value(sources.manual),
      intervalsFtp: value(sources.intervalsFtp),
      intervalsEftp: value(sources.intervalsEftp),
    });
    const preview = await test.preview({ kind: "ftp", watts: 220 });
    expect(preview.change.title).toBe("Correct FTP");
    expect(preview.change.premises.find((premise) => premise.id === "ftp-sources")).toEqual({
      id: "ftp-sources",
      label: "FTP source comparison at this decision",
      source: "Saved profile and synchronized FTP evidence",
      value: { acceptedPlanFtp: null, requestedFtp: 220, candidates: sources.candidates },
    });
    expect(test.saveManual).not.toHaveBeenCalled();
  });

  it("rejects changed source values without mutation and keeps the preview pending", async () => {
    const test = await activatedPlan();
    test.setFtpSources({ intervalsFtp: { watts: 205, refreshedAtMs: 904_694_400_000 } });
    const preview = await test.preview({ kind: "ftp", watts: 220 });
    const before = await dumpStore(test.store);
    test.setFtpSources({ intervalsFtp: { watts: 206, refreshedAtMs: 904_694_400_000 } });
    expect(
      await test.changes["plan_change.apply"]({
        commandId: "ftp-apply",
        planId: test.planId,
        expectedVersion: 1,
        changeId: preview.change.changeId,
        decision: "apply",
      }),
    ).toEqual({ status: "rejected", reason: "ftp-sources-changed" });
    expect(await dumpStore(test.store)).toEqual(before);
    expect(
      (await test.creation["plan.list"]({})).changes.find(
        (change) => change.changeId === preview.change.changeId,
      )?.status,
    ).toBe("pending");
    expect(test.saveManual).not.toHaveBeenCalled();
  });

  it("ignores refreshed timestamps, persists once after revision write, and replays without a second save", async () => {
    const test = await activatedPlan();
    test.setFtpSources({ intervalsFtp: { watts: 205, refreshedAtMs: 904_694_400_000 } });
    const preview = await test.preview({ kind: "ftp", watts: 220 });
    test.setFtpSources({ intervalsFtp: { watts: 205, refreshedAtMs: 904_694_500_000 } });
    test.saveManual.mockImplementationOnce(async () => {
      const revision = await test.store.get(
        "SELECT snapshot_json FROM plan_revision WHERE plan_id=? AND revision_number=2",
        [test.planId],
      );
      expect(revision).toBeDefined();
      expect(PlanCreationDraftSchema.parse(JSON.parse(String(revision?.snapshot_json))).ftp).toBe(
        220,
      );
    });
    const request = {
      commandId: "ftp-apply",
      planId: test.planId,
      expectedVersion: 1,
      changeId: preview.change.changeId,
      decision: "apply" as const,
    };
    const applied = await test.changes["plan_change.apply"](request);
    expect(applied.status).toBe("applied");
    test.setFtpSources({ intervalsFtp: { watts: 300, refreshedAtMs: 904_694_500_000 } });
    expect(await test.changes["plan_change.apply"](request)).toEqual(applied);
    expect(test.saveManual).toHaveBeenCalledExactlyOnceWith(220);
    expect(
      await test.changes["plan_change.preview"]({
        commandId: "change-preview",
        planId: test.planId,
        expectedVersion: 1,
        intent: { kind: "ftp", watts: 220 },
      }),
    ).toEqual(preview);
  });

  it("keeps a successful apply when saving athlete FTP fails", async () => {
    const test = await activatedPlan();
    const preview = await test.preview({ kind: "ftp", watts: 220 });
    test.saveManual.mockRejectedValueOnce(new Error("Synthetic save failure"));
    const request = {
      commandId: "ftp-apply",
      planId: test.planId,
      expectedVersion: 1,
      changeId: preview.change.changeId,
      decision: "apply" as const,
    };
    const result = await test.changes["plan_change.apply"](request);
    expect(result.status).toBe("applied");
    expect(test.logger.warn).toHaveBeenCalledExactlyOnceWith("plan_change_manual_ftp_save_failed");
    expect(await test.changes["plan_change.apply"](request)).toEqual(result);
    expect(test.saveManual).toHaveBeenCalledTimes(1);
  });

  it("cancels without rechecking or saving changed FTP sources", async () => {
    const test = await activatedPlan();
    const preview = await test.preview({ kind: "ftp", watts: 220 });
    test.setFtpSources({ manual: { watts: 200, refreshedAtMs: 904_694_400_000 } });
    expect(
      (
        await test.changes["plan_change.apply"]({
          commandId: "ftp-cancel",
          planId: test.planId,
          expectedVersion: 1,
          changeId: preview.change.changeId,
          decision: "cancel",
        })
      ).status,
    ).toBe("cancelled");
    expect(test.saveManual).not.toHaveBeenCalled();
  });

  it("allows FTP increases and their inverse in the race window and restores null FTP and power", async () => {
    const test = await activatedPlan(
      () => 19980902,
      { connected: false, lastSuccessfulSyncAtMs: null },
      "1998-09-08",
    );
    const preview = await test.preview({ kind: "ftp", watts: 220 });
    expect(preview.change.diff.length).toBeGreaterThan(0);
    expect(
      (
        await test.changes["plan_change.apply"]({
          commandId: "ftp-apply",
          planId: test.planId,
          expectedVersion: 1,
          changeId: preview.change.changeId,
          decision: "apply",
        })
      ).status,
    ).toBe("applied");
    const lower = await test.preview({ kind: "ftp", watts: 200 }, "lower-preview", 2);
    expect(
      (
        await test.changes["plan_change.apply"]({
          commandId: "lower-apply",
          planId: test.planId,
          expectedVersion: 2,
          changeId: lower.change.changeId,
          decision: "apply",
        })
      ).status,
    ).toBe("applied");
    const inverse = await test.preview(
      { kind: "inverse", changeId: lower.change.changeId },
      "inverse-preview",
      3,
    );
    expect(
      inverse.change.diff.every((row) => row.before?.power === 200 && row.after?.power === 220),
    ).toBe(true);
    expect(
      (
        await test.changes["plan_change.apply"]({
          commandId: "inverse-apply",
          planId: test.planId,
          expectedVersion: 3,
          changeId: inverse.change.changeId,
          decision: "apply",
        })
      ).status,
    ).toBe("applied");
    expect(test.saveManual).toHaveBeenCalledTimes(2);
    const second = await activatedPlan();
    const corrected = await second.preview({ kind: "ftp", watts: 220 });
    await second.changes["plan_change.apply"]({
      commandId: "ftp-apply",
      planId: second.planId,
      expectedVersion: 1,
      changeId: corrected.change.changeId,
      decision: "apply",
    });
    const restored = await second.preview(
      { kind: "inverse", changeId: corrected.change.changeId },
      "inverse-preview",
      2,
    );
    expect(restored.change.diff.every((row) => row.after?.power === null)).toBe(true);
    await second.changes["plan_change.apply"]({
      commandId: "inverse-apply",
      planId: second.planId,
      expectedVersion: 2,
      changeId: restored.change.changeId,
      decision: "apply",
    });
    const revision = await second.store.get(
      "SELECT snapshot_json FROM plan_revision WHERE plan_id=? AND revision_number=3",
      [second.planId],
    );
    expect(
      PlanCreationDraftSchema.parse(JSON.parse(String(revision?.snapshot_json))).ftp,
    ).toBeNull();
  });
});

it("restores Plan FTP through Undo when all Workouts have elapsed", async () => {
  let today = 19980902;
  const test = await activatedPlan(() => today);
  today = 19990101;
  const preview = await test.preview({ kind: "ftp", watts: 220 });
  expect(preview.change.diff).toEqual([]);
  await applyChange(test, preview.change.changeId, 1, "ftp-apply");
  const inverse = await test.preview(
    { kind: "inverse", changeId: preview.change.changeId },
    "ftp-inverse",
    2,
  );
  expect(inverse.change.diff).toEqual([]);
  await applyChange(test, inverse.change.changeId, 2, "ftp-restore");
  expect((await revisionSnapshot(test, 3)).ftp).toBeNull();
  expect(test.saveManual).toHaveBeenCalledExactlyOnceWith(220);
});

it("checks FTP source changes inside apply admission and retries the same refused command", async () => {
  const test = await activatedPlan();
  const preview = await test.preview({ kind: "ftp", watts: 220 });
  const transaction = test.store.transaction.bind(test.store);
  vi.spyOn(test.store, "transaction").mockImplementationOnce((fn) => {
    test.setFtpSources({ manual: { watts: 210, refreshedAtMs: 904_694_400_000 } });
    return transaction(fn);
  });
  const request = {
    commandId: "ftp-apply",
    planId: test.planId,
    expectedVersion: 1,
    changeId: preview.change.changeId,
    decision: "apply" as const,
  };
  expect(await test.changes["plan_change.apply"](request)).toEqual({
    status: "rejected",
    reason: "ftp-sources-changed",
  });
  test.setFtpSources({ manual: null });
  expect((await test.changes["plan_change.apply"](request)).status).toBe("applied");
  expect(test.saveManual).toHaveBeenCalledExactlyOnceWith(220);
});

it("does not read FTP evidence for other Changes or their inverse", async () => {
  const test = await activatedPlan();
  const read = vi
    .spyOn(test.ftp, "read")
    .mockRejectedValue(new Error("Synthetic unavailable FTP evidence"));
  const preview = await test.preview();
  await applyChange(test, preview.change.changeId, 1, "limit-apply");
  const inverse = await test.preview(
    { kind: "inverse", changeId: preview.change.changeId },
    "limit-inverse",
    2,
  );
  await applyChange(test, inverse.change.changeId, 2, "limit-restore");
  expect(read).not.toHaveBeenCalled();
});

describe("Supporting Event Plan Changes", () => {
  const manualIntent = {
    kind: "supporting-event",
    operation: "add",
    name: "Local autumn ride",
    date: "1998-09-05",
    role: "Training",
  } satisfies PlanChangeIntent;
  const source: PlanChangeEventSource = {
    providerId: "fixture-race",
    name: "Synchronized autumn ride",
    date: "1998-09-05",
    category: "RACE_B",
    sourceRevision: "a".repeat(64),
  };

  it("never persists an invalid Draft as a preview when a week would exceed six Workouts", async () => {
    const test = await activatedPlan();
    let version = 1;
    while ((await revisionSnapshot(test, version)).weeks[0].workouts.length < 6) {
      const index = version - 1;
      const preview = await test.preview(
        { ...manualIntent, date: "1998-09-03", name: `Local ride ${index + 1}` },
        `event-preview-${index}`,
        index + 1,
      );
      await applyChange(test, preview.change.changeId, index + 1, `event-apply-${index}`);
      version++;
    }
    const draft = await revisionSnapshot(test, version);
    expect(draft.weeks[0].workouts).toHaveLength(6);
    expect(PlanCreationDraftSchema.safeParse(draft).success).toBe(true);
    const before = await dumpStore(test.store);
    const changes = await test.store.all("SELECT * FROM plan_change ORDER BY id");
    expect(
      await test.changes["plan_change.preview"]({
        commandId: "seventh-workout-preview",
        planId: test.planId,
        expectedVersion: version,
        intent: { ...manualIntent, date: "1998-09-03" },
      }),
    ).toEqual({
      status: "rejected",
      reason: "invalid-intent",
      explanation:
        "A week can hold at most six Workouts. Remove or move one before adding this event.",
    });
    expect(await dumpStore(test.store)).toBe(before);
    expect(await test.store.all("SELECT * FROM plan_change ORDER BY id")).toEqual(changes);
    expect(await test.store.all("SELECT * FROM plan_change WHERE status = 'preview'")).toEqual([]);
  });

  it("adds a manual event without source evidence and undoes its pinned Workout and displacement", async () => {
    const test = await activatedPlan();
    const before = await test.workouts();
    test.eventSources.read.mockRejectedValue(new Error("Source reader unavailable"));
    const preview = await test.preview(manualIntent);
    expect(preview.change.title).toBe("Add a Supporting Event");
    expect(preview.change.premises.some((premise) => premise.id === "event-source")).toBe(false);
    expect(await test.workouts()).toEqual(before);
    const eventWorkout = preview.change.diff.find(
      (row) => row.after?.supportingEventId !== undefined,
    );
    if (eventWorkout?.after === null || eventWorkout?.after === undefined)
      throw new Error("Expected event Workout");
    expect(eventWorkout.after).toMatchObject({
      date: manualIntent.date,
      kind: "event",
      pinned: true,
      minutes: 45,
      guidance: "Use the accepted event limit",
    });
    expect(
      preview.change.diff.some(
        (row) => row.before?.date === manualIntent.date && row.after === null,
      ),
    ).toBe(true);
    await applyChange(test, preview.change.changeId, 1, "manual-add");
    expect((await revisionSnapshot(test, 2)).supportingEvents).toMatchObject([
      {
        name: manualIntent.name,
        date: manualIntent.date,
        role: "Training",
        source: { kind: "manual" },
      },
    ]);
    const inverse = await test.preview(
      { kind: "inverse", changeId: preview.change.changeId },
      "manual-undo",
      2,
    );
    expect(inverse.change.diff).toContainEqual({
      workoutId: eventWorkout.workoutId,
      before: eventWorkout.after,
      after: null,
    });
    await applyChange(test, inverse.change.changeId, 2, "manual-restore");
    expect((await revisionSnapshot(test, 3)).supportingEvents).toEqual([]);
    expect(test.eventSources.read).not.toHaveBeenCalled();
    expect((await revisionSnapshot(test, 3)).weeks).toEqual(test.draft.weeks);
    expect((await test.workouts()).map((row) => row.structure_json).sort()).toEqual(
      before.map((row) => row.structure_json).sort(),
    );
  });

  it("retains the event Workout database id through role and date changes", async () => {
    const test = await activatedPlan();
    const added = await test.preview(manualIntent);
    await applyChange(test, added.change.changeId, 1, "add-event");
    const event = (await revisionSnapshot(test, 2)).supportingEvents[0];
    if (event === undefined) throw new Error("Expected Supporting Event");
    const stored = await test.store.get(
      "SELECT id FROM plan_workout WHERE plan_id=? AND json_extract(structure_json,'$.supportingEventId')=?",
      [test.planId, event.id],
    );
    const important = await test.preview(
      { kind: "supporting-event", operation: "role", eventId: event.id, role: "Important" },
      "important-preview",
      2,
    );
    await applyChange(test, important.change.changeId, 2, "important-apply");
    const corrected = await test.preview(
      {
        kind: "supporting-event",
        operation: "manual",
        eventId: event.id,
        name: event.name,
        date: "1998-09-08",
      },
      "correct-preview",
      3,
    );
    await applyChange(test, corrected.change.changeId, 3, "correct-apply");
    expect(
      await test.store.get(
        "SELECT id FROM plan_workout WHERE plan_id=? AND json_extract(structure_json,'$.supportingEventId')=?",
        [test.planId, event.id],
      ),
    ).toEqual(stored);
    const snapshot = await revisionSnapshot(test, 4);
    expect(snapshot.supportingEvents[0]).toMatchObject({
      id: event.id,
      role: "Important",
      date: "1998-09-08",
    });
    expect(
      snapshot.weeks
        .flatMap((week) => week.workouts)
        .filter((workout) => workout.supportingEventId === event.id),
    ).toMatchObject([{ date: "1998-09-08", pinned: true }]);
  });

  it("renames event metadata and undoes the name without rewriting Workouts", async () => {
    const test = await activatedPlan();
    const added = await test.preview(manualIntent);
    await applyChange(test, added.change.changeId, 1, "add-event");
    const event = (await revisionSnapshot(test, 2)).supportingEvents[0];
    if (event === undefined) throw new Error("Expected Supporting Event");
    const workouts = await test.workouts();
    const renamed = await test.preview(
      { kind: "supporting-event", operation: "name", eventId: event.id, name: "A new name" },
      "rename-preview",
      2,
    );
    expect(renamed.change.diff).toEqual([]);
    await applyChange(test, renamed.change.changeId, 2, "rename-apply");
    expect((await revisionSnapshot(test, 3)).supportingEvents[0]?.name).toBe("A new name");
    expect(await test.workouts()).toEqual(workouts);
    const inverse = await test.preview(
      { kind: "inverse", changeId: renamed.change.changeId },
      "rename-undo",
      3,
    );
    expect(inverse.change.diff).toEqual([]);
    await applyChange(test, inverse.change.changeId, 3, "rename-restore");
    expect((await revisionSnapshot(test, 4)).supportingEvents[0]?.name).toBe(event.name);
    expect(await test.workouts()).toEqual(workouts);
  });

  it("captures synchronized event evidence and refuses changed or removed sources without mutation", async () => {
    const test = await activatedPlan();
    test.setEventSources([source]);
    const preview = await test.preview({ ...manualIntent, providerId: source.providerId });
    expect(preview.change.premises.find((premise) => premise.id === "event-source")).toMatchObject({
      source: "Intervals.icu event",
      value: source,
    });
    const before = await dumpStore(test.store);
    const request = {
      commandId: "synced-apply",
      planId: test.planId,
      expectedVersion: 1,
      changeId: preview.change.changeId,
      decision: "apply" as const,
    };
    for (const candidates of [[{ ...source, sourceRevision: "b".repeat(64) }], []]) {
      test.setEventSources(candidates);
      expect(await test.changes["plan_change.apply"](request)).toEqual({
        status: "rejected",
        reason: "event-source-changed",
      });
      expect(await dumpStore(test.store)).toBe(before);
      expect((await test.creation["plan.list"]({})).changes).toContainEqual(preview.change);
    }
    test.setEventSources([source]);
    const applied = await test.changes["plan_change.apply"](request);
    expect(applied.status).toBe("applied");
    const snapshot = await revisionSnapshot(test, 2);
    expect(snapshot.supportingEvents[0]).toMatchObject({
      name: source.name,
      date: source.date,
      source: {
        kind: "synced",
        providerId: source.providerId,
        sourceRevision: source.sourceRevision,
      },
    });
    test.eventSources.read.mockRejectedValue(new Error("Source reader unavailable"));
    const after = await dumpStore(test.store);
    expect(await test.changes["plan_change.apply"](request)).toEqual(applied);
    expect(await test.preview({ ...manualIntent, providerId: source.providerId })).toEqual(preview);
    expect(await dumpStore(test.store)).toBe(after);
  });

  it("rechecks source revision after entering the apply transaction", async () => {
    const test = await activatedPlan();
    test.setEventSources([source]);
    const preview = await test.preview({ ...manualIntent, providerId: source.providerId });
    const before = await dumpStore(test.store);
    const transaction = test.store.transaction.bind(test.store);
    const hook = vi.spyOn(test.store, "transaction").mockImplementationOnce((fn) => {
      test.setEventSources([{ ...source, sourceRevision: "c".repeat(64) }]);
      return transaction(fn);
    });
    expect(
      await test.changes["plan_change.apply"]({
        commandId: "source-race",
        planId: test.planId,
        expectedVersion: 1,
        changeId: preview.change.changeId,
        decision: "apply",
      }),
    ).toEqual({ status: "rejected", reason: "event-source-changed" });
    expect(hook).toHaveBeenCalledOnce();
    hook.mockRestore();
    expect(await dumpStore(test.store)).toBe(before);
  });

  it.each([
    {
      intent: { kind: "supporting-event", operation: "remove", eventId: "missing" },
      explanation: "Choose a Supporting Event already accepted in this Plan.",
    },
    {
      intent: { ...manualIntent, date: "1998-10-01" },
      explanation: "Choose a Supporting Event inside this Plan span.",
    },
    {
      intent: { ...manualIntent, date: "1998-09-06" },
      explanation: "The event date conflicts with a confirmed training limit.",
    },
  ] satisfies { intent: PlanChangeIntent; explanation: string }[])(
    "returns event validation without writing a preview: $explanation",
    async ({ intent, explanation }) => {
      const test = await activatedPlan();
      const before = await dumpStore(test.store);
      expect(
        await test.changes["plan_change.preview"]({
          commandId: "invalid-event",
          planId: test.planId,
          expectedVersion: 1,
          intent,
        }),
      ).toEqual({ status: "rejected", reason: "invalid-intent", explanation });
      expect(await dumpStore(test.store)).toBe(before);
    },
  );

  it.each([
    { intent: { ...manualIntent, name: " " }, explanation: "Enter the event name and exact date." },
    {
      intent: { ...manualIntent, date: "1998-02-30" },
      explanation: "Enter the event name and exact date.",
    },
    { intent: { ...manualIntent, role: "Ignored" }, explanation: "Choose Important or Training." },
    {
      intent: { kind: "supporting-event", operation: "remove", eventId: "" },
      explanation: "Choose a Supporting Event already accepted in this Plan.",
    },
  ])(
    "explains malformed event fields at the RPC boundary: $explanation",
    async ({ intent, explanation }) => {
      const test = await activatedPlan();
      const before = await dumpStore(test.store);
      const result = await Reflect.apply(test.changes["plan_change.preview"], undefined, [
        {
          commandId: "malformed-event",
          planId: test.planId,
          expectedVersion: 1,
          intent,
        },
      ]);
      expect(result).toEqual({ status: "rejected", reason: "invalid-intent", explanation });
      expect(await dumpStore(test.store)).toBe(before);
    },
  );

  it("refuses a date correction whose target day elapsed after preview", async () => {
    let today = 19980902;
    const test = await activatedPlan(() => today);
    const added = await test.preview({ ...manualIntent, date: "1998-09-12" });
    await applyChange(test, added.change.changeId, 1, "add-event");
    const event = (await revisionSnapshot(test, 2)).supportingEvents[0];
    if (event === undefined) throw new Error("Expected Supporting Event");
    const correction = await test.preview(
      {
        kind: "supporting-event",
        operation: "manual",
        eventId: event.id,
        name: event.name,
        date: "1998-09-05",
      },
      "correct-date",
      2,
    );
    today = 19980906;
    const before = await dumpStore(test.store);
    expect(
      await test.changes["plan_change.apply"]({
        commandId: "apply-elapsed-date",
        planId: test.planId,
        expectedVersion: 2,
        changeId: correction.change.changeId,
        decision: "apply",
      }),
    ).toEqual({ status: "rejected", reason: "stale-version" });
    expect(await dumpStore(test.store)).toBe(before);
  });

  it("captures synchronized evidence for Undo and refuses source drift", async () => {
    const test = await activatedPlan();
    test.setEventSources([source]);
    const added = await test.preview({ ...manualIntent, providerId: source.providerId });
    await applyChange(test, added.change.changeId, 1, "synced-add");
    const inverse = await test.preview(
      { kind: "inverse", changeId: added.change.changeId },
      "synced-undo",
      2,
    );
    expect(inverse.change.premises.find((premise) => premise.id === "event-source")).toMatchObject({
      source: "Intervals.icu event",
      value: source,
    });
    test.setEventSources([{ ...source, sourceRevision: "d".repeat(64) }]);
    const before = await dumpStore(test.store);
    expect(
      await test.changes["plan_change.apply"]({
        commandId: "synced-restore",
        planId: test.planId,
        expectedVersion: 2,
        changeId: inverse.change.changeId,
        decision: "apply",
      }),
    ).toEqual({ status: "rejected", reason: "event-source-changed" });
    expect(await dumpStore(test.store)).toBe(before);
    test.setEventSources([source]);
    await applyChange(test, inverse.change.changeId, 2, "synced-restore");
    expect((await revisionSnapshot(test, 3)).supportingEvents).toEqual([]);
  });

  it("cancels synchronized Changes without rereading their source", async () => {
    const test = await activatedPlan();
    test.setEventSources([source]);
    const preview = await test.preview({ ...manualIntent, providerId: source.providerId });
    const workouts = await test.workouts();
    test.eventSources.read.mockClear().mockRejectedValue(new Error("Source reader unavailable"));
    expect(
      await test.changes["plan_change.apply"]({
        commandId: "synced-cancel",
        planId: test.planId,
        expectedVersion: 1,
        changeId: preview.change.changeId,
        decision: "cancel",
      }),
    ).toMatchObject({ status: "cancelled" });
    expect(test.eventSources.read).not.toHaveBeenCalled();
    expect(await test.workouts()).toEqual(workouts);
  });
});

it("restores flexible Plan Workouts and the revision fingerprint after an Important event undo", async () => {
  const test = await activatedPlan(undefined, undefined, null, "flexible");
  const baseline = await test.preview({ kind: "ftp", watts: 220 });
  await applyChange(test, baseline.change.changeId, 1, "baseline-ftp");
  const before = await revisionSnapshot(test, 2);
  const undated = before.weeks.flatMap((week) => week.workouts);
  expect(undated.length).toBeGreaterThan(0);
  expect(undated.every((workout) => workout.date === null)).toBe(true);
  expect(await test.workouts()).toEqual([]);
  const preview = await test.preview(
    {
      kind: "supporting-event",
      operation: "add",
      name: "Local ride",
      date: "1998-09-03",
      role: "Important",
    },
    "important-preview",
    2,
  );
  expect(
    preview.change.diff.some(
      (row) => row.before?.date === null && row.before.minutes !== row.after?.minutes,
    ),
  ).toBe(true);
  expect(
    preview.change.diff.some(
      (row) => row.before?.date === null && row.before.kind !== row.after?.kind,
    ),
  ).toBe(true);
  expect(await revisionSnapshot(test, 2)).toEqual(before);
  await applyChange(test, preview.change.changeId, 2, "important-add");
  expect(await test.workouts()).toHaveLength(1);
  const inverse = await test.preview(
    { kind: "inverse", changeId: preview.change.changeId },
    "important-undo",
    3,
  );
  await applyChange(test, inverse.change.changeId, 3, "important-restore");
  const restored = await revisionSnapshot(test, 4);
  expect(restored.weeks.flatMap((week) => week.workouts)).toEqual(undated);
  expect(restored).toEqual(before);
  expect(restored.outputFingerprint).toBe(before.outputFingerprint);
  expect(await test.workouts()).toEqual([]);
  const revisions = await test.store.all(
    "SELECT fingerprint FROM plan_revision WHERE plan_id=? AND revision_number IN (2,4) ORDER BY revision_number",
    [test.planId],
  );
  expect(revisions).toHaveLength(2);
  expect(revisions[1]).toEqual(revisions[0]);
});
