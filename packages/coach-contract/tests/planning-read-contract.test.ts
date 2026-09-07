import { describe, expect, it } from "vitest";
import {
  GetPlanningReadModelRpcParamsSchema,
  PlanningReadModelSchema,
  ListPlansParamsSchema,
  ListPlansResultSchema,
  PlanSummarySchema,
  LegacyPlanSummarySchema,
} from "../src/index.js";

describe("Planning read contract", () => {
  it("accepts a strict no-Plan projection", () => {
    expect(
      PlanningReadModelSchema.parse({
        schemaVersion: 1,
        status: "no-plan",
        asOfDateKey: 20260826,
        plan: null,
      }),
    ).toEqual({ schemaVersion: 1, status: "no-plan", asOfDateKey: 20260826, plan: null });
    expect(GetPlanningReadModelRpcParamsSchema.safeParse({ extra: true }).success).toBe(false);
  });

  it("rejects a today Workout outside the current week projection", () => {
    const workout = {
      id: "workout-1",
      dateKey: 20260826,
      sport: "cycling",
      name: "Tempo",
      durationSeconds: 3600,
      origin: "coach" as const,
      navigation: {
        destination: "plan" as const,
        focus: "workout" as const,
        entityId: "workout-1",
      },
    };
    const value = {
      schemaVersion: 1,
      status: "ready",
      asOfDateKey: 20260826,
      plan: {
        id: "plan-1",
        name: "Base",
        goal: "Consistency",
        lifecycle: "active",
        startDateKey: 20260824,
        targetDateKey: null,
        currentWeek: 1,
        totalWeeks: 12,
        phase: "Base",
        weekStartDateKey: 20260824,
        weekEndDateKey: 20260830,
        workouts: [],
        todayWorkout: workout,
        navigation: { destination: "plan", focus: "active-plan", entityId: "plan-1" },
      },
    };
    expect(PlanningReadModelSchema.safeParse(value).success).toBe(false);
  });
});

describe("Plan library contract", () => {
  const active = {
    planId: "plan-active",
    name: "Build fitness",
    start: "1998-12-21",
    end: "1999-01-17",
    weeks: 4,
    status: "active",
    closeReason: null,
    closedAt: null,
    activatedAt: "1998-12-20",
    calendar: { status: "pending", window: null, currentThrough: null, error: null },
    version: 1,
    creationId: "creation-active",
  };

  it("accepts the empty library and strict empty params", () => {
    const empty = {
      calendarConnected: false,
      legacy: null,
      creation: null,
      active: null,
      closed: [],
      changes: [],
      changesPaused: null,
    };
    expect(ListPlansParamsSchema.parse({})).toEqual({});
    expect(ListPlansResultSchema.parse(empty)).toEqual(empty);
    expect(ListPlansParamsSchema.safeParse({ planId: "extra" }).success).toBe(false);
    expect(ListPlansResultSchema.safeParse({ ...empty, extra: true }).success).toBe(false);
  });

  it("accepts a read-only legacy summary and rejects invented or invalid fields", () => {
    const legacy = {
      name: "8-Week Plan",
      goal: "Gran Fondo",
      weeks: 8,
      sourceStatus: "draft",
      createdAt: "1998-07-04",
      targetDate: "1998-08-30",
      readOnly: true,
      source: "current-plan.json",
    };
    const library = {
      calendarConnected: false,
      legacy,
      creation: null,
      active: null,
      closed: [],
      changes: [],
      changesPaused: null,
    };
    expect(LegacyPlanSummarySchema.parse(legacy)).toEqual(legacy);
    expect(ListPlansResultSchema.parse(library)).toEqual(library);
    for (const invalid of [{ version: 1 }, { readOnly: false }, { weeks: 0 }]) {
      expect(
        ListPlansResultSchema.safeParse({
          ...library,
          legacy: { ...legacy, ...invalid },
        }).success,
      ).toBe(false);
    }
    const { legacy: omitted, ...withoutLegacy } = library;
    expect(omitted).toEqual(legacy);
    expect(ListPlansResultSchema.safeParse(withoutLegacy).success).toBe(false);
  });

  it("requires an explicit pause state and preserves the last successful sync timestamp", () => {
    const library = {
      calendarConnected: true,
      legacy: null,
      creation: null,
      active: { ...active, todayChoice: null },
      closed: [],
      changes: [],
    };
    expect(ListPlansResultSchema.safeParse(library).success).toBe(false);
    for (const changesPaused of [
      null,
      { reason: "sync-stale", lastSuccessfulSyncAtMs: Date.parse("1998-12-20T00:00:00Z") },
    ]) {
      expect(ListPlansResultSchema.parse({ ...library, changesPaused }).changesPaused).toEqual(
        changesPaused,
      );
    }
    for (const changesPaused of [
      undefined,
      { reason: "sync-stale" },
      { reason: "sync-stale", lastSuccessfulSyncAtMs: null },
      { reason: "sync-stale", lastSuccessfulSyncAtMs: "1998-12-20T00:00:00Z" },
      { reason: "sync-stale", lastSuccessfulSyncAtMs: Infinity },
      { reason: "not-connected", lastSuccessfulSyncAtMs: 0 },
      { reason: "sync-stale", lastSuccessfulSyncAtMs: 0, awaitingSync: true },
    ]) {
      expect(ListPlansResultSchema.safeParse({ ...library, changesPaused }).success).toBe(false);
    }
  });

  it("requires an explicit boolean calendar connection independently of library contents", () => {
    const library = {
      legacy: null,
      creation: null,
      active: null,
      closed: [],
      changes: [],
      changesPaused: null,
    };
    expect(ListPlansResultSchema.safeParse(library).success).toBe(false);
    expect(ListPlansResultSchema.safeParse({ ...library, calendarConnected: "true" }).success).toBe(
      false,
    );
    for (const calendarConnected of [false, true]) {
      expect(ListPlansResultSchema.parse({ ...library, calendarConnected }).calendarConnected).toBe(
        calendarConnected,
      );
    }
  });

  it.each(["stopped", "completed", "legacy-unclassified"])(
    "accepts %s closed history",
    (closeReason) => {
      const closed = {
        ...active,
        planId: "plan-closed",
        status: "closed",
        closeReason,
        closedAt: "1999-01-18",
        activatedAt: null,
        calendar: { status: "pending", window: null, currentThrough: null, error: null },
        creationId: null,
      };
      const library = {
        calendarConnected: false,
        legacy: null,
        creation: null,
        active: { ...active, todayChoice: null },
        closed: [closed],
        changes: [],
        changesPaused: null,
      };
      expect(ListPlansResultSchema.parse(library)).toEqual(library);
      expect(ListPlansResultSchema.safeParse({ ...library, active: closed }).success).toBe(false);
      expect(ListPlansResultSchema.safeParse({ ...library, closed: [active] }).success).toBe(false);
    },
  );

  it("accepts the calendar shape and enforces status requirements", () => {
    const calendar = {
      status: "verified",
      window: { start: "1998-12-21", end: "1998-12-27" },
      currentThrough: "1998-12-27",
      error: null,
    };
    expect(PlanSummarySchema.parse({ ...active, calendar }).calendar).toEqual(calendar);
    for (const invalid of [
      { ...calendar, currentThrough: null },
      { status: "verified", window: calendar.window, error: null },
      { ...calendar, status: "unknown" },
      { ...calendar, status: "failed", error: null },
      { ...calendar, status: "pending", error: "failure" },
      { ...calendar, status: "not-connected", error: "failure" },
      { ...calendar, extra: true },
      { ...calendar, window: { ...calendar.window, extra: true } },
      { ...calendar, window: { start: "1998-02-30", end: "1998-12-27" } },
    ])
      expect(PlanSummarySchema.safeParse({ ...active, calendar: invalid }).success).toBe(false);
    const { calendar: omitted, ...withoutCalendar } = active;
    expect(omitted).toBeDefined();
    expect(PlanSummarySchema.safeParse(withoutCalendar).success).toBe(false);
  });

  it.each([
    [
      "verified with an error",
      {
        status: "verified",
        window: { start: "1998-12-21", end: "1998-12-27" },
        currentThrough: "1998-12-27",
        error: "Calendar sync failed. Retry available.",
      },
    ],
    [
      "running with an error",
      {
        status: "running",
        window: { start: "1998-12-21", end: "1998-12-27" },
        currentThrough: null,
        error: "Calendar sync failed. Retry available.",
      },
    ],
    [
      "verified without a window",
      { status: "verified", window: null, currentThrough: "1998-12-27", error: null },
    ],
    [
      "current through beyond the window",
      {
        status: "verified",
        window: { start: "1998-12-21", end: "1998-12-27" },
        currentThrough: "1998-12-28",
        error: null,
      },
    ],
    [
      "current through before the window end",
      {
        status: "verified",
        window: { start: "1998-12-21", end: "1998-12-27" },
        currentThrough: "1998-12-26",
        error: null,
      },
    ],
    [
      "reversed window",
      {
        status: "pending",
        window: { start: "1998-12-27", end: "1998-12-21" },
        currentThrough: null,
        error: null,
      },
    ],
    ...["pending", "running", "failed", "not-connected"].map((status): [string, unknown] => [
      `${status} with a current-through date`,
      {
        status,
        window: { start: "1998-12-21", end: "1998-12-27" },
        currentThrough: "1998-12-27",
        error: status === "failed" ? "Calendar sync failed. Retry available." : null,
      },
    ]),
  ])("rejects %s", (_name: string, calendar: unknown) => {
    expect(PlanSummarySchema.safeParse({ ...active, calendar }).success).toBe(false);
  });

  it.each([
    { start: 19981221 },
    { end: "1999-02-30" },
    { closedAt: "1999-01-18T12:00:00Z" },
    { activatedAt: "1998-1-1" },
    { weeks: 0 },
    { status: "draft" },
    { closeReason: "unknown" },
    { creationId: "" },
    { version: 0 },
  ])("rejects invalid summary fields %j", (fields) => {
    expect(PlanSummarySchema.safeParse({ ...active, ...fields }).success).toBe(false);
  });
});
