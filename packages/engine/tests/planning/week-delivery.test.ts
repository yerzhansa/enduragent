import { describe, expect, it } from "vitest";
import { addCivilDays } from "@enduragent/kernel/planning";
import {
  calendarRowStart,
  currentTrainingWeekIndex,
  firstDayOfWeek,
  firstDayOfWeekFromWeekday,
  nextFirstDayOfWeek,
  thisTrainingWeekAndNext,
  trainingWeek,
  trainingWeekOfDate,
  trainingWeekPosition,
} from "../../src/planning/training-week.js";
import {
  firstChangeSetWeeks,
  weekDeliveryStatus,
  weekDeliveryStep,
  weekIsAllowed,
  weeksToSend,
  weeksWaitingForApprove,
  WEEK_DELIVERY_START,
  type WeekDelivery,
  type WeekDeliverySetting,
} from "../../src/planning/week-delivery.js";
import { walk, type Step } from "./state-walk.js";

const MONDAY = 19980713;
const THURSDAY = 19980716;
const PLAN = { startDateKey: MONDAY, totalWeeks: 3 } as const;

interface World {
  readonly today: number;
  readonly state: WeekDelivery;
  readonly setting: WeekDeliverySetting;
  readonly sent: readonly number[];
  readonly app: "running" | "quit";
  readonly connection: "online" | "offline";
  readonly ranSinceChange: "ran" | "stale";
}

function input(world: World) {
  return {
    plan: PLAN,
    state: world.state,
    setting: world.setting,
    todayDateKey: world.today,
    sentWeeks: new Set(world.sent),
  };
}

function changed(world: World, next: Partial<World>): World {
  return { ...world, ...next, ranSinceChange: "stale" };
}

function next(world: World): readonly Step<World>[] {
  const steps: Step<World>[] = [];
  if (
    world.app === "running" &&
    world.connection === "online" &&
    world.ranSinceChange === "stale"
  ) {
    const sent = [...new Set([...world.sent, ...weeksToSend(input(world))])].sort();
    steps.push(["the app runs", { ...world, sent, ranSinceChange: "ran" }]);
  }
  if (world.today < addCivilDays(MONDAY, 14)) {
    steps.push(["a week passes", changed(world, { today: addCivilDays(world.today, 7) })]);
  }
  const first = weekDeliveryStep(PLAN, world.state, {
    type: "first-approve",
    todayDateKey: world.today,
  });
  if (first.kind === "changed")
    steps.push(["the athlete approves at Save", changed(world, { state: first.state })]);
  for (const week of weeksWaitingForApprove(input(world))) {
    const approved = weekDeliveryStep(PLAN, world.state, {
      type: "approve-week",
      week,
      todayDateKey: world.today,
    });
    steps.push([`the athlete approves week ${week}`, changed(world, { state: approved.state })]);
  }
  steps.push([
    "the athlete quits or starts the app",
    changed(world, { app: world.app === "running" ? "quit" : "running" }),
  ]);
  steps.push([
    "the connection changes",
    changed(world, { connection: world.connection === "online" ? "offline" : "online" }),
  ]);
  return steps;
}

const RULES = {
  NothingWithoutConsent: (world: World) =>
    world.sent.every((week) => weekIsAllowed(world.state, world.setting, week)),
  ThisWeekAndNextAreThere: (world: World) =>
    !(world.app === "running" && world.connection === "online" && world.ranSinceChange === "ran") ||
    thisTrainingWeekAndNext(PLAN, world.today).every(
      (week) => !weekIsAllowed(world.state, world.setting, week) || world.sent.includes(week),
    ),
};

const STARTS: readonly World[] = (["send-each-week", "approve-each-week"] as const).map(
  (setting) => ({
    today: addCivilDays(MONDAY, -2),
    state: WEEK_DELIVERY_START,
    setting,
    sent: [],
    app: "running",
    connection: "online",
    ranSinceChange: "stale",
  }),
);

describe("Training Weeks on intervals.icu", () => {
  it("keeps every rule on every path of up to ten steps", () => {
    const result = walk({
      initial: STARTS,
      next,
      key: (world) => JSON.stringify(world),
      rules: RULES,
      maxDepth: 10,
    });
    expect(result.broken).toEqual([]);
    expect(result.states).toBeGreaterThan(100);
  });

  it("sends this week and next when the first Change Set is approved late", () => {
    const plan = { startDateKey: MONDAY, totalWeeks: 4 };
    const lateToday = addCivilDays(MONDAY, 15);
    expect(firstChangeSetWeeks(plan, lateToday)).toEqual([3, 4]);
    const approved = weekDeliveryStep(plan, WEEK_DELIVERY_START, {
      type: "first-approve",
      todayDateKey: lateToday,
    });
    expect(approved.state).toEqual({ kind: "approved", firstSetWeeks: [3, 4], approvedWeeks: [] });
    expect(
      weeksToSend({
        plan,
        state: approved.state,
        setting: "approve-each-week",
        todayDateKey: lateToday,
        sentWeeks: new Set(),
      }),
    ).toEqual([3, 4]);
  });

  it("sends every due week after the app was closed for more than seven days", () => {
    const plan = { startDateKey: MONDAY, totalWeeks: 6 };
    const approved = weekDeliveryStep(plan, WEEK_DELIVERY_START, {
      type: "first-approve",
      todayDateKey: MONDAY,
    });
    const back = addCivilDays(MONDAY, 22);
    expect(
      weeksToSend({
        plan,
        state: approved.state,
        setting: "send-each-week",
        todayDateKey: back,
        sentWeeks: new Set([1, 2]),
      }),
    ).toEqual([4, 5]);
  });

  it("sends nothing before the first Approve", () => {
    expect(
      weeksToSend({
        plan: PLAN,
        state: WEEK_DELIVERY_START,
        setting: "send-each-week",
        todayDateKey: MONDAY,
        sentWeeks: new Set(),
      }),
    ).toEqual([]);
  });

  it("waits for each later week's Approve when the setting asks", () => {
    const approved = weekDeliveryStep(PLAN, WEEK_DELIVERY_START, {
      type: "first-approve",
      todayDateKey: MONDAY,
    }).state;
    const weekTwo = addCivilDays(MONDAY, 7);
    const waiting = {
      plan: PLAN,
      state: approved,
      setting: "approve-each-week" as const,
      todayDateKey: weekTwo,
      sentWeeks: new Set([1, 2]),
    };
    expect(weeksToSend(waiting)).toEqual([]);
    expect(weeksWaitingForApprove(waiting)).toEqual([3]);
    expect(weekDeliveryStatus({ ...waiting, week: 3 })).toEqual({
      kind: "waiting-for-week-approve",
    });
    const third = weekDeliveryStep(PLAN, approved, {
      type: "approve-week",
      week: 3,
      todayDateKey: weekTwo,
    });
    expect(weeksToSend({ ...waiting, state: third.state })).toEqual([3]);
    expect(
      weekDeliveryStep(PLAN, third.state, { type: "approve-week", week: 3, todayDateKey: weekTwo }),
    ).toMatchObject({ kind: "refused", reason: "already-approved" });
    expect(
      weekDeliveryStep(PLAN, approved, { type: "approve-week", week: 3, todayDateKey: MONDAY }),
    ).toMatchObject({
      kind: "refused",
      reason: "week-not-due",
    });
  });

  it("labels each week with when it goes out", () => {
    const plan = { startDateKey: MONDAY, totalWeeks: 4 };
    const approved = weekDeliveryStep(plan, WEEK_DELIVERY_START, {
      type: "first-approve",
      todayDateKey: MONDAY,
    }).state;
    const base = {
      plan,
      state: approved,
      setting: "send-each-week" as const,
      todayDateKey: MONDAY,
      sentWeeks: new Set([1]),
    };
    expect(weekDeliveryStatus({ ...base, week: 1 })).toEqual({ kind: "on-intervals" });
    expect(weekDeliveryStatus({ ...base, week: 2 })).toEqual({ kind: "due" });
    expect(weekDeliveryStatus({ ...base, week: 3 })).toEqual({
      kind: "goes-out",
      onDateKey: addCivilDays(MONDAY, 7),
    });
    expect(weekDeliveryStatus({ ...base, setting: "approve-each-week", week: 3 })).toEqual({
      kind: "approve-from",
      onDateKey: addCivilDays(MONDAY, 7),
    });
    const waiting = { ...base, state: WEEK_DELIVERY_START, sentWeeks: new Set<number>() };
    expect(weekDeliveryStatus({ ...waiting, week: 1 })).toEqual({
      kind: "waiting-for-first-approve",
    });
    expect(weekDeliveryStatus({ ...waiting, week: 2 })).toEqual({
      kind: "waiting-for-first-approve",
    });
    expect(weekDeliveryStatus({ ...waiting, week: 3 })).toEqual({
      kind: "goes-out",
      onDateKey: addCivilDays(MONDAY, 7),
    });
    expect(weekDeliveryStatus({ ...base, todayDateKey: addCivilDays(MONDAY, 8), week: 1 })).toEqual(
      { kind: "on-intervals" },
    );
    expect(
      weekDeliveryStatus({
        ...base,
        sentWeeks: new Set(),
        todayDateKey: addCivilDays(MONDAY, 8),
        week: 1,
      }),
    ).toEqual({ kind: "passed" });
  });
});

describe("Training Weeks and calendar rows", () => {
  it("starts calendar rows on the region's first day", () => {
    expect(calendarRowStart(THURSDAY, firstDayOfWeek(1))).toBe(MONDAY);
    expect(calendarRowStart(THURSDAY, firstDayOfWeek(7))).toBe(19980712);
    expect(calendarRowStart(THURSDAY, firstDayOfWeek(6))).toBe(19980711);
    expect(calendarRowStart(MONDAY, firstDayOfWeek(1))).toBe(MONDAY);
    expect(() => firstDayOfWeek(0)).toThrow("invalid-first-day");
    expect(firstDayOfWeekFromWeekday(0)).toBe(7);
    expect(firstDayOfWeekFromWeekday(1)).toBe(1);
  });

  it("defaults a new Plan to the next first day of the week", () => {
    expect(nextFirstDayOfWeek(THURSDAY, firstDayOfWeek(1))).toBe(19980720);
    expect(nextFirstDayOfWeek(MONDAY, firstDayOfWeek(1))).toBe(MONDAY);
    expect(nextFirstDayOfWeek(THURSDAY, firstDayOfWeek(7))).toBe(19980719);
  });

  it("counts Training Weeks from the Plan's own start day", () => {
    const plan = { startDateKey: THURSDAY, totalWeeks: 12 };
    expect(trainingWeek(plan, 3)).toEqual({
      index: 3,
      startDateKey: 19980730,
      endDateKey: 19980805,
      sendDateKey: 19980723,
    });
    expect(trainingWeekOfDate(plan, 19980722)).toBe(1);
    expect(trainingWeekOfDate(plan, 19980723)).toBe(2);
    expect(trainingWeekOfDate(plan, MONDAY)).toBeNull();
    expect(trainingWeekPosition(plan, MONDAY)).toMatchObject({ kind: "before-plan" });
    expect(currentTrainingWeekIndex(plan, MONDAY)).toBe(1);
    expect(thisTrainingWeekAndNext(plan, MONDAY)).toEqual([1, 2]);
    expect(thisTrainingWeekAndNext(plan, addCivilDays(THURSDAY, 7 * 11))).toEqual([12]);
    expect(thisTrainingWeekAndNext(plan, addCivilDays(THURSDAY, 7 * 12))).toEqual([]);
  });
});
