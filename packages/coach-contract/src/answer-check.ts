import { z } from "zod";

export const AnswerCheckTextSchema = z.string().trim().min(1).max(2_000);
export const AnswerCheckActionSchema = z
  .object({
    kind: z.literal("check-action"),
    checkId: z.string().min(1).max(128),
    action: z.enum(["confirm", "retry", "cancel", "skip"]),
  })
  .strict();
export type AnswerCheckAction = z.infer<typeof AnswerCheckActionSchema>;

export function answerCheckResultSchema<T extends z.ZodType>(value: T) {
  const prose = {
    title: z.string().trim().min(1).max(160),
    body: z
      .string()
      .trim()
      .min(1)
      .max(2_000)
      .refine((body) => !body.includes("\n") && !body.includes("\r")),
  };
  return z.discriminatedUnion("outcome", [
    z.object({ ...prose, outcome: z.literal("understood"), value }).strict(),
    z.object({ ...prose, outcome: z.literal("ask"), value: z.null() }).strict(),
    z.object({ ...prose, outcome: z.literal("skip"), value: z.null() }).strict(),
  ]);
}

export function pendingAnswerCheckSchema<S extends z.ZodType, R extends z.ZodType>(
  submission: S,
  result: R,
) {
  const metadata = {
    schemaVersion: z.literal(1),
    checkId: z.string().min(1).max(128),
    commandId: z.string().min(1).max(512),
    sourceVersion: z.number().int().positive(),
    attempt: z.number().int().positive(),
    submission,
  };
  return z.discriminatedUnion("state", [
    z.object({ ...metadata, state: z.literal("busy") }).strict(),
    z.object({ ...metadata, state: z.literal("error"), message: z.string().min(1) }).strict(),
    z.object({ ...metadata, state: z.literal("ready"), result }).strict(),
  ]);
}
