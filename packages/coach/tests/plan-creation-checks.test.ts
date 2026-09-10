import { createHash } from "node:crypto";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { IntentTranslationPort } from "@enduragent/engine";
import {
  PlanCreationCardModelSchema,
  PlanCreationPendingCheckSchema,
  type PlanCreationAnswerInput,
  type PlanCreationAnswerRpcParams,
  type PlanCreationAnswerRpcResult,
  type PlanCreationCardModel,
  type PlanCreationCheckProgress,
  type PlanCreationCheckSubmission,
} from "@enduragent/coach-contract";
import { canonicalJson } from "@enduragent/kernel/archive";
import {
  createPlanCreationRepository,
  createPlanningPendingCheckRepository,
} from "@enduragent/kernel/planning";
import { runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "@enduragent/kernel-node/sqlite";
import { createPlanCreationOperations } from "../src/plan-creation-operations.js";
import { readPlanCreationAnswers } from "../src/plan-creation-answers.js";

const id = (value: number) => String(value).padStart(26, "0");
const today = "1998-09-02";
const nowMs = 904_694_400_000;
const knownRule = { kind: "weekday-duration", day: 3, minutes: 30 } as const;
const understood = (value: unknown) => ({
  outcome: "understood",
  title: "Did I read this right?",
  body: "Confirm the answer I understood.",
  value,
});
const ask = {
  outcome: "ask",
  title: "Tell me a little more",
  body: "I need a more specific answer.",
  value: null,
};
const skip = {
  outcome: "skip",
  title: "Use the usual choice?",
  body: "You can continue with the usual choice.",
  value: null,
};
const submissionFor = (field: PlanCreationCheckSubmission["field"]): PlanCreationCheckSubmission =>
  field === "event"
    ? { field, text: "Autumn tour", date: "1998-10-18" }
    : {
        field,
        text:
          field === "commitments" ? "Wednesdays at most 30 minutes" : "Ride farther and feel good",
      };
const valueFor = (field: PlanCreationCheckSubmission["field"]) =>
  field === "event"
    ? { name: "Autumn Tour", date: "1998-10-18" }
    : field === "commitments"
      ? [knownRule]
      : "Ride farther comfortably";
const cardFrom = (result: PlanCreationAnswerRpcResult) => {
  if (result.status !== "answered")
    throw new Error(`Expected an answer, received ${result.reason}`);
  return result.planCreation;
};
const pendingFrom = (card: PlanCreationCardModel) => {
  if (card.pendingCheck === null) throw new Error("Expected a pending check");
  return card.pendingCheck;
};
const deferred = <T>() => {
  let complete = (_value: T): void => {
    throw new Error("Promise is not initialized");
  };
  const promise = new Promise<T>((resolve) => {
    complete = resolve;
  });
  return { promise, resolve: (value: T) => complete(value) };
};

async function fixture(
  field: PlanCreationCheckSubmission["field"] = "commitments",
  goalKind: "fitness" | "event" = "fitness",
) {
  const store = openSqliteStorage(":memory:");
  onTestFinished(() => store.close());
  await runMigrations(store, MIGRATIONS);
  const repository = createPlanCreationRepository(store);
  let sequence = 100;
  const script = vi.fn<() => Promise<unknown>>(async () => understood(valueFor(field)));
  const translator: IntentTranslationPort = {
    translateIntent: async (_text, schema) => schema.parse(await script()),
  };
  const translateIntent = vi.spyOn(translator, "translateIntent");
  const hostInput = {
    store,
    repository,
    translator,
    identity: {
      deviceId: async () => "creation-check-tests",
      newUlid: () => id(++sequence),
      hlcStamp: () => ({ physicalMs: nowMs + ++sequence, counter: 0 }),
    },
    crypto: globalThis.crypto,
    eventCandidates: {
      read: async () => [{ name: "Autumn Tour", date: "1998-10-18", sourceLabel: "Calendar" }],
    },
    eventSources: { read: async () => [] },
    language: async () => "en",
    today: () => today,
    todayDateKey: () => 19980902,
    now: () => nowMs,
  };
  const host = createPlanCreationOperations(hostInput);
  await host.ready();
  const started = await host["plan_creation.start"]({ commandId: "start" });
  if (started.status !== "started") throw new Error("Expected a creation");
  const request = async (answer: PlanCreationAnswerInput): Promise<PlanCreationAnswerRpcParams> => {
    const card = await host.readCard();
    if (card === null) throw new Error("Expected an unfinished creation");
    return {
      commandId: `answer-${++sequence}`,
      creationId: card.creationId,
      expectedVersion: card.version,
      answer,
    };
  };
  const answer = async (value: PlanCreationAnswerInput) =>
    cardFrom(await host["plan_creation.answer"](await request(value)));
  const action = async (action: "confirm" | "cancel" | "skip" | "retry") => {
    const card = await host.readCard();
    if (card === null) throw new Error("Expected an unfinished creation");
    return answer({ kind: "check-action", action, checkId: pendingFrom(card).checkId });
  };
  if (field !== "event") {
    const snapshot = await repository.readUnfinished();
    const candidate = snapshot?.seed?.eventCandidates[0];
    if (candidate === undefined) throw new Error("Expected an event candidate");
    await answer(
      goalKind === "fitness"
        ? { kind: "goal", goal: { kind: "fitness" } }
        : { kind: "goal", goal: { kind: "event-candidate", candidateId: candidate.candidateId } },
    );
    if (goalKind === "fitness") await answer({ kind: "plan-length", weeks: 8 });
    for (const value of [
      { kind: "schedule-mode", mode: "fixed" },
      {
        kind: "availability",
        mode: "fixed",
        weeklyHoursLimit: 8,
        longestWorkoutHours: 3,
        usableWeekdays: [1, 3, 6],
      },
      { kind: "start-timing", timing: { kind: "as-soon-as-possible" } },
    ] satisfies PlanCreationAnswerInput[])
      await answer(value);
    if (field === "success") {
      await answer({ kind: "commitments", commitments: { kind: "none" } });
      await answer({ kind: "baseline", baseline: "regular" });
    }
  }
  const rows = () =>
    store.all("SELECT answer_key,value_json FROM plan_creation_answer ORDER BY sequence");
  return {
    store,
    repository,
    host,
    request,
    answer,
    action,
    rows,
    script,
    translateIntent,
    restore: () => createPlanCreationOperations(hostInput),
  };
}

describe("model checks for typed creation answers", () => {
  it.each([
    ["commitments", "understood"],
    ["commitments", "ask"],
    ["commitments", "skip"],
    ["success", "understood"],
    ["success", "ask"],
    ["success", "skip"],
    ["event", "understood"],
    ["event", "ask"],
  ] as const)(
    "checks %s with the %s outcome without recording an answer",
    async (field, outcome) => {
      const test = await fixture(field);
      const before = await test.rows();
      const beforeCard = await test.host.readCard();
      const result =
        outcome === "understood" ? understood(valueFor(field)) : outcome === "ask" ? ask : skip;
      test.script.mockResolvedValue(result);
      const submission = submissionFor(field);
      const card = await test.answer({ kind: "check-submit", submission });
      expect(card.pendingCheck).toMatchObject({ submission, state: "ready", result });
      expect(card.pendingCommitment).toBeNull();
      expect(card.version).toBe(beforeCard?.version);
      expect(card.answeredSummaries).toEqual(beforeCard?.answeredSummaries);
      expect(await test.rows()).toEqual(before);
      expect(test.translateIntent).toHaveBeenCalledExactlyOnceWith(
        submission.text,
        expect.anything(),
        expect.objectContaining({ field, today, language: "en", candidates: [], events: [] }),
      );
      expect(await test.host.readCard()).toEqual(card);
    },
  );

  it.each(["commitments", "success", "event"] as const)(
    "confirms only the model's cleaned %s value",
    async (field) => {
      const test = await fixture(field);
      const before = await test.rows();
      const card = await test.answer({ kind: "check-submit", submission: submissionFor(field) });
      const confirmed = await test.action("confirm");
      expect(confirmed.pendingCheck).toBeNull();
      expect(confirmed.version).toBe(card.version + 1);
      expect(await test.rows()).toHaveLength(before.length + 1);
      const snapshot = await test.repository.readUnfinished();
      if (snapshot === undefined) throw new Error("Expected a creation");
      const answer = readPlanCreationAnswers(snapshot).at(-1)?.answer;
      expect(answer).toEqual(
        field === "commitments"
          ? {
              kind: "commitments",
              commitments: {
                kind: "interpreted",
                text: submissionFor(field).text,
                status: "confirmed",
                rules: [knownRule],
              },
            }
          : field === "success"
            ? { kind: "success", success: { kind: "authored", text: "Ride farther comfortably" } }
            : {
                kind: "goal",
                goal: { kind: "event-manual", name: "Autumn Tour", date: "1998-10-18" },
              },
      );
      expect(test.translateIntent).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { kind: "commitments-interpret", text: "Wednesdays at most 30 minutes" },
    {
      kind: "commitments",
      commitments: { kind: "interpreted", text: "Wednesdays at most 30 minutes" },
    },
    {
      kind: "check-submit",
      submission: { field: "commitments", text: "Wednesdays at most 30 minutes" },
    },
  ] satisfies PlanCreationAnswerInput[])(
    "uses the model for the $kind typed commitment path",
    async (answer) => {
      const test = await fixture();
      expect((await test.answer(answer)).pendingCheck?.state).toBe("ready");
      expect(test.translateIntent).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    {
      field: "success",
      answer: {
        kind: "success",
        success: { kind: "authored", text: "Ride farther and feel good" },
      },
    },
    {
      field: "event",
      answer: {
        kind: "goal",
        goal: { kind: "event-manual", name: "Autumn tour", date: "1998-10-18" },
      },
    },
  ] satisfies { field: PlanCreationCheckSubmission["field"]; answer: PlanCreationAnswerInput }[])(
    "intercepts the ordinary typed $field answer before it is recorded",
    async ({ field, answer }) => {
      const test = await fixture(field);
      const before = await test.rows();
      expect((await test.answer(answer)).pendingCheck).toMatchObject({
        state: "ready",
        submission: { field },
      });
      expect(await test.rows()).toEqual(before);
      expect(test.translateIntent).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["", " ", "a".repeat(2001)])(
    "rejects a blank or oversized submission before model admission",
    async (text) => {
      const test = await fixture();
      const before = await test.rows();
      const request = await test.request({
        kind: "check-submit",
        submission: { field: "commitments", text },
      });
      await expect(test.host["plan_creation.answer"](request)).rejects.toThrow();
      expect(test.translateIntent).not.toHaveBeenCalled();
      expect(await test.rows()).toEqual(before);
      expect((await test.host.readCard())?.pendingCheck).toBeNull();
    },
  );

  it("checks an exactly 2000-character submission", async () => {
    const test = await fixture();
    const text = "a".repeat(2000);
    expect(
      (await test.answer({ kind: "check-submit", submission: { field: "commitments", text } }))
        .pendingCheck?.state,
    ).toBe("ready");
    expect(test.translateIntent.mock.calls[0]?.[0]).toBe(text);
  });

  it.each([
    null,
    {
      outcome: "understood",
      title: "A title",
      body: "A paragraph",
      value: [{ kind: "weekday-duration", day: 9, minutes: 30 }],
    },
    { outcome: "understood", title: "A title", body: "Two\nparagraphs", value: [knownRule] },
    { outcome: "ask", title: "A title", body: "A paragraph", value: [knownRule] },
  ])("keeps schema-rejected output as an error and never falls back to regex", async (output) => {
    const test = await fixture();
    const before = await test.rows();
    test.script.mockResolvedValue(output);
    const card = await test.answer({
      kind: "check-submit",
      submission: submissionFor("commitments"),
    });
    expect(card.pendingCheck).toMatchObject({ state: "error" });
    expect(await test.rows()).toEqual(before);
    expect(test.translateIntent).toHaveBeenCalledTimes(1);
  });

  it("turns a null model response into a retryable error without fallback", async () => {
    const test = await fixture();
    test.translateIntent.mockResolvedValueOnce(null);
    const before = await test.rows();
    const card = await test.answer({
      kind: "check-submit",
      submission: submissionFor("commitments"),
    });
    expect(card.pendingCheck?.state).toBe("error");
    expect(await test.rows()).toEqual(before);
  });

  it.each([skip, understood({ name: "Autumn Tour", date: "1998-10-19" })])(
    "rejects an event skip or a changed event date",
    async (output) => {
      const test = await fixture("event");
      test.script.mockResolvedValue(output);
      const card = await test.answer({ kind: "check-submit", submission: submissionFor("event") });
      expect(card.pendingCheck).toMatchObject({ state: "error" });
      expect(await test.rows()).toEqual([]);
      expect((await test.action("cancel")).openQuestion?.kind).toBe("goal-question");
    },
  );

  it.each([20, 21])("enforces the 20-rule limit on %i returned rules", async (count) => {
    const test = await fixture();
    const before = await test.rows();
    const rules = Array.from({ length: count }, (_, index) => ({
      kind: "time-off",
      start: `${1900 + index}-09-01`,
      end: `${1900 + index}-09-02`,
    }));
    test.script.mockResolvedValue(understood(rules));
    const card = await test.answer({
      kind: "check-submit",
      submission: submissionFor("commitments"),
    });
    expect(card.pendingCheck?.state).toBe(count === 20 ? "ready" : "error");
    expect(await test.rows()).toEqual(before);
    if (count === 20) {
      const confirmed = await test.action("confirm");
      expect(
        confirmed.answeredSummaries.find((answer) => answer.answerKey === "commitments")?.detail
          .length,
      ).toBeLessThanOrEqual(2000);
      expect(PlanCreationCardModelSchema.safeParse(confirmed).success).toBe(true);
    }
  });

  it.each(["commitments", "success"] as const)(
    "rejects confirming an ask card for %s until the athlete chooses skip or answers again",
    async (field) => {
      const test = await fixture(field);
      test.script.mockResolvedValue(ask);
      const card = await test.answer({ kind: "check-submit", submission: submissionFor(field) });
      const before = await test.rows();
      const result = await test.host["plan_creation.answer"](
        await test.request({
          kind: "check-action",
          checkId: pendingFrom(card).checkId,
          action: "confirm",
        }),
      );
      expect(result).toMatchObject({ status: "rejected", reason: "invalid-answer" });
      expect(await test.rows()).toEqual(before);
      expect((await test.host.readCard())?.pendingCheck).toEqual(card.pendingCheck);
    },
  );

  it.each(["ask", "skip"] as const)(
    "preserves previous confirmed commitments when the %s card is skipped",
    async (outcome) => {
      const test = await fixture();
      await test.answer({ kind: "check-submit", submission: submissionFor("commitments") });
      const confirmed = await test.action("confirm");
      const summary = confirmed.answeredSummaries.find(
        (answer) => answer.answerKey === "commitments",
      );
      test.script.mockResolvedValue(outcome === "ask" ? ask : skip);
      const pending = await test.answer({
        kind: "check-submit",
        submission: { field: "commitments", text: "Maybe away sometimes" },
      });
      expect(
        pending.answeredSummaries.find((answer) => answer.answerKey === "commitments"),
      ).toEqual(summary);
      const restored = await test.action(outcome === "ask" ? "skip" : "confirm");
      expect(restored.pendingCheck).toBeNull();
      expect(
        restored.answeredSummaries.find((answer) => answer.answerKey === "commitments"),
      ).toEqual(summary);
    },
  );

  it.each(["fitness", "event"] as const)(
    "uses the approved %s success default only after skip confirmation",
    async (goalKind) => {
      const test = await fixture("success", goalKind);
      test.script.mockResolvedValue(skip);
      const before = await test.rows();
      await test.answer({ kind: "check-submit", submission: submissionFor("success") });
      expect(await test.rows()).toEqual(before);
      const confirmed = await test.action("confirm");
      expect(
        confirmed.answeredSummaries.find((answer) => answer.answerKey === "success")?.answer,
      ).toEqual(
        goalKind === "fitness"
          ? { kind: "success", success: { kind: "fitness-choice", choice: "train-consistently" } }
          : { kind: "success", success: { kind: "event-finish", choice: "finish-comfortably" } },
      );
    },
  );

  it("keeps previous confirmed answers while checks fail, retry, and cancel", async () => {
    const test = await fixture();
    await test.answer({ kind: "check-submit", submission: submissionFor("commitments") });
    await test.action("confirm");
    const confirmedRows = await test.rows();
    test.script.mockRejectedValueOnce(new Error("Model offline"));
    const failed = await test.answer({
      kind: "check-submit",
      submission: { field: "commitments", text: "Change Wednesday to an hour" },
    });
    expect(failed.pendingCheck?.state).toBe("error");
    expect(await test.rows()).toEqual(confirmedRows);
    const retried = await test.action("retry");
    expect(retried.pendingCheck).toMatchObject({ state: "ready", attempt: 2 });
    expect(test.translateIntent).toHaveBeenCalledTimes(3);
    expect((await test.action("cancel")).pendingCheck).toBeNull();
    expect(await test.rows()).toEqual(confirmedRows);
  });

  it("emits busy progress before the model finishes and persists that state", async () => {
    const test = await fixture();
    const model = deferred<unknown>();
    const emitted = deferred<PlanCreationCheckProgress>();
    test.script.mockReturnValueOnce(model.promise);
    const before = await test.rows();
    const request = await test.request({
      kind: "check-submit",
      submission: submissionFor("commitments"),
    });
    const running = test.host["plan_creation.answer"](request, emitted.resolve);
    const event = await emitted.promise;
    expect(event).toMatchObject({
      type: "answer-check",
      planCreation: { pendingCheck: { state: "busy", commandId: request.commandId } },
    });
    expect((await test.host.readCard())?.pendingCheck?.state).toBe("busy");
    expect(await test.rows()).toEqual(before);
    model.resolve(understood([knownRule]));
    expect(cardFrom(await running).pendingCheck?.state).toBe("ready");
  });

  it("joins concurrent duplicate requests and rejects a conflicting digest", async () => {
    const test = await fixture();
    const model = deferred<unknown>();
    const emitted = deferred<PlanCreationCheckProgress>();
    test.script.mockReturnValueOnce(model.promise);
    const request = await test.request({
      kind: "check-submit",
      submission: submissionFor("commitments"),
    });
    const first = test.host["plan_creation.answer"](request, emitted.resolve);
    await emitted.promise;
    const duplicate = test.host["plan_creation.answer"](request);
    expect(
      await test.host["plan_creation.answer"]({ ...request, commandId: "competing-check" }),
    ).toMatchObject({ status: "rejected", reason: "invalid-answer" });
    const conflict = await test.host["plan_creation.answer"]({
      ...request,
      answer: {
        kind: "check-submit",
        submission: { field: "commitments", text: "Different text" },
      },
    });
    expect(conflict).toMatchObject({ status: "rejected", reason: "command-conflict" });
    model.resolve(understood([knownRule]));
    expect(await duplicate).toEqual(await first);
    expect(test.translateIntent).toHaveBeenCalledTimes(1);
  });

  it("replays the exact checked and confirmed responses after newer checks and version changes", async () => {
    const test = await fixture();
    const request = await test.request({
      kind: "check-submit",
      submission: submissionFor("commitments"),
    });
    const original = await test.host["plan_creation.answer"](request);
    const confirmRequest = await test.request({
      kind: "check-action",
      action: "confirm",
      checkId: pendingFrom(cardFrom(original)).checkId,
    });
    const confirmed = await test.host["plan_creation.answer"](confirmRequest);
    test.script.mockResolvedValue(ask);
    await test.answer({
      kind: "check-submit",
      submission: { field: "commitments", text: "Maybe another day" },
    });
    const before = await test.host.readCard();
    expect(await test.host["plan_creation.answer"](request)).toEqual(original);
    expect(await test.host["plan_creation.answer"](confirmRequest)).toEqual(confirmed);
    expect(await test.host.readCard()).toEqual(before);
    expect(test.translateIntent).toHaveBeenCalledTimes(2);
  });

  it("recovers persisted busy checks as retryable errors without a model call", async () => {
    const test = await fixture();
    const request = await test.request({
      kind: "check-submit",
      submission: submissionFor("commitments"),
    });
    const check = PlanCreationPendingCheckSchema.parse({
      schemaVersion: 1,
      checkId: id(900),
      commandId: request.commandId,
      sourceVersion: request.expectedVersion,
      attempt: 1,
      submission: submissionFor("commitments"),
      state: "busy",
    });
    await createPlanningPendingCheckRepository(test.store).admit({
      command: {
        commandId: request.commandId,
        requestDigest: createHash("sha256").update(canonicalJson(request)).digest("hex"),
        nowMs: nowMs + 1000,
        deviceId: "creation-check-tests",
        hlcPhysicalMs: nowMs + 1000,
        hlcCounter: 0,
      },
      check: {
        owner: {
          kind: "creation",
          creationId: request.creationId,
          sourceVersion: request.expectedVersion,
        },
        checkId: check.checkId,
        commandId: check.commandId,
        attempt: 1,
        state: "busy",
        submissionJson: canonicalJson(check.submission),
        checkJson: canonicalJson(check),
      },
    });
    const restored = test.restore();
    await restored.ready();
    const card = await restored.readCard();
    expect(card?.pendingCheck).toMatchObject({
      state: "error",
      message: "The answer check was interrupted. Try again.",
    });
    expect(test.translateIntent).not.toHaveBeenCalled();
    expect(await restored["plan_creation.answer"](request)).toEqual({
      status: "answered",
      planCreation: card,
    });
    expect(await createPlanningPendingCheckRepository(test.store).listPendingCommands()).toEqual(
      [],
    );
  });

  it.each(["answer", "discard"] as const)(
    "rejects late model results after the owner changes through %s",
    async (operation) => {
      const test = await fixture();
      const model = deferred<unknown>();
      const emitted = deferred<PlanCreationCheckProgress>();
      test.script.mockReturnValueOnce(model.promise);
      const request = await test.request({
        kind: "check-submit",
        submission: submissionFor("commitments"),
      });
      const running = test.host["plan_creation.answer"](request, emitted.resolve);
      await emitted.promise;
      if (operation === "answer") await test.answer({ kind: "schedule-mode", mode: "flexible" });
      else
        await test.host["plan_creation.discard"]({
          commandId: "discard",
          creationId: request.creationId,
          expectedVersion: request.expectedVersion,
        });
      const rows = await test.rows();
      model.resolve(understood([knownRule]));
      const result = await running;
      expect(result).toMatchObject({ status: "rejected", reason: "stale-version" });
      expect(await test.rows()).toEqual(rows);
      expect(await test.host["plan_creation.answer"](request)).toEqual(result);
      expect((await test.host.readCard())?.pendingCheck ?? null).toBeNull();
    },
  );
  it("uses no fixed commitments when an empty previous answer is skipped", async () => {
    const test = await fixture();
    test.script.mockResolvedValue(skip);
    await test.answer({
      kind: "check-submit",
      submission: { field: "commitments", text: "Ignore this" },
    });
    const confirmed = await test.action("confirm");
    expect(
      confirmed.answeredSummaries.find((answer) => answer.answerKey === "commitments")?.answer,
    ).toEqual({ kind: "commitments", commitments: { kind: "none" } });
  });

  it("retains an event ask card when a caller requests a skip", async () => {
    const test = await fixture("event");
    test.script.mockResolvedValue(ask);
    const card = await test.answer({ kind: "check-submit", submission: submissionFor("event") });
    const request = await test.request({
      kind: "check-action",
      action: "skip",
      checkId: pendingFrom(card).checkId,
    });
    expect(await test.host["plan_creation.answer"](request)).toMatchObject({
      status: "rejected",
      reason: "invalid-answer",
    });
    expect(await test.rows()).toEqual([]);
    expect((await test.host.readCard())?.pendingCheck).toEqual(card.pendingCheck);
  });

  it("rejects typed answers out of order and stale versions before model work", async () => {
    const test = await fixture("event");
    const request = await test.request({
      kind: "check-submit",
      submission: submissionFor("commitments"),
    });
    expect(await test.host["plan_creation.answer"](request)).toMatchObject({
      status: "rejected",
      reason: "answer-not-expected",
    });
    expect(
      await test.host["plan_creation.answer"]({
        ...request,
        commandId: "stale",
        expectedVersion: 10,
      }),
    ).toMatchObject({ status: "rejected", reason: "stale-version" });
    expect(test.translateIntent).not.toHaveBeenCalled();
    expect(await test.rows()).toEqual([]);
  });

  it("replaces ready checks and replays cancellation without changing a newer check", async () => {
    const test = await fixture();
    const request = await test.request({
      kind: "check-submit",
      submission: submissionFor("commitments"),
    });
    const first = await test.host["plan_creation.answer"](request);
    const replacement = await test.answer({
      kind: "check-submit",
      submission: { field: "commitments", text: "Wednesdays half an hour" },
    });
    expect(replacement.version).toBe(cardFrom(first).version);
    expect(pendingFrom(replacement).checkId).not.toBe(pendingFrom(cardFrom(first)).checkId);
    expect(await test.host["plan_creation.answer"](request)).toEqual(first);
    const cancel = await test.request({
      kind: "check-action",
      action: "cancel",
      checkId: pendingFrom(replacement).checkId,
    });
    const cancelled = await test.host["plan_creation.answer"](cancel);
    const newest = await test.answer({
      kind: "check-submit",
      submission: submissionFor("commitments"),
    });
    expect(await test.host["plan_creation.answer"](cancel)).toEqual(cancelled);
    expect(await test.host.readCard()).toEqual(newest);
    expect(test.translateIntent).toHaveBeenCalledTimes(3);
  });

  it("projects stored legacy clarification without checking it again on startup", async () => {
    const test = await fixture();
    const current = await test.repository.readUnfinished();
    if (current === undefined) throw new Error("Expected an unfinished creation");
    await test.repository.recordAnswer({
      command: {
        commandId: "legacy",
        requestDigest: "a".repeat(64),
        nowMs: nowMs + 1000,
        deviceId: "creation-check-tests",
        hlcPhysicalMs: nowMs + 1000,
        hlcCounter: 0,
      },
      creationId: current.id,
      expectedVersion: current.version,
      answerId: id(900),
      answerKey: "commitments",
      valueJson: canonicalJson({
        answer: {
          kind: "commitments",
          commitments: {
            kind: "interpreted",
            text: "Maybe away sometime",
            rules: [],
            status: "clarify",
          },
        },
        source: { kind: "athlete" },
      }),
    });
    const restored = test.restore();
    await restored.ready();
    expect(await restored.readCard()).toMatchObject({
      pendingCheck: null,
      pendingCommitment: { status: "clarify", text: "Maybe away sometime", rules: [] },
    });
    expect(test.translateIntent).not.toHaveBeenCalled();
  });
});
