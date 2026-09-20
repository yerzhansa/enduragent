import { describeLanguage, normalizeLocaleHint } from "@enduragent/i18n";
import { createPhrasebook, type Phrasebook } from "@enduragent/i18n/messages";
import { WorkoutChangeError, type WorkoutProblemReason } from "./error.js";

export function workoutPhrasebook(language: string): Promise<Phrasebook> {
  const tag = normalizeLocaleHint(language) ?? "en";
  return createPhrasebook({ tag, locale: describeLanguage(tag).defaultLocale });
}

export function workoutProblemKind(error: unknown): WorkoutProblemReason {
  return error instanceof WorkoutChangeError ? error.reason : "cannotVerify";
}

export function workoutProblem(error: unknown, book: Phrasebook): string {
  return book.say(`workouts.outcome.${workoutProblemKind(error)}`);
}
