import { z } from "zod";
import {
  CommitmentCheckResultSchema,
  EventCheckResultSchema,
  PlanCreationAnswerRpcResultSchema,
  PlanCreationPendingCheckSchema,
  SuccessCheckResultSchema,
  type PlanCreationAnswer,
  type PlanCreationAnswerInput,
  type PlanCreationAnswerRpcParams,
  type PlanCreationAnswerRpcResult,
  type PlanCreationCardModel,
  type PlanCreationCheckProgress,
  type PlanCreationCheckSubmission,
  type PlanCreationPendingCheck,
} from "@enduragent/coach-contract";
import type { IntentTranslationPort } from "@enduragent/engine";
import { canonicalJson } from "@enduragent/kernel/archive";
import {
  createPlanCreationRepository,
  createPlanningPendingCheckRepository,
  PlanCreationStoreError,
  type PlanCreationCommandStamp,
  type PlanCreationSnapshot,
  type PlanCreationStore,
  type PlanningPendingCheck,
} from "@enduragent/kernel/planning";
import {
  confirmedCommitments,
  encodePlanCreationAnswer,
  resolvePlanCreationAnswerFlow,
  validPlanCreationAnswer,
  validateCommitmentInterpretation,
} from "./plan-creation-answers.js";

export function typedCreationSubmission(
  answer: PlanCreationAnswerInput,
): PlanCreationCheckSubmission | null {
  if (answer.kind === "check-submit") return answer.submission;
  if (answer.kind === "commitments-interpret") return { field: "commitments", text: answer.text };
  if (answer.kind === "commitments" && answer.commitments.kind === "interpreted")
    return { field: "commitments", text: answer.commitments.text };
  if (answer.kind === "success" && answer.success.kind === "authored")
    return { field: "success", text: answer.success.text };
  if (answer.kind === "goal" && answer.goal.kind === "event-manual")
    return { field: "event", text: answer.goal.name, date: answer.goal.date };
  return null;
}

export function createPlanCreationChecks(input: {
  store: PlanCreationStore;
  newId: () => string;
  stamp: (commandId: string, digest: string) => Promise<PlanCreationCommandStamp>;
  digest: (value: unknown) => Promise<string>;
  project: (snapshot: PlanCreationSnapshot) => Promise<PlanCreationCardModel>;
  translator: IntentTranslationPort;
  language: (text: string) => Promise<string>;
  today: () => string;
}) {
  const repository = createPlanningPendingCheckRepository(input.store);
  const creations = createPlanCreationRepository(input.store);
  const running = new Map<
    string,
    { digest: string; result: Promise<PlanCreationAnswerRpcResult> }
  >();
  const parse = (json: string) => PlanCreationAnswerRpcResultSchema.parse(JSON.parse(json));
  const rejected = async (
    reason:
      | "stale-version"
      | "command-conflict"
      | "no-unfinished-creation"
      | "answer-not-expected"
      | "invalid-answer",
  ): Promise<PlanCreationAnswerRpcResult> => {
    const snapshot = await creations.readUnfinished();
    return {
      status: "rejected",
      reason,
      planCreation: snapshot === undefined ? null : await input.project(snapshot),
    };
  };
  const response = async (
    snapshot: PlanCreationSnapshot,
  ): Promise<PlanCreationAnswerRpcResult> => ({
    status: "answered",
    planCreation: await input.project(snapshot),
  });
  const withCheck = (
    snapshot: PlanCreationSnapshot,
    check: PlanningPendingCheck | null,
  ): PlanCreationSnapshot => ({
    ...snapshot,
    pendingCheckJson: check === null ? null : canonicalJson(check),
  });
  const recover = async () => {
    for (const { check, command } of await repository.listPendingCommands()) {
      if (check.owner.kind !== "creation") continue;
      const wire = PlanCreationPendingCheckSchema.parse(JSON.parse(check.checkJson));
      const failed = {
        ...wire,
        state: "error" as const,
        message: "The answer check was interrupted. Try again.",
      };
      const stored = { ...check, state: "error" as const, checkJson: canonicalJson(failed) };
      const snapshot = await creations.readUnfinished();
      const stale = canonicalJson({
        status: "rejected",
        reason: "stale-version",
        planCreation: null,
      });
      await repository.settle({
        command,
        check: stored,
        resultJson:
          snapshot?.id === check.owner.creationId
            ? canonicalJson(await response(withCheck(snapshot, stored)))
            : stale,
        staleResultJson: stale,
      });
    }
  };
  let recovery: Promise<void> | undefined;
  const ready = () => (recovery ??= recover());

  const save = async (
    request: PlanCreationAnswerRpcParams,
    command: PlanCreationCommandStamp,
    snapshot: PlanCreationSnapshot,
  ): Promise<PlanCreationAnswerRpcResult> => {
    if (request.answer.kind !== "check-action") return rejected("invalid-answer");
    const action = request.answer;
    const json = await repository.resolve({
      owner: {
        kind: "creation",
        creationId: request.creationId,
        sourceVersion: request.expectedVersion,
      },
      command,
      checkId: action.checkId,
      async effect(store, stored) {
        const check = PlanCreationPendingCheckSchema.parse(JSON.parse(stored.checkJson));
        const ownerRepository = createPlanCreationRepository(store);
        let answer: PlanCreationAnswer | null = null;
        if (
          action.action === "confirm" &&
          check.state === "ready" &&
          check.result.outcome === "understood"
        ) {
          if (check.submission.field === "commitments") {
            const result = CommitmentCheckResultSchema.parse(check.result);
            if (result.outcome === "understood")
              answer = {
                kind: "commitments",
                commitments: {
                  kind: "interpreted",
                  text: check.submission.text,
                  rules: result.value,
                  status: "confirmed",
                },
              };
          } else if (check.submission.field === "success") {
            const result = SuccessCheckResultSchema.parse(check.result);
            if (result.outcome === "understood")
              answer = { kind: "success", success: { kind: "authored", text: result.value } };
          } else {
            const result = EventCheckResultSchema.parse(check.result);
            if (result.outcome === "understood")
              answer = { kind: "goal", goal: { kind: "event-manual", ...result.value } };
          }
        } else if (
          check.state === "ready" &&
          ((action.action === "skip" && check.result.outcome !== "understood") ||
            (action.action === "confirm" && check.result.outcome === "skip"))
        ) {
          if (check.submission.field === "commitments") answer = confirmedCommitments(snapshot);
          else if (check.submission.field === "success") {
            const goal = resolvePlanCreationAnswerFlow(snapshot).valid.get("goal")?.answer;
            answer = {
              kind: "success",
              success:
                goal?.kind === "goal" && goal.goal.kind === "fitness"
                  ? { kind: "fitness-choice", choice: "train-consistently" }
                  : { kind: "event-finish", choice: "finish-comfortably" },
            };
          } else throw new PlanCreationStoreError("not-ready");
        } else if (action.action !== "cancel") throw new PlanCreationStoreError("not-ready");
        if (answer !== null) {
          if (
            !validPlanCreationAnswer(
              snapshot,
              resolvePlanCreationAnswerFlow(snapshot),
              answer,
              input.today(),
            )
          )
            throw new PlanCreationStoreError("not-ready");
          const innerId = `answer-check-confirm:${await input.digest({ commandId: command.commandId, checkId: check.checkId })}`;
          const result = await ownerRepository.recordAnswer({
            command: { ...command, commandId: innerId },
            creationId: request.creationId,
            expectedVersion: request.expectedVersion,
            answerId: input.newId(),
            answerKey: answer.kind,
            valueJson: encodePlanCreationAnswer(answer, { kind: "athlete" }),
          });
          return canonicalJson(await response(result.snapshot));
        }
        return canonicalJson(await response(withCheck(snapshot, null)));
      },
    });
    return parse(json);
  };

  const run = async (
    request: PlanCreationAnswerRpcParams,
    digest: string,
    onEvent?: (event: PlanCreationCheckProgress) => void,
  ): Promise<PlanCreationAnswerRpcResult> => {
    const command = await input.stamp(request.commandId, digest);
    const replay = await input.store.get(
      "SELECT request_digest,status,result_json,aggregate_refs_json FROM planning_command WHERE command_name='plan_creation.answer' AND command_id=?",
      [request.commandId],
    );
    if (replay !== undefined) {
      if (replay.request_digest !== digest) return rejected("command-conflict");
      const refs = z
        .object({ check: z.literal(true) })
        .safeParse(JSON.parse(z.string().parse(replay.aggregate_refs_json)));
      if (!refs.success) return rejected("command-conflict");
      if (replay.status === "succeeded") return parse(z.string().parse(replay.result_json));
      return rejected("invalid-answer");
    }
    const snapshot = await creations.readUnfinished();
    if (snapshot === undefined || snapshot.id !== request.creationId)
      return rejected("no-unfinished-creation");
    if (snapshot.version !== request.expectedVersion) return rejected("stale-version");
    const owner = {
      kind: "creation" as const,
      creationId: snapshot.id,
      sourceVersion: snapshot.version,
    };
    const existing = await repository.read(owner);
    const action = request.answer.kind === "check-action" ? request.answer : null;
    if (action !== null && action.action !== "retry") return save(request, command, snapshot);
    let submission = typedCreationSubmission(request.answer);
    if (action?.action === "retry") {
      if (existing?.checkId !== action.checkId || existing.state !== "error")
        return rejected("stale-version");
      submission = PlanCreationPendingCheckSchema.parse(JSON.parse(existing.checkJson)).submission;
    }
    if (submission === null) return rejected("invalid-answer");
    const key = submission.field === "event" ? "goal" : submission.field;
    const flow = resolvePlanCreationAnswerFlow(snapshot);
    if (flow.next !== key && !flow.valid.has(key)) return rejected("answer-not-expected");
    const wire = PlanCreationPendingCheckSchema.parse({
      schemaVersion: 1,
      checkId: input.newId(),
      commandId: command.commandId,
      sourceVersion: snapshot.version,
      attempt: action?.action === "retry" ? (existing?.attempt ?? 0) + 1 : 1,
      submission,
      state: "busy",
    });
    const stored: PlanningPendingCheck = {
      owner,
      checkId: wire.checkId,
      commandId: wire.commandId,
      attempt: wire.attempt,
      state: "busy",
      submissionJson: canonicalJson(submission),
      checkJson: canonicalJson(wire),
    };
    const admission = await repository.admit({
      command,
      check: stored,
      ...(existing === null ? {} : { replacesCheckId: existing.checkId }),
    });
    if (admission.status === "replayed") return parse(admission.resultJson);
    if (admission.status === "pending") return rejected("invalid-answer");
    onEvent?.({
      type: "answer-check",
      planCreation: await input.project(withCheck(snapshot, stored)),
    });
    let completed: PlanCreationPendingCheck;
    try {
      const context = {
        field: submission.field,
        candidates: [],
        events: [],
        today: input.today(),
        language: await input.language(submission.text),
        expectations:
          submission.field === "commitments"
            ? "Extract all supported weekday or exact-date training limits. At most 20 rules. Ask when dates, weekdays, or durations needed for a rule are missing. Never guess. Skip only when the athlete wants no new limits."
            : submission.field === "success"
              ? "Check a useful training success statement. Ask about irrelevant or unusable text. Skip only when the athlete wants the neutral default."
              : `Check the event name and supplied date ${submission.date}. Preserve that date. Ask when the name does not identify an event. Never skip an event.`,
      };
      const result =
        submission.field === "commitments"
          ? await input.translator.translateIntent(
              submission.text,
              CommitmentCheckResultSchema,
              context,
            )
          : submission.field === "success"
            ? await input.translator.translateIntent(
                submission.text,
                SuccessCheckResultSchema,
                context,
              )
            : await input.translator.translateIntent(
                submission.text,
                EventCheckResultSchema,
                context,
              );
      if (submission.field === "commitments") validateCommitmentInterpretation(result);
      if (submission.field === "event") {
        const event = EventCheckResultSchema.parse(result);
        if (event.outcome === "understood" && event.value.date !== submission.date)
          throw new Error("Event date changed during checking");
      }
      completed = PlanCreationPendingCheckSchema.parse({ ...wire, state: "ready", result });
    } catch {
      completed = PlanCreationPendingCheckSchema.parse({
        ...wire,
        state: "error",
        message: "I could not check that answer. Try again.",
      });
    }
    const settled = { ...stored, state: completed.state, checkJson: canonicalJson(completed) };
    const current = await creations.readUnfinished();
    const stale = canonicalJson({
      status: "rejected",
      reason: "stale-version",
      planCreation: null,
    });
    const result = await repository.settle({
      command,
      check: settled,
      resultJson: canonicalJson(await response(withCheck(snapshot, settled))),
      staleResultJson:
        current === undefined
          ? stale
          : canonicalJson({
              status: "rejected",
              reason: "stale-version",
              planCreation: await input.project(withCheck(current, null)),
            }),
    });
    return parse(result.resultJson);
  };

  return {
    ready,
    async handle(
      request: PlanCreationAnswerRpcParams,
      onEvent?: (event: PlanCreationCheckProgress) => void,
    ): Promise<PlanCreationAnswerRpcResult | null> {
      await ready();
      if (
        typedCreationSubmission(request.answer) === null &&
        request.answer.kind !== "check-action"
      )
        return null;
      const digest = await input.digest(request);
      const active = running.get(request.commandId);
      if (active !== undefined)
        return active.digest === digest ? active.result : rejected("command-conflict");
      const result = run(request, digest, onEvent).catch((error: unknown) => {
        if (error instanceof PlanCreationStoreError)
          return rejected(
            error.code === "command-conflict"
              ? "command-conflict"
              : error.code === "stale-version"
                ? "stale-version"
                : "invalid-answer",
          );
        throw error;
      });
      running.set(request.commandId, { digest, result });
      try {
        return await result;
      } finally {
        running.delete(request.commandId);
      }
    },
  };
}
