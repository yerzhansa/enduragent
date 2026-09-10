import {
  answerCheckResultSchema,
  PlanChangeCheckResultSchema,
  PlanChangeIntentSchema,
  type PlanChangeIntent,
} from "@enduragent/coach-contract";
import type { IntentTranslationPort } from "@enduragent/engine";
import { z } from "zod";

export const supportedChangeKinds = [
  "weekday-duration",
  "weekday-unavailable",
  "hard-weekday",
  "weekly-duration",
  "longest-workout",
  "ftp",
  "supporting-event",
  "choose-workout",
] satisfies Exclude<PlanChangeIntent["kind"], "inverse">[];

export interface ChangeTranslationContext {
  allowedKinds: readonly Exclude<PlanChangeIntent["kind"], "inverse">[];
  eligibleWorkouts: readonly { workoutId: string }[];
  supportingEvents: readonly { id: string }[];
  translator?: IntentTranslationPort;
  today: string;
  language?: string;
}

export type ChangeTranslation = z.infer<typeof PlanChangeCheckResultSchema>;

function translationReferences(
  context: ChangeTranslationContext,
): Parameters<IntentTranslationPort["translateIntent"]>[2] {
  return {
    candidates: context.allowedKinds.includes("choose-workout")
      ? context.eligibleWorkouts.map((_, index): `candidate-${number}` => `candidate-${index + 1}`)
      : [],
    events: context.allowedKinds.includes("supporting-event")
      ? context.supportingEvents.map((_, index): `event-${number}` => `event-${index + 1}`)
      : [],
  };
}

export function changeTranslationSchema(context: ChangeTranslationContext) {
  const references = translationReferences(context);
  const options = PlanChangeIntentSchema.options.flatMap(
    (option): z.ZodType<PlanChangeIntent>[] => {
      if (option instanceof z.ZodDiscriminatedUnion) {
        if (!context.allowedKinds.includes("supporting-event")) return [];
        return option.options.flatMap((operation): z.ZodType<PlanChangeIntent>[] => {
          if (operation.shape.operation.value === "add") return [operation];
          return references.events.length === 0
            ? []
            : [operation.extend({ eventId: z.enum(references.events) })];
        });
      }
      const kind = option.shape.kind.value;
      return kind !== "inverse" && kind !== "choose-workout" && context.allowedKinds.includes(kind)
        ? [option]
        : [];
    },
  );
  const intent = z.union([
    ...options,
    ...(context.allowedKinds.includes("choose-workout") && context.eligibleWorkouts.length > 0
      ? [
          z
            .object({
              kind: z.literal("choose-workout"),
              workoutId: z.enum(references.candidates),
            })
            .strict(),
        ]
      : []),
    z.never(),
  ]);
  return answerCheckResultSchema(intent);
}

export async function translateChangeRequest(
  text: string,
  context: ChangeTranslationContext,
): Promise<ChangeTranslation | null> {
  if (context.translator === undefined) return null;
  try {
    const schema = changeTranslationSchema(context);
    const references = translationReferences(context);
    const result = schema.safeParse(
      await context.translator.translateIntent(text, schema, {
        ...references,
        field: "change",
        today: context.today,
        ...(context.language === undefined ? {} : { language: context.language }),
        expectations:
          "Check one supported Plan change. Ask when the request is unclear, unsupported, or contains multiple changes. Skip when the athlete wants to cancel the request. Return understood only with one complete allowed intent. Do not guess missing amounts or dates. Choose only eligible candidate and event tokens supplied by the host.",
      }),
    );
    if (!result.success) return null;
    if (result.data.outcome !== "understood") return result.data;
    const intent = result.data.value;
    if (intent.kind === "choose-workout") {
      const index = references.candidates.findIndex((token) => token === intent.workoutId);
      const workout = context.eligibleWorkouts[index];
      return workout === undefined
        ? null
        : { ...result.data, value: { ...intent, workoutId: workout.workoutId } };
    }
    if (intent.kind === "supporting-event" && intent.operation !== "add") {
      const index = references.events.findIndex((token) => token === intent.eventId);
      const event = context.supportingEvents[index];
      return event === undefined
        ? null
        : { ...result.data, value: { ...intent, eventId: event.id } };
    }
    return result.data;
  } catch {
    return null;
  }
}
