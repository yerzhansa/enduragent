import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { PlanChangeIntent } from "@enduragent/coach-contract";
import type { IntentTranslationPort } from "@enduragent/engine";
import {
  changeTranslationSchema,
  supportedChangeKinds,
  translateChangeRequest,
} from "../src/plan-change-translator.js";

const context = {
  allowedKinds: supportedChangeKinds,
  today: "1998-09-08",
  eligibleWorkouts: [
    { workoutId: "eligible-first", name: "Easy ride", kind: "endurance", minutes: 45 },
    { workoutId: "eligible-second", name: "Steady ride", kind: "endurance", minutes: 60 },
  ],
  supportingEvents: [{ id: "event-one", name: "Local ride", date: "1998-09-20", role: "Training" }],
};

const weekdays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const matcherCases = weekdays.flatMap((weekday, index) => [
  {
    text: `${weekday}s at most 30 minutes`,
    intent: { kind: "weekday-duration", day: index + 1, minutes: 30 },
  },
  { text: `no training on ${weekday}s`, intent: { kind: "weekday-unavailable", day: index + 1 } },
  { text: `no hard training on ${weekday}s`, intent: { kind: "hard-weekday", day: index + 1 } },
]);

function modelReturning(value: unknown) {
  const calls = vi.fn<(text: string, schema: z.ZodType, context: unknown) => void>();
  const translator: IntentTranslationPort = {
    async translateIntent(text, schema, context) {
      calls(text, schema, context);
      return schema.parse(value);
    },
  };
  return { ...translator, calls };
}

describe("change request matcher", () => {
  it.each(matcherCases)("matches $text", async ({ text, intent }) => {
    const translator = modelReturning({ status: "unsupported" });
    await expect(translateChangeRequest(text, { ...context, translator })).resolves.toEqual({
      status: "translated",
      intent,
    });
    expect(translator.calls).not.toHaveBeenCalled();
  });

  it.each([
    { text: "at most 6 hours each week", intent: { kind: "weekly-duration", hours: 6 } },
    { text: "at most 6.25 hours each week", intent: { kind: "weekly-duration", hours: 6.25 } },
    { text: "long rides at most 90 minutes", intent: { kind: "longest-workout", minutes: 90 } },
    { text: "my ftp is 220", intent: { kind: "ftp", watts: 220 } },
    {
      text: " What  should I ride today? ",
      intent: { kind: "choose-workout", workoutId: "eligible-first" },
    },
    { text: "wed up to 1 hours", intent: { kind: "weekday-duration", day: 3, minutes: 60 } },
    { text: "fridays easy only", intent: { kind: "hard-weekday", day: 5 } },
    { text: "monday off", intent: { kind: "weekday-unavailable", day: 1 } },
  ])("matches $text", async ({ text, intent }) => {
    await expect(translateChangeRequest(text, context)).resolves.toEqual({
      status: "translated",
      intent,
    });
  });

  it("reports no eligible daily Workout without invoking the model", async () => {
    const translator = modelReturning({ status: "unsupported" });
    await expect(
      translateChangeRequest("what should i ride today", {
        ...context,
        eligibleWorkouts: [],
        translator,
      }),
    ).resolves.toEqual({ status: "no-eligible-workout" });
    expect(translator.calls).not.toHaveBeenCalled();
  });

  it.each([" and ", " then ", " and then ", ", ", "; ", "\n", ". "])(
    "rejects combined matches separated by %j",
    async (joiner) => {
      const translator = modelReturning({ status: "unsupported" });
      for (const second of [
        "my ftp is 240",
        "wednesdays at most 30 minutes",
        "no hard training on tuesdays",
      ]) {
        await expect(
          translateChangeRequest(`my ftp is 220${joiner}${second}`, { ...context, translator }),
        ).resolves.toEqual({ status: "combined" });
      }
      await expect(
        translateChangeRequest(
          `wednesdays at most 30 minutes${joiner}wednesdays at most 60 minutes`,
          { ...context, translator },
        ),
      ).resolves.toEqual({ status: "combined" });
      expect(translator.calls).not.toHaveBeenCalled();
    },
  );

  it.each([
    "unrelated words",
    "my ftp is 0",
    "at most 6.1 hours each week",
    "long rides at most 0 minutes",
  ])("does not accept %s without a model lane", async (text) => {
    await expect(translateChangeRequest(text, context)).resolves.toEqual({ status: "unsupported" });
  });

  it("enforces host allowed kinds for deterministic matches", async () => {
    await expect(
      translateChangeRequest("my ftp is 220", { ...context, allowedKinds: ["weekly-duration"] }),
    ).resolves.toEqual({ status: "unsupported" });
    await expect(
      translateChangeRequest("what should i ride today", { ...context, allowedKinds: ["ftp"] }),
    ).resolves.toEqual({ status: "unsupported" });
  });
});

describe("change request model translation", () => {
  it("passes the host context and constrained schema to the model once", async () => {
    const translator = modelReturning({
      status: "translated",
      intent: { kind: "ftp", watts: 220 },
    });
    await expect(
      translateChangeRequest("set my threshold to 220", { ...context, translator }),
    ).resolves.toEqual({ status: "translated", intent: { kind: "ftp", watts: 220 } });
    expect(translator.calls).toHaveBeenCalledTimes(1);
    const [text, schema, passedContext] = translator.calls.mock.calls[0];
    expect(text).toBe("set my threshold to 220");
    expect(passedContext).toEqual({
      candidates: ["candidate-1", "candidate-2"],
      events: ["event-1"],
    });
    const serialized = JSON.stringify(z.toJSONSchema(schema));
    expect(serialized).toContain("candidate-1");
    expect(serialized).toContain("candidate-2");
    for (const value of [
      "eligible-first",
      "eligible-second",
      "Easy ride",
      "Steady ride",
      "event-one",
      "Local ride",
      "1998-09-20",
      "1998-09-08",
    ])
      expect(
        JSON.stringify({ schema: z.toJSONSchema(schema), context: passedContext }),
      ).not.toContain(value);
    expect(serialized).not.toContain('"inverse"');
    expect(
      schema.safeParse({
        status: "translated",
        intent: { kind: "choose-workout", workoutId: "unknown" },
      }).success,
    ).toBe(false);
  });

  it.each([
    {
      token: { kind: "choose-workout", workoutId: "candidate-2" },
      mapped: { kind: "choose-workout", workoutId: "eligible-second" },
    },
    {
      token: { kind: "supporting-event", operation: "remove", eventId: "event-1" },
      mapped: { kind: "supporting-event", operation: "remove", eventId: "event-one" },
    },
    {
      token: { kind: "supporting-event", operation: "role", eventId: "event-1", role: "Important" },
      mapped: {
        kind: "supporting-event",
        operation: "role",
        eventId: "event-one",
        role: "Important",
      },
    },
  ])("maps validated references to host ids: $token", async ({ token, mapped }) => {
    await expect(
      translateChangeRequest("an unmatched request", {
        ...context,
        translator: modelReturning({ status: "translated", intent: token }),
      }),
    ).resolves.toEqual({ status: "translated", intent: mapped });
  });

  it.each([
    { status: "translated", intent: { kind: "inverse", changeId: "change-one" } },
    { status: "translated", intent: { kind: "choose-workout", workoutId: "unknown" } },
    { status: "translated", intent: { kind: "choose-workout", workoutId: "candidate-99" } },
    { status: "translated", intent: { kind: "choose-workout", workoutId: "eligible-first" } },
    {
      status: "translated",
      intent: { kind: "supporting-event", operation: "remove", eventId: "event-99" },
    },
    {
      status: "translated",
      intent: { kind: "supporting-event", operation: "remove", eventId: "event-one" },
    },
    { status: "translated", intent: { kind: "unknown" } },
    { status: "translated", intent: { kind: "ftp", watts: 0 } },
    {
      status: "translated",
      intent: [
        { kind: "ftp", watts: 220 },
        { kind: "ftp", watts: 230 },
      ],
    },
    null,
  ])("rejects invalid model translation %j", async (value) => {
    await expect(
      translateChangeRequest("an unmatched request", {
        ...context,
        translator: modelReturning(value),
      }),
    ).resolves.toEqual({ status: "unsupported" });
  });

  it("rejects model kinds excluded by the host", async () => {
    await expect(
      translateChangeRequest("an unmatched request", {
        ...context,
        allowedKinds: ["weekday-duration"],
        translator: modelReturning({ status: "translated", intent: { kind: "ftp", watts: 220 } }),
      }),
    ).resolves.toEqual({ status: "unsupported" });
  });

  it.each(["unsupported", "combined"])("preserves the model %s outcome", async (status) => {
    await expect(
      translateChangeRequest("an unmatched request", {
        ...context,
        translator: modelReturning({ status }),
      }),
    ).resolves.toEqual({ status });
  });

  it("handles model failures as unsupported", async () => {
    const translator = modelReturning(null);
    translator.calls.mockImplementation(() => {
      throw new Error("provider offline");
    });
    await expect(
      translateChangeRequest("an unmatched request", { ...context, translator }),
    ).resolves.toEqual({ status: "unsupported" });
    expect(translator.calls).toHaveBeenCalledTimes(1);
  });

  it("supports every forward intent and Supporting Event operation", () => {
    const intents: PlanChangeIntent[] = [
      { kind: "weekday-duration", day: 3, minutes: 30 },
      { kind: "weekday-unavailable", day: 4 },
      { kind: "hard-weekday", day: 5 },
      { kind: "weekly-duration", hours: 6 },
      { kind: "longest-workout", minutes: 90 },
      { kind: "ftp", watts: 220 },
      { kind: "choose-workout", workoutId: "candidate-2" },
      {
        kind: "supporting-event",
        operation: "add",
        name: "Local ride",
        date: "1998-09-20",
        role: "Training",
      },
      { kind: "supporting-event", operation: "role", eventId: "event-1", role: "Important" },
      { kind: "supporting-event", operation: "remove", eventId: "event-1" },
      { kind: "supporting-event", operation: "source-update", eventId: "event-1" },
      { kind: "supporting-event", operation: "name", eventId: "event-1", name: "New ride name" },
      {
        kind: "supporting-event",
        operation: "manual",
        eventId: "event-1",
        name: "Local ride",
        date: "1998-09-20",
      },
    ];
    const schema = changeTranslationSchema(context);
    for (const intent of intents)
      expect(schema.safeParse({ status: "translated", intent }).success).toBe(true);
    expect(new Set(intents.map((intent) => intent.kind))).toEqual(new Set(supportedChangeKinds));
  });

  it("can serialize empty allowed kinds and no eligible Workouts", () => {
    const schema = changeTranslationSchema({ ...context, eligibleWorkouts: [], allowedKinds: [] });
    expect(() => z.toJSONSchema(schema)).not.toThrow();
    expect(schema.safeParse({ status: "unsupported" }).success).toBe(true);
    expect(
      schema.safeParse({ status: "translated", intent: { kind: "ftp", watts: 220 } }).success,
    ).toBe(false);
  });
});
