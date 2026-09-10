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
  language: "Russian",
  eligibleWorkouts: [
    { workoutId: "eligible-first", name: "Easy ride", minutes: 45 },
    { workoutId: "eligible-second", name: "Steady ride", minutes: 60 },
  ],
  supportingEvents: [{ id: "event-one", name: "Local ride", date: "1998-09-20" }],
};
const understood = (value: unknown) => ({
  outcome: "understood",
  title: "Did I read this right?",
  body: "Confirm this change to continue.",
  value,
});
const asked = {
  outcome: "ask",
  title: "Please clarify",
  body: "Ask for one complete change.",
  value: null,
};

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

describe("model-only Plan Change checks", () => {
  it.each([
    "wednesdays at most 30 minutes",
    "my ftp is 220",
    "what should i ride today",
    "my ftp is 220 and no training on Wednesdays",
  ])("always sends %s to the model", async (text) => {
    const translator = modelReturning(asked);
    await expect(translateChangeRequest(text, { ...context, translator })).resolves.toEqual(asked);
    expect(translator.calls).toHaveBeenCalledOnce();
    expect(translator.calls.mock.calls[0][0]).toBe(text);
  });

  it.each(["understood", "ask", "skip"])("preserves the model's %s result", async (outcome) => {
    const result = {
      outcome,
      title: "Check this request",
      body: "One paragraph from the coach.",
      value: outcome === "understood" ? { kind: "ftp", watts: 220 } : null,
    };
    await expect(
      translateChangeRequest("request", { ...context, translator: modelReturning(result) }),
    ).resolves.toEqual(result);
  });

  it("passes only the host's anonymous references and permitted context", async () => {
    const translator = modelReturning(understood({ kind: "ftp", watts: 220 }));
    await translateChangeRequest("set my threshold to 220", { ...context, translator });
    expect(translator.calls).toHaveBeenCalledOnce();
    const [text, schema, passedContext] = translator.calls.mock.calls[0];
    expect(text).toBe("set my threshold to 220");
    expect(passedContext).toMatchObject({
      candidates: ["candidate-1", "candidate-2"],
      events: ["event-1"],
      field: "change",
      today: "1998-09-08",
      language: "Russian",
    });
    const serialized = JSON.stringify({ schema: z.toJSONSchema(schema), context: passedContext });
    for (const value of [
      "eligible-first",
      "eligible-second",
      "Easy ride",
      "Steady ride",
      "event-one",
      "Local ride",
      "1998-09-20",
    ])
      expect(serialized).not.toContain(value);
    expect(serialized).not.toContain('"inverse"');
    expect(
      schema.safeParse(understood({ kind: "choose-workout", workoutId: "unknown" })).success,
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
  ])("maps only validated references to host ids: $token", async ({ token, mapped }) => {
    await expect(
      translateChangeRequest("request", {
        ...context,
        translator: modelReturning(understood(token)),
      }),
    ).resolves.toEqual(understood(mapped));
  });

  it.each([
    { kind: "inverse", changeId: "change-one" },
    { kind: "choose-workout", workoutId: "unknown" },
    { kind: "choose-workout", workoutId: "candidate-99" },
    { kind: "choose-workout", workoutId: "eligible-first" },
    { kind: "supporting-event", operation: "remove", eventId: "event-99" },
    { kind: "supporting-event", operation: "remove", eventId: "event-one" },
    { kind: "unknown" },
    { kind: "ftp", watts: 0 },
    [
      { kind: "ftp", watts: 220 },
      { kind: "ftp", watts: 230 },
    ],
    null,
  ])("rejects an invalid understood value %j", async (value) => {
    await expect(
      translateChangeRequest("request", {
        ...context,
        translator: modelReturning(understood(value)),
      }),
    ).resolves.toBeNull();
  });

  it.each([
    null,
    { outcome: "ask", value: null },
    { ...asked, value: { kind: "ftp", watts: 220 } },
    { ...asked, title: "" },
    { ...asked, extra: true },
  ])("rejects malformed check output %j", async (value) => {
    await expect(
      translateChangeRequest("request", { ...context, translator: modelReturning(value) }),
    ).resolves.toBeNull();
  });

  it("rejects kinds excluded by the host", async () => {
    await expect(
      translateChangeRequest("request", {
        ...context,
        allowedKinds: ["weekday-duration"],
        translator: modelReturning(understood({ kind: "ftp", watts: 220 })),
      }),
    ).resolves.toBeNull();
  });

  it("does not fall back when the model is unavailable", async () => {
    await expect(translateChangeRequest("my ftp is 220", context)).resolves.toBeNull();
    const translator = modelReturning(null);
    translator.calls.mockImplementation(() => {
      throw new Error("provider offline");
    });
    await expect(
      translateChangeRequest("my ftp is 220", { ...context, translator }),
    ).resolves.toBeNull();
    expect(translator.calls).toHaveBeenCalledOnce();
  });

  it("asks through the model even when no workouts are eligible", async () => {
    const translator = modelReturning(asked);
    await expect(
      translateChangeRequest("what should i ride today", {
        ...context,
        eligibleWorkouts: [],
        translator,
      }),
    ).resolves.toEqual(asked);
    expect(translator.calls).toHaveBeenCalledOnce();
    expect(translator.calls.mock.calls[0][2]).toMatchObject({ candidates: [] });
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
    for (const intent of intents) expect(schema.safeParse(understood(intent)).success).toBe(true);
    expect(new Set(intents.map((intent) => intent.kind))).toEqual(new Set(supportedChangeKinds));
  });

  it("serializes an empty allowed-kind set without admitting an intent", () => {
    const schema = changeTranslationSchema({ ...context, eligibleWorkouts: [], allowedKinds: [] });
    expect(() => z.toJSONSchema(schema)).not.toThrow();
    expect(schema.safeParse(asked).success).toBe(true);
    expect(schema.safeParse(understood({ kind: "ftp", watts: 220 })).success).toBe(false);
  });
});
