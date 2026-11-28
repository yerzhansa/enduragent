import { z } from "zod";
import { TrainingExportCivilDateSchema } from "./training-export.js";

const PercentSchema = z.number().int().min(1).max(200);

const PlanWorkoutTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("steady"), percent: PercentSchema }).strict(),
  z
    .object({ kind: z.literal("range"), low: PercentSchema, high: PercentSchema })
    .strict()
    .refine((target) => target.low < target.high, { message: "range low must be below high" }),
  z.object({ kind: z.literal("ramp"), from: PercentSchema, to: PercentSchema }).strict(),
]);
export type PlanWorkoutTarget = z.infer<typeof PlanWorkoutTargetSchema>;

const PlanWorkoutStepSchema = z
  .object({
    part: z.enum(["warm-up", "main", "interval", "recovery", "cool-down"]),
    seconds: z.number().int().min(10).max(86_400),
    target: PlanWorkoutTargetSchema,
  })
  .strict();
export type PlanWorkoutStep = z.infer<typeof PlanWorkoutStepSchema>;

const PlanWorkoutBlockSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("step"), step: PlanWorkoutStepSchema }).strict(),
  z
    .object({
      kind: z.literal("repeat"),
      times: z.number().int().min(2).max(20),
      steps: z.tuple([PlanWorkoutStepSchema, PlanWorkoutStepSchema]),
    })
    .strict(),
]);
export type PlanWorkoutBlock = z.infer<typeof PlanWorkoutBlockSchema>;

export const PlanWorkoutContentSchema = z
  .object({
    version: z.literal(1),
    zone: z.enum(["recovery", "endurance", "sweet-spot"]),
    load: z.number().int().min(0).max(2_000),
    why: z.enum(["recover", "aerobic-base", "endurance", "sustained-power"]),
    blocks: z.array(PlanWorkoutBlockSchema).min(1).max(40),
  })
  .strict();
export type PlanWorkoutContent = z.infer<typeof PlanWorkoutContentSchema>;

export function planWorkoutContentSeconds(content: PlanWorkoutContent): number {
  return content.blocks.reduce(
    (sum, block) =>
      sum +
      (block.kind === "step"
        ? block.step.seconds
        : block.times * (block.steps[0].seconds + block.steps[1].seconds)),
    0,
  );
}

export const PlanCreationDraftWorkoutSchema = z
  .object({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(512),
    kind: z.enum(["hard", "endurance", "long", "easy", "event"]),
    date: TrainingExportCivilDateSchema.nullable(),
    minutes: z.number().positive().max(1440),
    pinned: z.boolean(),
    guidance: z.string().min(1).max(512),
    supportingEventId: z.string().min(1).max(128).optional(),
    power: z.number().int().min(1).max(9_999).nullable(),
    content: PlanWorkoutContentSchema.optional(),
  })
  .strict()
  .superRefine((workout, context) => {
    if (workout.content === undefined) return;
    if (workout.kind === "event") {
      context.addIssue({ code: "custom", path: ["content"], message: "event has no content" });
    } else if (planWorkoutContentSeconds(workout.content) !== workout.minutes * 60) {
      context.addIssue({ code: "custom", path: ["content"], message: "steps must fill minutes" });
    }
  });
export type PlanCreationDraftWorkout = z.infer<typeof PlanCreationDraftWorkoutSchema>;
