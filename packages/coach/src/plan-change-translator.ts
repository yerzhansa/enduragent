import { PlanChangeIntentSchema, type PlanChangeIntent } from "@enduragent/coach-contract";
import type { IntentTranslationPort } from "@enduragent/engine";
import { interpretCommitments } from "@enduragent/sport-cycling";
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
}

export type ChangeTranslation =
  | { status: "translated"; intent: PlanChangeIntent }
  | { status: "unsupported" }
  | { status: "combined" }
  | { status: "no-eligible-workout" };

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
  return z.discriminatedUnion("status", [
    z.object({ status: z.literal("translated"), intent }).strict(),
    z.object({ status: z.literal("unsupported") }).strict(),
    z.object({ status: z.literal("combined") }).strict(),
  ]);
}

function matchChange(text: string, context: ChangeTranslationContext): ChangeTranslation | null {
  const normalized = text
    .trim()
    .replace(/[.!?]+$/u, "")
    .replace(/\s+/gu, " ")
    .toLowerCase();
  if (normalized === "what should i ride today") {
    const first = context.eligibleWorkouts[0];
    return first === undefined
      ? { status: "no-eligible-workout" }
      : { status: "translated", intent: { kind: "choose-workout", workoutId: first.workoutId } };
  }
  const interpreted = interpretCommitments(
    normalized.replace(/^no hard training on /u, "no hard on "),
  );
  if (interpreted.status === "confirm") {
    if (interpreted.rules.length > 1) return { status: "combined" };
    const rule = interpreted.rules[0];
    if (rule !== undefined && rule.kind !== "time-off") {
      const parsed = PlanChangeIntentSchema.safeParse(rule);
      return parsed.success
        ? { status: "translated", intent: parsed.data }
        : { status: "unsupported" };
    }
  }
  const weekly = /^at most (\d+(?:\.\d+)?) hours each week$/u.exec(normalized);
  const longest = /^long rides at most (\d+) minutes$/u.exec(normalized);
  const ftp = /^my ftp is (\d+)$/u.exec(normalized);
  const parsed = PlanChangeIntentSchema.safeParse(
    weekly
      ? { kind: "weekly-duration", hours: Number(weekly[1]) }
      : longest
        ? { kind: "longest-workout", minutes: Number(longest[1]) }
        : ftp
          ? { kind: "ftp", watts: Number(ftp[1]) }
          : null,
  );
  return parsed.success ? { status: "translated", intent: parsed.data } : null;
}

export async function translateChangeRequest(
  text: string,
  context: ChangeTranslationContext,
): Promise<ChangeTranslation> {
  const fragments = text
    .split(/\s+(?:and\s+then|and|then)\s+|[,;\n]+|[.!?](?=\s|$)/iu)
    .map((part) => part.trim())
    .filter(Boolean);
  if (
    fragments.length > 1 &&
    fragments.filter((part) => matchChange(part, context) !== null).length > 1
  )
    return { status: "combined" };
  const matched = matchChange(text, context);
  if (matched?.status === "no-eligible-workout") return matched;
  if (matched !== null) {
    return matched.status !== "translated" ||
      (matched.intent.kind !== "inverse" && context.allowedKinds.includes(matched.intent.kind))
      ? matched
      : { status: "unsupported" };
  }
  if (context.translator === undefined) return { status: "unsupported" };
  try {
    const schema = changeTranslationSchema(context);
    const references = translationReferences(context);
    const result = schema.safeParse(
      await context.translator.translateIntent(text, schema, references),
    );
    if (!result.success) return { status: "unsupported" };
    if (result.data.status !== "translated") return result.data;
    const intent = result.data.intent;
    if (intent.kind === "choose-workout") {
      const index = references.candidates.findIndex((token) => token === intent.workoutId);
      const workout = context.eligibleWorkouts[index];
      return workout === undefined
        ? { status: "unsupported" }
        : { status: "translated", intent: { ...intent, workoutId: workout.workoutId } };
    }
    if (intent.kind === "supporting-event" && intent.operation !== "add") {
      const index = references.events.findIndex((token) => token === intent.eventId);
      const event = context.supportingEvents[index];
      return event === undefined
        ? { status: "unsupported" }
        : { status: "translated", intent: { ...intent, eventId: event.id } };
    }
    return { status: "translated", intent };
  } catch {
    return { status: "unsupported" };
  }
}
