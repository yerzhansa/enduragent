import { describe, expect, expectTypeOf, it } from "vitest";
import {
  AnswerCheckActionSchema,
  CoachOperationProgressNotificationEnvelopeSchema,
  COACH_RPC_METHOD_REGISTRY,
  CommitmentCheckResultSchema,
  EventCheckResultSchema,
  ListPlansResultSchema,
  PlanChangeCheckProgressSchema,
  PlanChangeCheckResultSchema,
  PlanChangePendingCheckSchema,
  PlanCreationAnswerRpcParamsSchema,
  PlanCreationCardModelSchema,
  PlanCreationCheckProgressSchema,
  PlanCreationCheckSubmissionSchema,
  PlanCreationPendingCheckSchema,
  SuccessCheckResultSchema,
  type CoachRpcEvent,
  type PlanChangeCheckProgress,
  type PlanCreationCheckProgress,
} from "../src/index.js";

const prose = { title: "Did I understand?", body: "Confirm this answer before it is saved." };
const rules = [{ kind: "weekday-duration", day: 3, minutes: 30 }];
const metadata = {
  schemaVersion: 1,
  checkId: "check-1",
  commandId: "answer-1",
  sourceVersion: 2,
  attempt: 1,
};
const creationId = "00000000000000000000000001";
const busyCreation = {
  ...metadata,
  state: "busy",
  submission: { field: "commitments", text: "Wednesdays at most 30 minutes" },
};
const busyChange = {
  ...metadata,
  state: "busy",
  submission: { field: "change", text: "Shorten my longest ride to 30 minutes" },
};
const creationCard = {
  creationId,
  version: 2,
  status: "in-progress",
  draft: null,
  draftStale: false,
  calendarWindow: null,
  pendingCommitment: null,
  pendingCheck: busyCreation,
  readiness: "incomplete",
  answeredSummaries: [],
  openQuestion: null,
};

describe("typed answer checks", () => {
  it("accepts only field-specific submissions and enforces the 2000-character input limit", () => {
    for (const field of ["commitments", "success", "event"] as const) {
      const submission = {
        field,
        text: "x".repeat(2000),
        ...(field === "event" ? { date: "1998-10-18" } : {}),
      };
      expect(PlanCreationCheckSubmissionSchema.parse(submission)).toEqual(submission);
      expect(
        PlanCreationCheckSubmissionSchema.safeParse({ ...submission, text: "x".repeat(2001) })
          .success,
      ).toBe(false);
      expect(
        PlanCreationCheckSubmissionSchema.safeParse({ ...submission, text: "  " }).success,
      ).toBe(false);
      expect(
        PlanCreationAnswerRpcParamsSchema.safeParse({
          commandId: "answer",
          creationId,
          expectedVersion: 2,
          answer: { kind: "check-submit", submission },
        }).success,
      ).toBe(true);
    }
    for (const submission of [
      { field: "event", text: "Autumn Tour" },
      { field: "event", text: "Autumn Tour", date: "1998-02-30" },
      { field: "success", text: "Finish well", date: "1998-10-18" },
      { field: "change", text: "Fewer hours" },
      { field: "commitments", text: "Wednesday", value: rules },
    ])
      expect(PlanCreationCheckSubmissionSchema.safeParse(submission).success).toBe(false);
  });

  it("validates understood values and keeps ask and skip values empty", () => {
    expect(
      CommitmentCheckResultSchema.parse({ ...prose, outcome: "understood", value: rules }).value,
    ).toEqual(rules);
    expect(
      CommitmentCheckResultSchema.safeParse({
        ...prose,
        outcome: "understood",
        value: Array.from({ length: 20 }, () => rules[0]),
      }).success,
    ).toBe(true);
    for (const value of [
      null,
      [],
      Array.from({ length: 21 }, () => rules[0]),
      [{ kind: "weekday-duration", day: 8, minutes: 30 }],
      [{ kind: "weekday-duration", day: 3, minutes: 0 }],
      [{ kind: "time-off", start: "1998-09-04", end: "1998-09-02" }],
    ]) {
      expect(
        CommitmentCheckResultSchema.safeParse({ ...prose, outcome: "understood", value }).success,
      ).toBe(false);
    }
    for (const schema of [
      CommitmentCheckResultSchema,
      SuccessCheckResultSchema,
      PlanChangeCheckResultSchema,
    ]) {
      for (const outcome of ["ask", "skip"] as const) {
        expect(schema.parse({ ...prose, outcome, value: null })).toEqual({
          ...prose,
          outcome,
          value: null,
        });
        expect(schema.safeParse({ ...prose, outcome, value: "invented value" }).success).toBe(
          false,
        );
      }
    }
    expect(
      SuccessCheckResultSchema.safeParse({
        ...prose,
        outcome: "understood",
        value: "x".repeat(2000),
      }).success,
    ).toBe(true);
    expect(
      SuccessCheckResultSchema.safeParse({
        ...prose,
        outcome: "understood",
        value: "x".repeat(2001),
      }).success,
    ).toBe(false);
    expect(
      PlanChangeCheckResultSchema.safeParse({
        ...prose,
        outcome: "understood",
        value: { kind: "longest-workout", minutes: 30 },
      }).success,
    ).toBe(true);
    expect(
      PlanChangeCheckResultSchema.safeParse({ ...prose, outcome: "understood", value: rules })
        .success,
    ).toBe(false);
  });

  it("requires a complete event name and date and never permits skipping an event", () => {
    const result = {
      ...prose,
      outcome: "understood",
      value: { name: "Autumn Tour", date: "1998-10-18" },
    };
    expect(EventCheckResultSchema.parse(result)).toEqual(result);
    expect(EventCheckResultSchema.parse({ ...prose, outcome: "ask", value: null }).outcome).toBe(
      "ask",
    );
    for (const value of [
      null,
      {},
      { name: "Autumn Tour" },
      { name: "", date: "1998-10-18" },
      { name: "Autumn Tour", date: "1998-02-30" },
      { name: "Autumn Tour", date: "1998-10-18", extra: true },
    ]) {
      expect(EventCheckResultSchema.safeParse({ ...result, value }).success).toBe(false);
    }
    expect(
      EventCheckResultSchema.safeParse({ ...prose, outcome: "skip", value: null }).success,
    ).toBe(false);
  });

  it("requires short nonempty titles and one paragraph of coach prose", () => {
    const result = { ...prose, outcome: "ask", value: null };
    for (const schema of [
      CommitmentCheckResultSchema,
      SuccessCheckResultSchema,
      EventCheckResultSchema,
      PlanChangeCheckResultSchema,
    ]) {
      for (const override of [
        { title: "" },
        { title: "x".repeat(161) },
        { body: "" },
        { body: "x".repeat(2001) },
        { body: "One paragraph.\nAnother paragraph." },
        { body: "One paragraph.\rAnother paragraph." },
        { extra: true },
      ]) {
        expect(schema.safeParse({ ...result, ...override }).success).toBe(false);
      }
      expect(
        schema.safeParse({ ...result, title: "x".repeat(160), body: "x".repeat(2000) }).success,
      ).toBe(true);
    }
  });

  it("couples pending fields to result values and separates busy, ready, and error states", () => {
    const fields = [
      { submission: busyCreation.submission, value: rules },
      { submission: { field: "success", text: "Finish comfortably" }, value: "Finish comfortably" },
      {
        submission: { field: "event", text: "Autumn Tour", date: "1998-10-18" },
        value: { name: "Autumn Tour", date: "1998-10-18" },
      },
    ];
    for (const field of fields) {
      const base = { ...metadata, submission: field.submission };
      for (const state of [
        { state: "busy" },
        { state: "error", message: "Try again." },
        { state: "ready", result: { ...prose, outcome: "understood", value: field.value } },
      ]) {
        expect(PlanCreationPendingCheckSchema.safeParse({ ...base, ...state }).success).toBe(true);
      }
      for (const other of fields.filter((candidate) => candidate !== field)) {
        expect(
          PlanCreationPendingCheckSchema.safeParse({
            ...base,
            state: "ready",
            result: { ...prose, outcome: "understood", value: other.value },
          }).success,
        ).toBe(false);
      }
    }
    for (const override of [
      { state: "ready" },
      { state: "error" },
      { state: "busy", result: { ...prose, outcome: "ask", value: null } },
      { state: "ready", message: "Try again.", result: { ...prose, outcome: "ask", value: null } },
      { sourceVersion: 0 },
      { attempt: 0 },
      { schemaVersion: 2 },
      { checkId: "" },
    ])
      expect(
        PlanCreationPendingCheckSchema.safeParse({ ...busyCreation, ...override }).success,
      ).toBe(false);
    expect(PlanChangePendingCheckSchema.safeParse(busyChange).success).toBe(true);
    expect(PlanChangePendingCheckSchema.safeParse(busyCreation).success).toBe(false);
    expect(PlanCreationPendingCheckSchema.safeParse(busyChange).success).toBe(false);
  });

  it("defaults missing persisted projections to null and marks a pending creation incomplete", () => {
    const { pendingCheck: omitted, ...withoutCheck } = creationCard;
    expect(omitted).toEqual(busyCreation);
    expect(
      PlanCreationCardModelSchema.parse({ ...withoutCheck, readiness: "ready" }).pendingCheck,
    ).toBeNull();
    expect(PlanCreationCardModelSchema.parse(creationCard).pendingCheck).toEqual(busyCreation);
    expect(
      PlanCreationCardModelSchema.safeParse({ ...creationCard, readiness: "ready" }).success,
    ).toBe(false);
    expect(
      ListPlansResultSchema.parse({
        calendarConnected: false,
        legacy: null,
        creation: null,
        active: null,
        closed: [],
        changes: [],
        changesPaused: null,
      }).pendingChangeCheck,
    ).toBeNull();
    for (const action of ["confirm", "retry", "cancel", "skip"])
      expect(
        AnswerCheckActionSchema.safeParse({ kind: "check-action", checkId: "check-1", action })
          .success,
      ).toBe(true);
    expect(
      AnswerCheckActionSchema.safeParse({
        kind: "check-action",
        checkId: "check-1",
        action: "confirm",
        value: rules,
      }).success,
    ).toBe(false);
  });

  it("discriminates progress payloads by request method", () => {
    const creation = { type: "answer-check", planCreation: creationCard };
    const change = { type: "answer-check", planId: creationId, pendingCheck: busyChange };
    expect(COACH_RPC_METHOD_REGISTRY["plan_creation.answer"].eventSchema).toBe(
      PlanCreationCheckProgressSchema,
    );
    expect(COACH_RPC_METHOD_REGISTRY["plan_change.preview"].eventSchema).toBe(
      PlanChangeCheckProgressSchema,
    );
    expectTypeOf<
      CoachRpcEvent<"plan_creation.answer">
    >().toEqualTypeOf<PlanCreationCheckProgress>();
    expectTypeOf<CoachRpcEvent<"plan_change.preview">>().toEqualTypeOf<PlanChangeCheckProgress>();
    for (const [requestMethod, event] of [
      ["plan_creation.answer", creation],
      ["plan_change.preview", change],
      ["sync", { phase: "started", completed: 0, total: 1 }],
    ] as const) {
      const envelope = {
        jsonrpc: "2.0",
        method: "coach.operationProgress",
        params: { requestId: 1, requestMethod, event },
      };
      expect(CoachOperationProgressNotificationEnvelopeSchema.parse(envelope)).toEqual(envelope);
      for (const other of [creation, change, { phase: "started", completed: 0, total: 1 }].filter(
        (candidate) => JSON.stringify(candidate) !== JSON.stringify(event),
      )) {
        expect(
          CoachOperationProgressNotificationEnvelopeSchema.safeParse({
            ...envelope,
            params: { ...envelope.params, event: other },
          }).success,
        ).toBe(false);
      }
    }
  });
});
