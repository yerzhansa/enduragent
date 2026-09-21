import type { ModelMessage } from "ai";
import { z } from "zod";
import type { GenerateResult, LanguageModelPort } from "../sport.js";
import type { TurnBudget } from "./turn-budget.js";

const assessmentSchema = z.enum(["requires_preparation", "no_preparation_required"]);

const ASSESSMENT_SYSTEM_PROMPT = `You are checking whether a coaching reply left a calendar-workout request unfinished.

Host fact: preparation_receipt=none. The host did not receive a successful workout proposal from this reply.

Return exactly one enum value and no other text:
- requires_preparation
- no_preparation_required

Return requires_preparation when the athlete asked to add, edit, delete, or revise calendar workouts and the candidate reply either claims that the review is ready or applied, promises future preparation, or otherwise leaves the actionable request unfulfilled.

Return no_preparation_required for coaching advice, a genuine clarifying question needed before proposing changes, or a refusal. Judge the full conversation, so a contextual request such as "yes, do that" can require preparation.`;

const CORRECTION_PROMPT = `Host correction: no workout proposal was submitted. Prepare the complete requested workout set now with the workout preparation tool. Do not claim that a review is ready unless the tool succeeds. If the athlete is revising a pending proposal, read the canonical pending proposal first.`;

const ASSESSMENT_REQUEST =
  "Classify the candidate assistant reply immediately above. Return only the required enum value.";

export type WorkoutPreparationAssessment =
  | { readonly kind: "requires_preparation" }
  | { readonly kind: "no_preparation_required" }
  | {
      readonly kind: "assessment_failed";
      readonly reason: "provider_failure" | "invalid_response";
    };

export async function assessWorkoutPreparation(input: {
  readonly llm: LanguageModelPort;
  readonly messages: readonly ModelMessage[];
  readonly candidate: string;
  readonly budget: Pick<TurnBudget, "chargeGenerateCall" | "remainingMs">;
  readonly signal: AbortSignal;
  readonly cacheKey: string;
}): Promise<WorkoutPreparationAssessment> {
  input.budget.chargeGenerateCall();
  let result: GenerateResult;
  try {
    result = await input.llm.generate({
      system: ASSESSMENT_SYSTEM_PROMPT,
      messages: [
        ...input.messages,
        { role: "assistant", content: input.candidate },
        { role: "user", content: ASSESSMENT_REQUEST },
      ],
      maxOutputTokens: 256,
      caller: "chat",
      cacheKey: input.cacheKey,
      deadlineMs: input.budget.remainingMs(),
      signal: input.signal,
    });
  } catch (error) {
    if (input.signal.aborted) throw error;
    return { kind: "assessment_failed", reason: "provider_failure" };
  }
  if (result.finishReason !== "stop") {
    return { kind: "assessment_failed", reason: "invalid_response" };
  }
  const parsed = assessmentSchema.safeParse(result.text.trim());
  return parsed.success
    ? { kind: parsed.data }
    : { kind: "assessment_failed", reason: "invalid_response" };
}

export function workoutPreparationCorrectionMessages(
  messages: readonly ModelMessage[],
  candidate: string,
): ModelMessage[] {
  return [
    ...messages,
    { role: "assistant", content: candidate },
    { role: "system", content: CORRECTION_PROMPT },
  ];
}
