import {
  PlanCreationAnswerInputSchema,
  PlanCreationAnswerRpcParamsSchema,
  PlanCreationAnswerRpcResultSchema,
  PlanCreationCardModelSchema,
  PlanCreationStartRpcParamsSchema,
  PlanCreationStartRpcResultSchema,
  type PlanCreationAnswerInput,
  type PlanCreationCardModel,
  type PlanCreationGoal,
  type PlanCreationOperations,
} from "@enduragent/coach-contract";
import { canonicalJson } from "@enduragent/kernel/archive";
import {
  PlanCreationStoreError,
  type PlanCreationRepository,
  type PlanCreationSnapshot,
} from "@enduragent/kernel/planning";
import type { AuthoredIdentity } from "@enduragent/kernel-node/home";

export interface GoalEventCandidateSource {
  read(): Promise<readonly { name: string; date: string; sourceLabel: string }[]>;
}

function answersByKind(snapshot: PlanCreationSnapshot): Map<string, PlanCreationAnswerInput> {
  const answers = new Map<string, PlanCreationAnswerInput>();
  for (const record of snapshot.answers) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(record.valueJson) as unknown;
    } catch {
      throw new PlanCreationStoreError("corrupt-record");
    }
    const result = PlanCreationAnswerInputSchema.safeParse(parsed);
    if (!result.success || result.data.kind !== record.answerKey) {
      throw new PlanCreationStoreError("corrupt-record");
    }
    answers.set(result.data.kind, result.data);
  }
  return answers;
}

export function expectedPlanCreationAnswerKind(
  snapshot: PlanCreationSnapshot,
): "goal" | "success" | null {
  const answers = answersByKind(snapshot);
  if (!answers.has("goal")) return "goal";
  if (!answers.has("success")) return "success";
  return null;
}

function requireGoal(answers: Map<string, PlanCreationAnswerInput>): PlanCreationGoal {
  const answer = answers.get("goal");
  if (answer?.kind !== "goal") throw new PlanCreationStoreError("corrupt-record");
  return answer.goal;
}

function goalDetail(snapshot: PlanCreationSnapshot, goal: PlanCreationGoal): string {
  if (goal.kind === "fitness") return goal.outcome;
  if (goal.kind === "event-manual") return `${goal.name} · ${goal.date}`;
  const candidate = snapshot.seed?.eventCandidates.find(
    (item) => item.candidateId === goal.candidateId,
  );
  if (candidate === undefined) throw new PlanCreationStoreError("corrupt-record");
  return `${candidate.name} · ${candidate.date} · ${candidate.sourceLabel}`;
}

function successDetail(answer: PlanCreationAnswerInput): string {
  if (answer.kind !== "success") throw new PlanCreationStoreError("corrupt-record");
  if (answer.success.kind === "authored") return answer.success.text;
  if (answer.success.choice === "finish-comfortably") return "Finish comfortably";
  if (answer.success.choice === "finish-fast") return "Finish fast";
  return "Race for a result";
}

export function projectPlanCreationCard(snapshot: PlanCreationSnapshot): PlanCreationCardModel {
  if (snapshot.status !== "in-progress") throw new PlanCreationStoreError("corrupt-record");
  const answers = answersByKind(snapshot);
  const goalAnswer = answers.get("goal");
  const successAnswer = answers.get("success");
  const answeredSummaries = [];
  if (goalAnswer?.kind === "goal") {
    answeredSummaries.push({
      answerKey: "goal" as const,
      title: "Goal",
      detail: goalDetail(snapshot, goalAnswer.goal),
    });
  }
  if (successAnswer !== undefined) {
    answeredSummaries.push({
      answerKey: "success" as const,
      title: "Success",
      detail: successDetail(successAnswer),
    });
  }
  const expected = expectedPlanCreationAnswerKind(snapshot);
  const openQuestion =
    expected === "goal"
      ? {
          kind: "goal-question" as const,
          prompt: "What do you want this Plan to prepare you for?",
          candidates: snapshot.seed?.eventCandidates ?? [],
        }
      : expected === "success"
        ? requireGoal(answers).kind === "fitness"
          ? {
              kind: "success-question" as const,
              prompt: "What would success mean for this Fitness Goal?",
              input: {
                kind: "authored" as const,
                placeholder: "Describe what success would look like",
              },
            }
          : {
              kind: "success-question" as const,
              prompt: "What would success mean for this Event Goal?",
              input: {
                kind: "event-finish" as const,
                options: [
                  { choice: "finish-comfortably" as const, label: "Finish comfortably" },
                  { choice: "finish-fast" as const, label: "Finish fast" },
                  { choice: "race-for-result" as const, label: "Race for a result" },
                ],
              },
            }
        : null;
  return PlanCreationCardModelSchema.parse({
    creationId: snapshot.id,
    version: snapshot.version,
    status: "in-progress",
    answeredSummaries,
    openQuestion,
  });
}

export interface PlanCreationHost extends PlanCreationOperations {
  readCard(): Promise<PlanCreationCardModel | null>;
  hasOpenQuestion(): Promise<boolean>;
}

function validAnswer(snapshot: PlanCreationSnapshot, answer: PlanCreationAnswerInput): boolean {
  if (answer.kind === "goal") {
    const candidateId = answer.goal.kind === "event-candidate" ? answer.goal.candidateId : null;
    return (
      candidateId === null ||
      snapshot.seed?.eventCandidates.some((candidate) => candidate.candidateId === candidateId) ===
        true
    );
  }
  const goal = requireGoal(answersByKind(snapshot));
  return goal.kind === "fitness"
    ? answer.success.kind === "authored"
    : answer.success.kind === "event-finish";
}

async function requestDigest(crypto: Crypto, request: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(request)),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createPlanCreationOperations(input: {
  repository: PlanCreationRepository;
  identity: AuthoredIdentity;
  crypto: Crypto;
  eventCandidates: GoalEventCandidateSource;
}): PlanCreationHost {
  const stamp = async (commandId: string, digest: string) => {
    const clock = input.identity.hlcStamp();
    return {
      commandId,
      requestDigest: digest,
      nowMs: clock.physicalMs,
      deviceId: await input.identity.deviceId(),
      hlcPhysicalMs: clock.physicalMs,
      hlcCounter: clock.counter,
    };
  };
  const readCard = async (): Promise<PlanCreationCardModel | null> => {
    const snapshot = await input.repository.readUnfinished();
    return snapshot === undefined ? null : projectPlanCreationCard(snapshot);
  };
  return {
    async "plan_creation.start"(request) {
      const parsed = PlanCreationStartRpcParamsSchema.parse(request);
      const current = await input.repository.readUnfinished();
      const candidates =
        current === undefined
          ? (await input.eventCandidates.read()).slice(0, 10).map((candidate) => ({
              candidateId: input.identity.newUlid(),
              ...candidate,
            }))
          : [];
      try {
        const result = await input.repository.start({
          command: await stamp(parsed.commandId, await requestDigest(input.crypto, parsed)),
          creationId: current?.id ?? input.identity.newUlid(),
          seed: { schemaVersion: 1, eventCandidates: candidates },
        });
        return PlanCreationStartRpcResultSchema.parse({
          status: "started",
          outcome: result.outcome === "created" ? "created" : "resumed",
          planCreation: projectPlanCreationCard(result.snapshot),
        });
      } catch (error) {
        if (error instanceof PlanCreationStoreError && error.code === "command-conflict") {
          return PlanCreationStartRpcResultSchema.parse({
            status: "rejected",
            reason: "command-conflict",
          });
        }
        throw error;
      }
    },
    async "plan_creation.answer"(request) {
      const parsed = PlanCreationAnswerRpcParamsSchema.parse(request);
      const snapshot = await input.repository.readUnfinished();
      if (snapshot === undefined || snapshot.id !== parsed.creationId) {
        return PlanCreationAnswerRpcResultSchema.parse({
          status: "rejected",
          reason: "no-unfinished-creation",
          planCreation: snapshot === undefined ? null : projectPlanCreationCard(snapshot),
        });
      }
      const digest = await requestDigest(input.crypto, parsed);
      const stampValue = await stamp(parsed.commandId, digest);
      const answerId = input.identity.newUlid();
      const record = () =>
        input.repository.recordAnswer({
          command: stampValue,
          creationId: parsed.creationId,
          expectedVersion: parsed.expectedVersion,
          answerId,
          answerKey: parsed.answer.kind,
          valueJson: canonicalJson(parsed.answer),
        });
      if (
        snapshot.version === parsed.expectedVersion &&
        expectedPlanCreationAnswerKind(snapshot) !== parsed.answer.kind
      ) {
        return PlanCreationAnswerRpcResultSchema.parse({
          status: "rejected",
          reason: "answer-not-expected",
          planCreation: projectPlanCreationCard(snapshot),
        });
      }
      if (snapshot.version === parsed.expectedVersion && !validAnswer(snapshot, parsed.answer)) {
        return PlanCreationAnswerRpcResultSchema.parse({
          status: "rejected",
          reason: "invalid-answer",
          planCreation: projectPlanCreationCard(snapshot),
        });
      }
      try {
        const result = await record();
        return PlanCreationAnswerRpcResultSchema.parse({
          status: "answered",
          planCreation: projectPlanCreationCard(result.snapshot),
        });
      } catch (error) {
        if (
          error instanceof PlanCreationStoreError &&
          ["stale-version", "command-conflict", "missing-creation"].includes(error.code)
        ) {
          const planCreation = await readCard();
          return PlanCreationAnswerRpcResultSchema.parse({
            status: "rejected",
            reason: error.code === "missing-creation" ? "no-unfinished-creation" : error.code,
            planCreation,
          });
        }
        throw error;
      }
    },
    readCard,
    async hasOpenQuestion() {
      const snapshot = await input.repository.readUnfinished();
      if (snapshot === undefined || snapshot.status !== "in-progress") return false;
      const answerKeys = new Set(snapshot.answers.map((answer) => answer.answerKey));
      return !answerKeys.has("goal") || !answerKeys.has("success");
    },
  };
}
