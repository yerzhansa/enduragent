import {
  PLAN_CREATION_ANSWER_KEYS,
  PlanCreationAnswerSchema,
  type PlanCreationAnswer,
} from "@enduragent/coach-contract";
import { canonicalJson } from "@enduragent/kernel/archive";
import {
  PlanCreationStoreError,
  type PlanCreationAnswerRecord,
  type PlanCreationSnapshot,
} from "@enduragent/kernel/planning";
import { startsAfterEvent } from "./plan-creation-start.js";

export type PlanCreationAnswerKey = (typeof PLAN_CREATION_ANSWER_KEYS)[number];

export type PlanCreationAnswerSource =
  | { readonly kind: "athlete" }
  | { readonly kind: "derived"; readonly label: string };

export interface StoredPlanCreationAnswer {
  readonly answer: PlanCreationAnswer;
  readonly source: PlanCreationAnswerSource;
  readonly record: PlanCreationAnswerRecord;
}

export interface PlanCreationAnswerFlow {
  readonly order: readonly PlanCreationAnswerKey[];
  readonly latest: ReadonlyMap<PlanCreationAnswerKey, StoredPlanCreationAnswer>;
  readonly valid: ReadonlyMap<PlanCreationAnswerKey, StoredPlanCreationAnswer>;
  readonly next: PlanCreationAnswerKey | null;
}

export const corrupt = (): never => {
  throw new PlanCreationStoreError("corrupt-record");
};

const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : corrupt();

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const isAnswerKey = (value: string): value is PlanCreationAnswerKey =>
  (PLAN_CREATION_ANSWER_KEYS as readonly string[]).includes(value);

const parseSource = (value: unknown): PlanCreationAnswerSource => {
  const candidate = object(value);
  if (candidate.kind === "athlete" && hasExactKeys(candidate, ["kind"])) {
    return { kind: "athlete" };
  }
  if (
    candidate.kind === "derived" &&
    typeof candidate.label === "string" &&
    hasExactKeys(candidate, ["kind", "label"])
  ) {
    return { kind: "derived", label: candidate.label };
  }
  return corrupt();
};

const parseStoredAnswer = (record: PlanCreationAnswerRecord): StoredPlanCreationAnswer => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(record.valueJson) as unknown;
  } catch {
    return corrupt();
  }
  const stored = object(decoded);
  if (!isAnswerKey(record.answerKey)) return corrupt();
  if (hasExactKeys(stored, ["answer", "source"])) {
    const answer = PlanCreationAnswerSchema.safeParse(stored.answer);
    if (!answer.success || answer.data.kind !== record.answerKey) return corrupt();
    return { answer: answer.data, source: parseSource(stored.source), record };
  }
  const legacyAnswer = PlanCreationAnswerSchema.safeParse(stored);
  if (!legacyAnswer.success || legacyAnswer.data.kind !== record.answerKey) return corrupt();
  return { answer: legacyAnswer.data, source: { kind: "athlete" }, record };
};

export const encodePlanCreationAnswer = (
  answer: PlanCreationAnswer,
  source: PlanCreationAnswerSource,
): string => canonicalJson({ answer, source });

export const readPlanCreationAnswers = (
  snapshot: PlanCreationSnapshot,
): readonly StoredPlanCreationAnswer[] => snapshot.answers.map(parseStoredAnswer);

type PlanCreationGoalFamily = "event" | "fitness";

const goalFamily = (
  answer: Extract<PlanCreationAnswer, { kind: "goal" }>,
): PlanCreationGoalFamily => (answer.goal.kind === "fitness" ? "fitness" : "event");

const currentGoalRunStart = (
  answers: readonly StoredPlanCreationAnswer[],
): { readonly family: PlanCreationGoalFamily; readonly sequence: number } | undefined => {
  const goals = answers.filter(
    (
      stored,
    ): stored is StoredPlanCreationAnswer & {
      readonly answer: Extract<PlanCreationAnswer, { kind: "goal" }>;
    } => stored.answer.kind === "goal",
  );
  const current = goals.at(-1);
  if (current === undefined) return undefined;
  const family = goalFamily(current.answer);
  let sequence = current.record.sequence;
  for (let index = goals.length - 2; index >= 0; index -= 1) {
    const prior = goals[index];
    if (prior === undefined || goalFamily(prior.answer) !== family) break;
    sequence = prior.record.sequence;
  }
  return { family, sequence };
};

const currentScheduleModeRunStart = (
  answers: readonly StoredPlanCreationAnswer[],
): { readonly mode: "fixed" | "flexible"; readonly sequence: number } | undefined => {
  const modes = answers.filter(
    (
      stored,
    ): stored is StoredPlanCreationAnswer & {
      readonly answer: Extract<PlanCreationAnswer, { kind: "schedule-mode" }>;
    } => stored.answer.kind === "schedule-mode",
  );
  const current = modes.at(-1);
  if (current === undefined) return undefined;
  const mode = current.answer.mode;
  let sequence = current.record.sequence;
  for (let index = modes.length - 2; index >= 0; index -= 1) {
    const prior = modes[index];
    if (prior === undefined || prior.answer.mode !== mode) break;
    sequence = prior.record.sequence;
  }
  return { mode, sequence };
};

export function resolvePlanCreationAnswerFlow(
  snapshot: PlanCreationSnapshot,
): PlanCreationAnswerFlow {
  const answers = readPlanCreationAnswers(snapshot);
  const latest = new Map<PlanCreationAnswerKey, StoredPlanCreationAnswer>();
  for (const stored of answers) latest.set(stored.answer.kind, stored);
  const goalRun = currentGoalRunStart(answers);
  const scheduleModeRun = currentScheduleModeRunStart(answers);
  const order: readonly PlanCreationAnswerKey[] =
    goalRun?.family === "fitness"
      ? [
          "goal",
          "plan-length",
          "schedule-mode",
          "availability",
          "start-timing",
          "commitments",
          "baseline",
          "success",
          "restriction",
        ]
      : goalRun !== undefined
        ? [
            "goal",
            "schedule-mode",
            "availability",
            "start-timing",
            "commitments",
            "baseline",
            "success",
            "restriction",
          ]
        : ["goal"];
  const valid = new Map<PlanCreationAnswerKey, StoredPlanCreationAnswer>();
  for (const key of order) {
    const stored = latest.get(key);
    if (stored === undefined) continue;
    if (key === "success") {
      const matchesGoal =
        goalRun?.family === "fitness"
          ? stored.answer.kind === "success" &&
            (stored.answer.success.kind === "fitness-choice" ||
              stored.answer.success.kind === "authored")
          : goalRun !== undefined
            ? stored.answer.kind === "success" &&
              (stored.answer.success.kind === "event-finish" ||
                stored.answer.success.kind === "authored")
            : false;
      if (!matchesGoal || goalRun === undefined || stored.record.sequence <= goalRun.sequence) {
        continue;
      }
    }
    if (
      key === "plan-length" &&
      (goalRun?.family !== "fitness" || stored.record.sequence <= goalRun.sequence)
    )
      continue;
    if (key === "start-timing" && startsAfterEvent(stored, valid, snapshot.seed)) continue;
    if (key === "availability") {
      if (
        stored.answer.kind !== "availability" ||
        scheduleModeRun === undefined ||
        stored.answer.mode !== scheduleModeRun.mode ||
        stored.record.sequence <= scheduleModeRun.sequence
      ) {
        continue;
      }
    }
    valid.set(key, stored);
  }
  return { order, latest, valid, next: order.find((key) => !valid.has(key)) ?? null };
}
