import type { IntentTranslationPort } from "@enduragent/engine";
import type { PlanCreationAnswerInput } from "../../../packages/coach-contract/src/plan-creation.js";
import { createPlanCreationRepository } from "@enduragent/kernel/planning";
import { runMigrations } from "@enduragent/kernel/store";
import { MIGRATIONS } from "@enduragent/kernel/store/migrations";
import { openSqliteStorage } from "../../../packages/kernel-node/src/sqlite/index.js";
import { createPlanCreationOperations } from "../../../packages/coach/src/plan-creation-operations.js";
import { canonicalJson } from "./canonical.js";
import type { AnswerCheckCase, AnswerCheckObservation, RecordedCall } from "./types.js";

export async function runAnswerCheck(
  test: AnswerCheckCase,
  translator: IntentTranslationPort,
): Promise<AnswerCheckObservation> {
  const store = openSqliteStorage(":memory:");
  try {
    await runMigrations(store, MIGRATIONS);
    const repository = createPlanCreationRepository(store);
    let sequence = 100;
    const host = createPlanCreationOperations({
      store,
      repository,
      translator,
      identity: {
        deviceId: async () => "s8a-answer-check-device",
        newUlid: () => String(++sequence).padStart(26, "0"),
        hlcStamp: () => ({ physicalMs: 904737600000, counter: 0 }),
      },
      crypto: globalThis.crypto,
      eventCandidates: {
        read: async () => [{ name: "Autumn Tour", date: "1998-10-18", sourceLabel: "Calendar" }],
      },
      eventSources: { read: async () => [] },
      language: async () => "en",
      today: () => "1998-09-02",
      now: () => 904737600000,
    });
    const started = await host["plan_creation.start"]({ commandId: "start" });
    if (started.status !== "started") throw new Error("Answer-check fixture did not start");
    let card = started.planCreation;
    const candidate = (await repository.readUnfinished())?.seed?.eventCandidates[0];
    if (candidate === undefined) throw new Error("Answer-check event fixture is missing");
    const submit = async (answer: PlanCreationAnswerInput) => {
      const response = await host["plan_creation.answer"]({
        commandId: `answer-${++sequence}`,
        creationId: card.creationId,
        expectedVersion: card.version,
        answer,
      });
      if (response.status !== "answered")
        throw new Error(`Answer-check fixture rejected: ${response.reason}`);
      card = response.planCreation;
    };
    const preceding: PlanCreationAnswerInput[] = [
      { kind: "goal", goal: { kind: "event-candidate", candidateId: candidate.candidateId } },
      { kind: "schedule-mode", mode: "flexible" },
      { kind: "availability", mode: "flexible", weeklyHoursLimit: 8, longestWorkoutHours: 3 },
      { kind: "start-timing", timing: { kind: "as-soon-as-possible" } },
      ...(test.field === "success"
        ? ([
            { kind: "commitments", commitments: { kind: "none" } },
            { kind: "baseline", baseline: "regular" },
          ] satisfies PlanCreationAnswerInput[])
        : []),
    ];
    for (const answer of preceding) await submit(answer);
    const before = await repository.readUnfinished();
    let busyObserved = false;
    const start = performance.now();
    const response = await host["plan_creation.answer"](
      {
        commandId: `check-${test.id}`,
        creationId: card.creationId,
        expectedVersion: card.version,
        answer: { kind: "check-submit", submission: { field: test.field, text: test.text } },
      },
      (event) => {
        busyObserved ||= event.planCreation.pendingCheck?.state === "busy";
      },
    );
    const elapsedMs = performance.now() - start;
    if (response.status !== "answered")
      throw new Error(`Answer check rejected: ${response.reason}`);
    card = response.planCreation;
    const check = card.pendingCheck;
    if (check?.state !== "ready")
      throw new Error(`Answer check did not become ready: ${check?.state}`);
    const after = await repository.readUnfinished();
    const unchangedBeforeConfirmation =
      before?.version === after?.version &&
      canonicalJson(before?.answers) === canonicalJson(after?.answers);
    await submit({ kind: "check-action", checkId: check.checkId, action: test.expected.action });
    const final = await repository.readUnfinished();
    const saved = final?.answers
      .slice()
      .reverse()
      .find((answer) => answer.answerKey === test.field);
    return {
      id: test.id,
      elapsedMs,
      busyObserved,
      unchangedBeforeConfirmation,
      result: check.result,
      savedAnswer:
        saved === undefined ? null : (JSON.parse(saved.valueJson) as { answer: unknown }).answer,
    };
  } finally {
    store.close();
  }
}

export function validateAnswerChecks(
  cases: AnswerCheckCase[],
  calls: RecordedCall[],
  observations: AnswerCheckObservation[],
  recorded?: AnswerCheckObservation[],
): string[] {
  const errors: string[] = [];
  if (observations.length !== cases.length)
    errors.push("answer-check observation count differs from scenario cases");
  if (
    calls.some(
      (call) =>
        call.caller !== "intent-translation" || !cases.some((test) => test.id === call.checkId),
    )
  )
    errors.push("unexpected model caller or answer-check attribution");
  for (const test of cases) {
    const observed = observations.find((value) => value.id === test.id);
    if (observed === undefined) {
      errors.push(`${test.id}: missing answer-check observation`);
      continue;
    }
    const scoped = calls.filter((call) => call.checkId === test.id);
    if (scoped.length < 1 || scoped.length > 2)
      errors.push(`${test.id}: expected one model call and at most one repair`);
    for (const [index, call] of scoped.entries()) {
      const request = call.request;
      if (
        request.shape !== "intent-translation" ||
        request.input.shape !== (index === 0 ? "prompt" : "messages") ||
        request.deadlineMs <= 0 ||
        request.deadlineMs > 30_000 ||
        request.maxSteps !== 1 ||
        request.toolNames.length !== 0 ||
        call.toolExecutions.length !== 0 ||
        call.result.toolCalls.length !== 0
      )
        errors.push(`${test.id}: invalid answer-check model request or tool call`);
    }
    if (observed.elapsedMs > 30_000) errors.push(`${test.id}: answer check exceeded 30 seconds`);
    if (!observed.busyObserved || !observed.unchangedBeforeConfirmation)
      errors.push(`${test.id}: busy state or confirmation boundary failed`);
    const result = observed.result as {
      outcome?: unknown;
      title?: unknown;
      body?: unknown;
      value?: unknown;
    } | null;
    if (
      result?.outcome !== test.expected.outcome ||
      canonicalJson(result?.value) !== canonicalJson(test.expected.value)
    )
      errors.push(`${test.id}: outcome or cleaned value differs from expectation`);
    if (
      typeof result?.title !== "string" ||
      result.title.trim().length === 0 ||
      typeof result.body !== "string" ||
      result.body.trim().length === 0 ||
      /[\r\n]/.test(result.body)
    )
      errors.push(`${test.id}: missing title or single-paragraph body`);
    if (canonicalJson(observed.savedAnswer) !== canonicalJson(test.expected.savedAnswer))
      errors.push(`${test.id}: confirmed answer differs from expectation`);
    if (recorded !== undefined) {
      const baseline = recorded.find((value) => value.id === test.id);
      if (
        baseline === undefined ||
        canonicalJson(baseline.result) !== canonicalJson(observed.result) ||
        canonicalJson(baseline.savedAnswer) !== canonicalJson(observed.savedAnswer)
      )
        errors.push(`${test.id}: result differs from recording`);
    }
  }
  return errors;
}
