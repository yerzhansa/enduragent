import {
  PLAN_CREATION_ANSWER_KEYS,
  type PlanCreationAnswerSummary,
} from "@enduragent/coach-contract";

const PLAN_CREATION_PAUSE_STORAGE_KEY = "enduragent.plan-creation.pause";

interface PlanCreationPauseIdentity {
  readonly creationId: string;
  readonly answerKey: PlanCreationAnswerSummary["answerKey"];
}

function pauseStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch (error) {
    if (!(error instanceof DOMException)) throw error;
    return undefined;
  }
}

export function readPlanCreationPause(): PlanCreationPauseIdentity | null {
  try {
    const value = pauseStorage()?.getItem(PLAN_CREATION_PAUSE_STORAGE_KEY);
    if (value === undefined || value === null) return null;
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      typeof parsed.creationId !== "string" ||
      typeof parsed.answerKey !== "string" ||
      !(PLAN_CREATION_ANSWER_KEYS as readonly string[]).includes(parsed.answerKey)
    ) {
      return null;
    }
    return {
      creationId: parsed.creationId,
      answerKey: parsed.answerKey as PlanCreationAnswerSummary["answerKey"],
    };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return null;
  }
}

function isPlanPauseStorageFailure(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "QuotaExceededError" ||
      error.name === "SecurityError" ||
      error.name === "NotAllowedError")
  );
}

export function writePlanCreationPause(identity: PlanCreationPauseIdentity): void {
  try {
    pauseStorage()?.setItem(PLAN_CREATION_PAUSE_STORAGE_KEY, JSON.stringify(identity));
  } catch (error) {
    if (!isPlanPauseStorageFailure(error)) throw error;
  }
}

export function clearPlanCreationPause(): void {
  try {
    pauseStorage()?.removeItem(PLAN_CREATION_PAUSE_STORAGE_KEY);
  } catch (error) {
    if (!isPlanPauseStorageFailure(error)) throw error;
  }
}
