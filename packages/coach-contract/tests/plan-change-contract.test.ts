import { describe, expect, it } from "vitest";
import {
  COACH_RPC_METHOD_REGISTRY,
  CoachRpcRequestEnvelopeSchema,
  ListPlansResultSchema,
  PlanChangeApplyResultSchema,
  PlanChangeApplyRpcParamsSchema,
  PlanChangeIntentSchema,
  PlanChangeFtpSourcesSchema,
  PlanChangeEventSourceSchema,
  SupportingEventSchema,
  PlanChangeModelSchema,
  PlanChangePreviewResultSchema,
  PlanChangePreviewRpcParamsSchema,
  PlanChangeWorkoutSchema,
  PlanCreationDraftSchema,
} from "../src/index.js";

const planId = "01J00000000000000000000001";
const changeId = "01J00000000000000000000002";
const command = { commandId: "change-command", planId, expectedVersion: 1 };
const intent = { kind: "weekday-duration", day: 3, minutes: 30 };
const workout = {
  id: "workout-one",
  name: "Endurance ride",
  kind: "endurance",
  date: "1998-09-09",
  minutes: 60,
  pinned: false,
  guidance: "Ride comfortably.",
  power: null,
};
const change = {
  changeId,
  planId,
  baseRevisionNumber: 1,
  status: "pending",
  title: "Limit weekday duration",
  intent,
  diff: [{ workoutId: workout.id, before: workout, after: { ...workout, minutes: 30 } }],
  totals: {
    before: { plan: 60, weeks: [{ number: 1, minutes: 60 }] },
    after: { plan: 30, weeks: [{ number: 1, minutes: 30 }] },
  },
  supersedes: null,
  supersededBy: null,
  resultRevisionNumber: null,
  undo: null,
  confidence:
    "Moderate confidence. Based on your confirmed limits and the available training record.",
  premises: [
    {
      id: "confirmed-limits",
      label: "Confirmed Plan limits",
      source: "Your confirmed answers",
      value: intent,
    },
  ],
};

describe("Plan Change contract", () => {
  it.each([
    intent,
    { kind: "weekday-unavailable", day: 7 },
    { kind: "hard-weekday", day: 1 },
    { kind: "weekly-duration", hours: 0.25 },
    { kind: "weekly-duration", hours: 2.25 },
    { kind: "weekly-duration", hours: 2.5 },
    { kind: "weekly-duration", hours: 2.75 },
    { kind: "longest-workout", minutes: 45 },
    { kind: "inverse", changeId },
    { kind: "ftp", watts: 1 },
    { kind: "ftp", watts: 9_999 },
  ])("accepts Schedule intent $kind", (value) => {
    expect(PlanChangeIntentSchema.parse(value)).toEqual(value);
  });

  it.each([
    { ...intent, day: 0 },
    { ...intent, day: 8 },
    { ...intent, day: 1.5 },
    { ...intent, minutes: 0 },
    { ...intent, minutes: -1 },
    { ...intent, minutes: 0.001 },
    { ...intent, minutes: 30.5 },
    { kind: "weekly-duration", hours: 0 },
    { kind: "weekly-duration", hours: 0.001 },
    { kind: "weekly-duration", hours: 2.1 },
    { kind: "longest-workout", minutes: 0.001 },
    { kind: "longest-workout", minutes: 45.5 },
    { kind: "longest-workout", minutes: Infinity },
    { kind: "hard-weekday", day: 3, minutes: 30 },
    { kind: "inverse" },
    { kind: "inverse", changeId: "invalid" },
    { kind: "inverse", changeId, extra: true },
    { kind: "ftp", ftp: 220 },
    ...[null, 0, -1, 220.5, 10_000, Infinity].map((watts) => ({ kind: "ftp", watts })),
  ])("rejects invalid or deferred intent %j", (value) => {
    expect(PlanChangeIntentSchema.safeParse(value).success).toBe(false);
  });

  it("accepts nullable whole watts for Draft FTP and Workout power", () => {
    for (const watts of [null, 1, 220, 9_999]) {
      expect(PlanCreationDraftSchema.shape.ftp.parse(watts)).toBe(watts);
      expect(PlanChangeWorkoutSchema.parse({ ...workout, power: watts }).power).toBe(watts);
    }
    for (const watts of [0, -1, 220.5, 10_000, Infinity, "220"]) {
      expect(PlanCreationDraftSchema.shape.ftp.safeParse(watts).success).toBe(false);
      expect(PlanChangeWorkoutSchema.safeParse({ ...workout, power: watts }).success).toBe(false);
    }
  });

  it("preserves by-value FTP evidence and validates its sources", () => {
    const premise = {
      acceptedPlanFtp: null,
      requestedFtp: 220,
      candidates: [
        { source: "manual", watts: 210, selected: true },
        { source: "intervals-ftp", watts: 205, selected: false },
        { source: "intervals-eftp", watts: 215, selected: false },
      ],
    };
    expect(PlanChangeFtpSourcesSchema.parse(premise)).toEqual(premise);
    expect(
      PlanChangeFtpSourcesSchema.parse({ ...premise, requestedFtp: null }).requestedFtp,
    ).toBeNull();
    for (const candidate of [
      { source: "unknown", watts: 220, selected: true },
      { source: "manual", watts: 220.5, selected: true },
      { source: "manual", watts: 220 },
      { source: "manual", watts: 220, selected: true, refreshedAtMs: 1 },
    ]) {
      expect(
        PlanChangeFtpSourcesSchema.safeParse({ ...premise, candidates: [candidate] }).success,
      ).toBe(false);
    }
    expect(
      PlanChangeApplyResultSchema.parse({ status: "rejected", reason: "ftp-sources-changed" }),
    ).toEqual({ status: "rejected", reason: "ftp-sources-changed" });
  });

  it("reuses the Draft Workout schema and preserves exact differences and premises", () => {
    expect(PlanChangeWorkoutSchema).toBe(
      PlanCreationDraftSchema.shape.weeks.element.shape.workouts.element,
    );
    expect(PlanChangeModelSchema.parse(change)).toEqual(change);
    expect(
      PlanChangeModelSchema.parse({
        ...change,
        diff: [{ workoutId: workout.id, before: workout, after: null }],
      }).diff[0]?.after,
    ).toBeNull();
    expect(
      PlanChangeModelSchema.parse({
        ...change,
        diff: [{ workoutId: workout.id, before: null, after: workout }],
      }).diff[0]?.before,
    ).toBeNull();
  });

  it.each(["pending", "applied", "cancelled", "superseded", "stale"])(
    "accepts athlete status %s",
    (status) => {
      expect(
        PlanChangeModelSchema.parse({
          ...change,
          status,
          undo: status === "applied" ? { eligible: true } : null,
        }).status,
      ).toBe(status);
    },
  );

  it("validates Undo eligibility only on applied Changes", () => {
    for (const undo of [
      { eligible: true },
      ...["not-newest", "inverse", "nothing-to-restore", "plan-changed"].map((reason) => ({
        eligible: false,
        reason,
      })),
    ]) {
      expect(PlanChangeModelSchema.parse({ ...change, status: "applied", undo }).undo).toEqual(
        undo,
      );
      expect(PlanChangeModelSchema.safeParse({ ...change, undo }).success).toBe(false);
    }
    for (const undo of [
      null,
      { eligible: false },
      { eligible: false, reason: "unknown" },
      { eligible: true, reason: "inverse" },
    ]) {
      expect(PlanChangeModelSchema.safeParse({ ...change, status: "applied", undo }).success).toBe(
        false,
      );
    }
  });

  it("preserves arbitrary JSON premise values including the undone Change", () => {
    const values = [
      { changeId, title: "Limit weekday duration" },
      null,
      true,
      42,
      "source",
      [1, { nested: false }],
    ];
    for (const value of values) {
      const model = {
        ...change,
        premises: [{ id: "undone-change", label: "Applied Change", source: "Plan history", value }],
      };
      expect(PlanChangeModelSchema.parse(model)).toEqual(model);
    }
    expect(
      PlanChangeModelSchema.safeParse({
        ...change,
        premises: [{ id: "bad", label: "Bad", source: "Bad", value: undefined }],
      }).success,
    ).toBe(false);
  });

  it("preserves the successor id in superseded history", () => {
    const superseded = {
      ...change,
      status: "superseded",
      supersededBy: "01J00000000000000000000003",
    };
    expect(PlanChangeModelSchema.parse(superseded)).toEqual(superseded);
  });

  it("requires explicit changes in the Plan list", () => {
    const empty = {
      calendarConnected: false,
      legacy: null,
      creation: null,
      active: null,
      closed: [],
      changes: [],
      changesPaused: null,
    };
    expect(ListPlansResultSchema.parse(empty)).toEqual(empty);
    expect(
      ListPlansResultSchema.safeParse({
        calendarConnected: false,
        legacy: null,
        creation: null,
        active: null,
        closed: [],
      }).success,
    ).toBe(false);
  });

  it("registers strict preview and apply envelopes and result schemas", () => {
    const preview = { ...command, intent };
    const apply = { ...command, changeId, decision: "apply" };
    expect(PlanChangePreviewRpcParamsSchema.parse(preview)).toEqual(preview);
    expect(PlanChangeApplyRpcParamsSchema.parse(apply)).toEqual(apply);
    expect(PlanChangeApplyRpcParamsSchema.parse({ ...apply, decision: "cancel" }).decision).toBe(
      "cancel",
    );
    expect(PlanChangeApplyRpcParamsSchema.safeParse({ ...apply, decision: "undo" }).success).toBe(
      false,
    );
    expect(
      PlanChangePreviewRpcParamsSchema.safeParse({ ...preview, expectedVersion: 0 }).success,
    ).toBe(false);
    expect(PlanChangePreviewRpcParamsSchema.safeParse({ ...preview, extra: true }).success).toBe(
      false,
    );
    for (const [method, params] of [
      ["plan_change.preview", preview],
      ["plan_change.apply", apply],
    ]) {
      const envelope = { jsonrpc: "2.0", id: 1, method, params };
      expect(CoachRpcRequestEnvelopeSchema.parse(envelope)).toEqual(envelope);
    }
    expect(COACH_RPC_METHOD_REGISTRY["plan_change.preview"].requestSchema).toBe(
      PlanChangePreviewRpcParamsSchema,
    );
    expect(COACH_RPC_METHOD_REGISTRY["plan_change.preview"].responseSchema).toBe(
      PlanChangePreviewResultSchema,
    );
    expect(COACH_RPC_METHOD_REGISTRY["plan_change.apply"].responseSchema).toBe(
      PlanChangeApplyResultSchema,
    );
    expect(
      PlanChangePreviewResultSchema.parse({ status: "previewed", change, version: 1 }).status,
    ).toBe("previewed");
    expect(
      PlanChangeApplyResultSchema.parse({
        status: "applied",
        changeId,
        revisionNumber: 2,
        version: 2,
      }).status,
    ).toBe("applied");
    expect(
      PlanChangeApplyResultSchema.parse({ status: "cancelled", changeId, version: 1 }).status,
    ).toBe("cancelled");
  });

  it.each(["stale-version", "no-active-plan", "command-conflict", "invalid-intent", "sync-stale"])(
    "accepts preview rejection %s",
    (reason) => {
      expect(PlanChangePreviewResultSchema.parse({ status: "rejected", reason })).toEqual({
        status: "rejected",
        reason,
      });
    },
  );

  it.each(["stale-version", "not-pending", "no-active-plan", "command-conflict", "sync-stale"])(
    "accepts apply rejection %s",
    (reason) => {
      expect(PlanChangeApplyResultSchema.parse({ status: "rejected", reason })).toEqual({
        status: "rejected",
        reason,
      });
    },
  );
});

describe("race window rejections", () => {
  const rejection = {
    status: "rejected",
    reason: "race-window",
    window: { start: "1998-09-01", end: "1998-09-07" },
  };

  it("requires civil window dates only on race-window preview rejections", () => {
    expect(PlanChangePreviewResultSchema.parse(rejection)).toEqual(rejection);
    expect(
      PlanChangePreviewResultSchema.safeParse({ status: "rejected", reason: "race-window" })
        .success,
    ).toBe(false);
    expect(
      PlanChangePreviewResultSchema.safeParse({ ...rejection, reason: "sync-stale" }).success,
    ).toBe(false);
    for (const window of [
      { start: "1998-02-30", end: "1998-09-07" },
      { start: "1998-09-01", end: "1998-09-07T00:00:00Z" },
      { start: "1998-09-01" },
      { ...rejection.window, extra: true },
    ])
      expect(PlanChangePreviewResultSchema.safeParse({ ...rejection, window }).success).toBe(false);
  });

  it("accepts the apply reason without a preview window", () => {
    const applied = { status: "rejected", reason: "race-window" };
    expect(PlanChangeApplyResultSchema.parse(applied)).toEqual(applied);
    expect(PlanChangeApplyResultSchema.safeParse(rejection).success).toBe(false);
  });
});

describe("Supporting Event contracts", () => {
  const event = {
    id: "supporting-event-one",
    name: "Autumn ride",
    date: "1998-09-12",
    role: "Important",
    source: { kind: "manual" },
  };
  const source = {
    providerId: "fixture-event",
    sourceRevision: "a".repeat(64),
    name: event.name,
    date: event.date,
    category: "RACE_B",
  };

  it.each([
    { operation: "add", name: event.name, date: event.date, role: "Important" },
    {
      operation: "add",
      name: event.name,
      date: event.date,
      role: "Training",
      providerId: source.providerId,
    },
    { operation: "remove", eventId: event.id },
    { operation: "role", eventId: event.id, role: "Training" },
    { operation: "manual", eventId: event.id, name: event.name, date: event.date },
    { operation: "source-update", eventId: event.id },
    { operation: "name", eventId: event.id, name: "Renamed ride" },
  ])("accepts operation $operation", (operation) => {
    const value = { kind: "supporting-event", ...operation };
    expect(PlanChangeIntentSchema.parse(value)).toEqual(value);
  });

  it.each([
    { operation: "add", name: event.name, date: event.date, role: "Ignore" },
    { operation: "add", name: " ", date: event.date, role: "Important" },
    { operation: "add", name: event.name, date: "1998-02-30", role: "Important" },
    { operation: "add", name: event.name, date: event.date, role: "Training", providerId: "" },
    { operation: "remove" },
    { operation: "remove", eventId: "" },
    { operation: "remove", eventId: event.id, name: event.name },
    { operation: "role", eventId: event.id, role: "Main" },
    { operation: "manual", eventId: event.id, name: event.name },
    { operation: "source-update", eventId: event.id, date: event.date },
    { operation: "name", eventId: event.id, name: "" },
    { operation: "unknown", eventId: event.id },
  ])("rejects malformed operation %j", (operation) => {
    expect(
      PlanChangeIntentSchema.safeParse({ kind: "supporting-event", ...operation }).success,
    ).toBe(false);
  });

  it("preserves manual and synchronized events and validates source identity", () => {
    expect(SupportingEventSchema.parse(event)).toEqual(event);
    const synced = {
      ...event,
      source: {
        kind: "synced",
        providerId: source.providerId,
        sourceRevision: source.sourceRevision,
      },
    };
    expect(SupportingEventSchema.parse(synced)).toEqual(synced);
    for (const invalid of [
      { ...event, role: "Ignore" },
      { ...event, date: "1998-02-30" },
      { ...event, source: { kind: "manual", providerId: source.providerId } },
      { ...synced, source: { ...synced.source, sourceRevision: "not-a-hash" } },
      { ...synced, source: { kind: "synced", providerId: source.providerId } },
    ]) {
      expect(SupportingEventSchema.safeParse(invalid).success).toBe(false);
    }
    expect(PlanChangeWorkoutSchema.parse(workout)).toEqual(workout);
    expect(
      PlanChangeWorkoutSchema.parse({ ...workout, supportingEventId: event.id }).supportingEventId,
    ).toBe(event.id);
  });

  it("preserves by-value synchronized event premises", () => {
    expect(PlanChangeEventSourceSchema.parse(source)).toEqual(source);
    const value = {
      ...change,
      premises: [
        { id: "event-source", label: "Event", source: "Intervals.icu event", value: source },
      ],
    };
    expect(PlanChangeModelSchema.parse(value)).toEqual(value);
    for (const invalid of [
      { ...source, category: "WORKOUT" },
      { ...source, sourceRevision: "invalid" },
      { ...source, date: "1998-09-12T12:00:00" },
      { ...source, providerId: "" },
      { ...source, unexpected: true },
    ]) {
      expect(PlanChangeEventSourceSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("permits explanations only for invalid intents and rejects source drift", () => {
    const rejection = {
      status: "rejected",
      reason: "invalid-intent",
      explanation: "Choose a Supporting Event already accepted in this Plan.",
    };
    expect(PlanChangePreviewResultSchema.parse(rejection)).toEqual(rejection);
    expect(
      PlanChangePreviewResultSchema.safeParse({ ...rejection, reason: "sync-stale" }).success,
    ).toBe(false);
    const drift = { status: "rejected", reason: "event-source-changed" };
    expect(PlanChangeApplyResultSchema.parse(drift)).toEqual(drift);
  });
});
