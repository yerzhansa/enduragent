import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  PlanCalendarRpcResultSchema,
  type PlanCalendarRideReview,
  type PlanCalendarRpcParams,
  type PlanCalendarVerdictExpected,
} from "@enduragent/coach-contract";
import type { CoachTextFacts } from "@enduragent/engine/calendar";
import {
  createPlanRepository,
  createPlanWorkoutMatchRepository,
  type PlanWorkoutRecord,
} from "@enduragent/kernel/planning";
import { runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { createMemoryPlanCalendar } from "../../../apps/desktop/tests/helpers/plan-calendar-fake.js";
import { createPlanCalendarOperations } from "../src/plan-calendar-operations.js";
import { VERDICT_LEASE_MS, type RideVerdictModel } from "../src/plan-calendar-review.js";
import { seedReviewRide, type ReviewRideFacts } from "./helpers/review-ride.js";

const MONDAY = 19980105;
const TODAY = 19980114;
const PLAN_ID = `${"0".repeat(25)}P`;
const RIDE = "1".repeat(64);
const START_MS = 904_694_400_000;

function workoutId(index: number): string {
  return `${"0".repeat(24)}${String(10 + index)}`;
}

function planWorkout(index: number, dateKey: number): PlanWorkoutRecord {
  return {
    id: workoutId(index),
    planId: PLAN_ID,
    dateKey,
    sport: "Ride",
    name: `Endurance ${index}`,
    durationS: 3_600,
    structureJson: "{}",
    origin: "coach",
    deviceId: "test-device",
    hlcPhysicalMs: 1,
    hlcCounter: 0,
  };
}

interface Pending {
  readonly facts: CoachTextFacts;
  resolve(text: string): void;
  reject(error: Error): void;
}

function scriptedModel() {
  const pending: Pending[] = [];
  let available = true;
  const model: RideVerdictModel = {
    available: () => available,
    writeCoachText: (facts) =>
      new Promise<string>((resolve, reject) => {
        pending.push({ facts, resolve, reject });
      }),
  };
  return {
    model,
    pending,
    setAvailable(next: boolean) {
      available = next;
    },
  };
}

async function harness(options: { readonly plan?: boolean; readonly model?: boolean } = {}) {
  const store = openSqliteStorage(":memory:");
  await runMigrations(store, MIGRATIONS);
  onTestFinished(async () => {
    await store.close();
  });
  let now = START_MS;
  let sequence = 500;
  const scripted = scriptedModel();
  const operations = createPlanCalendarOperations({
    store,
    calendar: createMemoryPlanCalendar(),
    identity: {
      deviceId: async () => "review-test-device",
      newUlid: () => String(++sequence).padStart(26, "0"),
      hlcStamp: () => ({ physicalMs: now, counter: ++sequence }),
    },
    applyChange: async () => ({ status: "rejected", reason: "stale-version" }) as never,
    todayDateKey: () => TODAY,
    now: () => now,
    calendarConnected: () => true,
    dateKeyOfMs: () => TODAY,
    changed: async () => undefined,
    ...(options.model === false ? {} : { coachText: scripted.model }),
  });
  if (options.plan !== false) {
    await createPlanRepository(store).replace(
      {
        id: PLAN_ID,
        originId: null,
        name: "Synthetic base",
        primaryGoal: "Ride longer",
        startDateKey: MONDAY,
        targetDateKey: null,
        status: "active",
        kind: "full_plan",
        totalWeeks: 12,
        weekStartDay: 1,
        structureJson: "{}",
        createdAtMs: 1,
        updatedAtMs: 1,
        deviceId: "test-device",
        hlcPhysicalMs: 1,
        hlcCounter: 0,
      },
      [planWorkout(1, MONDAY), planWorkout(2, MONDAY + 1), planWorkout(3, MONDAY + 4)],
    );
    await store.run(
      `INSERT INTO planning_plan (plan_id,status,version,current_revision_number,activated_at_ms,updated_at_ms,device_id,hlc_physical_ms,hlc_counter)
       VALUES (?,'active',1,1,1,1,'test-device',1,0)`,
      [PLAN_ID],
    );
  }
  const ride = (key: string, dateKey: number, facts: ReviewRideFacts) =>
    seedReviewRide(store, key, dateKey, facts);
  const match = (planWorkout: number, decision: "confirmed" | "suggested", dateKey = MONDAY) =>
    createPlanWorkoutMatchRepository(store).observe({
      id: `${"0".repeat(24)}M${planWorkout}`,
      planId: PLAN_ID,
      planWorkoutId: workoutId(planWorkout),
      activityId: RIDE,
      providerActivityId: null,
      providerEventId: null,
      source: "heuristic",
      decision,
      activityDateKey: dateKey,
      activitySport: "cycling",
      activityDurationS: 3_540,
      observedAtMs: 1,
      decidedAtMs: decision === "confirmed" ? 1 : null,
      deviceId: "test-device",
      hlcPhysicalMs: 1,
      hlcCounter: 0,
    });
  const call = async (request: PlanCalendarRpcParams) =>
    PlanCalendarRpcResultSchema.parse(await operations["plan.calendar"](request));
  const reviewOf = async (request: PlanCalendarRpcParams): Promise<PlanCalendarRideReview> => {
    const result = await call(request);
    if (result.status !== "review") throw new Error(`Expected a review, got ${result.status}`);
    return result.review;
  };
  const read = () => reviewOf({ action: "read-review", activityId: RIDE });
  const write = (event: "opens" | "asks-again", expected: PlanCalendarVerdictExpected) =>
    call({ action: "write-verdict", activityId: RIDE, event, expected });
  const settle = async (expected: string) => {
    await vi.waitFor(async () => {
      expect((await read()).verdict.state).toBe(expected);
    });
    return read();
  };
  return {
    store,
    scripted,
    ride,
    match,
    call,
    read,
    write,
    settle,
    saveNote: (note: string) => reviewOf({ action: "save-note", activityId: RIDE, note }),
    advance(ms: number) {
      now += ms;
    },
  };
}

async function keptOnFirstOpen(
  h: Awaited<ReturnType<typeof harness>>,
  text = "Steady and on plan.",
) {
  await h.ride(RIDE, MONDAY, { watts: 181 });
  await h.match(1, "confirmed");
  const opened = await h.write("opens", { state: "not-written", replies: 0 });
  expect(opened).toMatchObject({ status: "review", review: { verdict: { state: "writing" } } });
  h.scripted.pending[0]?.resolve(text);
  return h.settle("kept");
}

describe("the coach's verdict on Activity review", () => {
  it("writes the verdict once on first open and not again on a second open", async () => {
    const h = await harness();
    await h.ride(RIDE, MONDAY, { watts: 181 });
    await h.match(1, "confirmed");
    expect(await h.read()).toEqual({
      activityId: RIDE,
      verdict: { state: "not-written" },
      replies: 0,
      blocked: "none",
      note: null,
    });
    const opened = await h.write("opens", { state: "not-written", replies: 0 });
    expect(opened).toMatchObject({ review: { verdict: { state: "writing" }, replies: 1 } });
    expect(h.scripted.pending).toHaveLength(1);
    expect(h.scripted.pending[0]?.facts).toMatchObject({
      ride: { date: "1998-01-05", kind: "road", averagePowerW: 181, durationS: 3_540 },
      matched: {
        kind: "workout",
        workout: { date: "1998-01-05", name: "Endurance 1", durationS: 3_600 },
      },
      week: { trainingWeek: 1 },
      note: null,
    });
    expect(h.scripted.pending[0]?.facts.week?.workouts.map((workout) => workout.name)).toEqual([
      "Endurance 1",
      "Endurance 2",
      "Endurance 3",
    ]);
    h.scripted.pending[0]?.resolve("Steady and on plan.");
    expect(await h.settle("kept")).toEqual({
      activityId: RIDE,
      verdict: {
        state: "kept",
        text: "Steady and on plan.",
        writtenAtMs: START_MS,
        trigger: "opened",
        usedPlan: true,
        usedNote: false,
        marker: { kind: "current" },
      },
      replies: 1,
      blocked: "none",
      note: null,
    });
    const again = await h.write("opens", { state: "kept", replies: 1 });
    expect(again).toMatchObject({ review: { verdict: { state: "kept" }, replies: 1 } });
    expect(h.scripted.pending).toHaveLength(1);
  });

  it("makes a new reply when the athlete presses Write again", async () => {
    const h = await harness();
    await keptOnFirstOpen(h);
    const asked = await h.write("asks-again", { state: "kept", replies: 1 });
    expect(asked).toMatchObject({ review: { verdict: { state: "writing" }, replies: 2 } });
    h.scripted.pending[1]?.resolve("Second look: still steady.");
    expect(await h.settle("kept")).toMatchObject({
      verdict: { text: "Second look: still steady.", trigger: "asked", usedNote: false },
      replies: 2,
    });
    expect(h.scripted.pending).toHaveLength(2);
  });

  it("keeps a failure honest and writes again when asked", async () => {
    const h = await harness();
    await h.ride(RIDE, MONDAY, { heartRate: 131 });
    await h.match(1, "confirmed");
    await h.write("opens", { state: "not-written", replies: 0 });
    h.scripted.pending[0]?.reject(new Error("provider down"));
    expect(await h.settle("failed")).toMatchObject({ verdict: { state: "failed" }, replies: 1 });
    await h.write("asks-again", { state: "failed", replies: 1 });
    h.scripted.pending[1]?.resolve("Heart rate only, and steady.");
    expect(await h.settle("kept")).toMatchObject({
      verdict: { text: "Heart rate only, and steady.", trigger: "asked" },
      replies: 2,
    });
  });

  it("writes a failed verdict again when the athlete next opens the ride", async () => {
    const h = await harness();
    await h.ride(RIDE, MONDAY, { watts: 181 });
    await h.match(1, "confirmed");
    await h.write("opens", { state: "not-written", replies: 0 });
    h.scripted.pending[0]?.reject(new Error("provider down"));
    await h.settle("failed");
    await h.write("opens", { state: "failed", replies: 1 });
    expect(h.scripted.pending).toHaveLength(2);
    h.scripted.pending[1]?.resolve("Written on the second open.");
    expect(await h.settle("kept")).toMatchObject({ verdict: { trigger: "opened" }, replies: 2 });
  });

  it("writes after the athlete answers the match and marks a kept verdict when the match changes", async () => {
    const h = await harness();
    await h.ride(RIDE, MONDAY, { watts: 181 });
    await h.match(1, "suggested");
    expect(await h.read()).toMatchObject({ blocked: "waiting-for-match" });
    const waiting = await h.write("opens", { state: "not-written", replies: 0 });
    expect(waiting).toMatchObject({ review: { verdict: { state: "not-written" }, replies: 0 } });
    expect(h.scripted.pending).toHaveLength(0);
    const decide = (
      expected: Extract<PlanCalendarRpcParams, { action: "decide-ride" }>["expected"],
      decision: Extract<PlanCalendarRpcParams, { action: "decide-ride" }>["decision"],
    ) => h.call({ action: "decide-ride", planId: PLAN_ID, activityId: RIDE, expected, decision });
    expect(
      await decide(
        { kind: "suggested", planWorkoutId: workoutId(1) },
        { kind: "confirm", planWorkoutId: workoutId(1) },
      ),
    ).toMatchObject({ status: "ride" });
    expect(h.scripted.pending).toHaveLength(1);
    h.scripted.pending[0]?.resolve("Matched and steady.");
    expect(await h.settle("kept")).toMatchObject({
      verdict: { trigger: "matched", marker: { kind: "current" } },
      replies: 1,
    });
    await decide({ kind: "confirmed", planWorkoutId: workoutId(1) }, { kind: "extra" });
    expect(await h.read()).toMatchObject({
      verdict: { state: "kept", text: "Matched and steady.", marker: { kind: "matched-extra" } },
      replies: 1,
    });
    await decide({ kind: "none" }, { kind: "rematch", planWorkoutId: workoutId(2) });
    expect(await h.read()).toMatchObject({
      verdict: { state: "kept", marker: { kind: "matched-to", name: "Endurance 2" } },
      replies: 1,
    });
    expect(h.scripted.pending).toHaveLength(1);
    await h.write("asks-again", { state: "kept", replies: 1 });
    h.scripted.pending[1]?.resolve("Now read against Tuesday.");
    expect(await h.settle("kept")).toMatchObject({
      verdict: { marker: { kind: "current" } },
      replies: 2,
    });
    expect(h.scripted.pending[1]?.facts.matched).toMatchObject({
      kind: "workout",
      workout: { name: "Endurance 2" },
    });
  });

  it("writes once when two windows or a double click ask at the same time", async () => {
    const h = await harness();
    await h.ride(RIDE, MONDAY, { watts: 181 });
    await h.match(1, "confirmed");
    const both = await Promise.all([
      h.write("opens", { state: "not-written", replies: 0 }),
      h.write("opens", { state: "not-written", replies: 0 }),
    ]);
    expect(both.map((result) => result.status).sort()).toEqual(["refused", "review"]);
    expect(both).toContainEqual({ status: "refused", reason: "review-changed" });
    expect(h.scripted.pending).toHaveLength(1);
    h.scripted.pending[0]?.resolve("Once.");
    await h.settle("kept");
    const again = await Promise.all([
      h.write("asks-again", { state: "kept", replies: 1 }),
      h.write("asks-again", { state: "kept", replies: 1 }),
    ]);
    expect(again.map((result) => result.status).sort()).toEqual(["refused", "review"]);
    expect(h.scripted.pending).toHaveLength(2);
  });

  it("writes nothing and says so when no model is configured", async () => {
    const h = await harness({ model: false });
    await h.ride(RIDE, MONDAY, { watts: 181 });
    await h.match(1, "confirmed");
    expect(await h.read()).toMatchObject({
      verdict: { state: "not-written" },
      blocked: "no-model",
    });
    expect(await h.write("opens", { state: "not-written", replies: 0 })).toMatchObject({
      review: { verdict: { state: "not-written" }, replies: 0, blocked: "no-model" },
    });
    const switchedOff = await harness();
    await switchedOff.ride(RIDE, MONDAY, { watts: 181 });
    switchedOff.scripted.setAvailable(false);
    await switchedOff.write("opens", { state: "not-written", replies: 0 });
    expect(switchedOff.scripted.pending).toHaveLength(0);
    expect(await switchedOff.read()).toMatchObject({ blocked: "no-model", replies: 0 });
  });

  it("never writes a verdict for a ride without file data", async () => {
    const h = await harness();
    await h.ride(RIDE, MONDAY, {});
    await h.match(1, "confirmed");
    expect(await h.read()).toMatchObject({ blocked: "no-file" });
    expect(await h.write("opens", { state: "not-written", replies: 0 })).toMatchObject({
      review: { verdict: { state: "not-written" }, replies: 0 },
    });
    expect(h.scripted.pending).toHaveLength(0);
  });

  it("saves the note without rewriting, and sends it only when the athlete asks again", async () => {
    const h = await harness();
    await keptOnFirstOpen(h);
    expect(await h.saveNote("  Legs heavy after Tuesday.  ")).toMatchObject({
      verdict: { state: "kept", text: "Steady and on plan.", usedNote: false },
      replies: 1,
      note: { text: "Legs heavy after Tuesday.", savedAtMs: START_MS },
    });
    await h.write("opens", { state: "kept", replies: 1 });
    expect(h.scripted.pending).toHaveLength(1);
    await h.write("asks-again", { state: "kept", replies: 1 });
    expect(h.scripted.pending[1]?.facts.note).toBe("Legs heavy after Tuesday.");
    h.scripted.pending[1]?.resolve("Heavy legs explain the fade.");
    expect(await h.settle("kept")).toMatchObject({
      verdict: { usedNote: true, trigger: "asked" },
      note: { text: "Legs heavy after Tuesday." },
    });
    expect(await h.saveNote("   ")).toMatchObject({ note: null, verdict: { state: "kept" } });
  });

  it("leaves the note out of a write the athlete did not ask for", async () => {
    const h = await harness();
    await h.ride(RIDE, MONDAY, { watts: 181 });
    await h.match(1, "confirmed");
    await h.write("opens", { state: "not-written", replies: 0 });
    h.scripted.pending[0]?.reject(new Error("provider down"));
    await h.settle("failed");
    await h.saveNote("Legs heavy.");
    await h.write("opens", { state: "failed", replies: 1 });
    expect(h.scripted.pending[1]?.facts.note).toBeNull();
  });

  it("fails a write that outlived its lease and ignores the late reply", async () => {
    const h = await harness();
    await h.ride(RIDE, MONDAY, { watts: 181 });
    await h.match(1, "confirmed");
    await h.write("opens", { state: "not-written", replies: 0 });
    h.advance(VERDICT_LEASE_MS - 1);
    expect(await h.read()).toMatchObject({ verdict: { state: "writing" } });
    h.advance(1);
    expect(await h.read()).toMatchObject({ verdict: { state: "failed" }, replies: 1 });
    h.scripted.pending[0]?.resolve("Too late.");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await h.read()).toMatchObject({ verdict: { state: "failed" }, replies: 1 });
  });

  it("writes from the ride alone when there is no Plan", async () => {
    const h = await harness({ plan: false });
    await h.ride(RIDE, MONDAY, { watts: 176 });
    await h.write("opens", { state: "not-written", replies: 0 });
    expect(h.scripted.pending[0]?.facts).toMatchObject({
      matched: { kind: "no-plan" },
      week: null,
    });
    h.scripted.pending[0]?.resolve("An easy ride.");
    expect(await h.settle("kept")).toMatchObject({ verdict: { usedPlan: false } });
  });

  it("refuses a ride it cannot find", async () => {
    const h = await harness();
    expect(await h.call({ action: "read-review", activityId: "f".repeat(64) })).toEqual({
      status: "refused",
      reason: "review-changed",
    });
  });
});
