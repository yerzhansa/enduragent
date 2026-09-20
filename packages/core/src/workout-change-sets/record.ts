import { z } from "zod";

export const dateSchema = z.iso.date();
const json = z.json();
export const patchSchema = z
  .strictObject({
    date: dateSchema.optional(),
    name: z.string().min(1).max(120).optional(),
    durationSeconds: z.number().int().positive().optional(),
    description: z.string().max(4000).optional(),
    trainingLoad: z.number().nonnegative().optional(),
    structure: json.optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined));
export const additionSchema = z.strictObject({
  kind: z.literal("add"),
  sport: z.enum(["cycling", "strength"]),
  date: dateSchema,
  name: z.string().min(1).max(120),
  durationSeconds: z.number().int().positive(),
  description: z.string(),
  effort: z.string(),
  structure: json.nullable(),
  trainingLoad: z.number().nonnegative().nullable(),
});
export const preparationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("incomplete"), reason: z.string() }),
  z.strictObject({
    kind: z.literal("complete"),
    changes: z
      .array(
        z.discriminatedUnion("kind", [
          additionSchema,
          z.strictObject({
            kind: z.literal("edit"),
            eventId: z.number().int(),
            patch: patchSchema,
          }),
          z.strictObject({ kind: z.literal("delete"), eventId: z.number().int() }),
        ]),
      )
      .min(1),
  }),
]);
export const snapshotSchema = z.strictObject({
  eventId: z.number().int(),
  date: dateSchema,
  name: z.string().nullable(),
  durationSeconds: z.number().nonnegative().nullable(),
  description: z.string().nullable(),
  trainingLoad: z.number().nullable(),
  structure: json.nullable(),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export const changeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("add"),
    id: z.string(),
    prepared: additionSchema,
    recoveryIdentity: z.string(),
  }),
  z.strictObject({
    kind: z.literal("edit"),
    id: z.string(),
    reviewed: snapshotSchema,
    desired: snapshotSchema,
    patch: patchSchema,
  }),
  z.strictObject({ kind: z.literal("delete"), id: z.string(), reviewed: snapshotSchema }),
]);
export type Change = z.infer<typeof changeSchema>;
const receiptSchema = z.strictObject({
  kind: z.enum(["confirmed-write", "observed-desired-state"]),
  change: changeSchema,
  eventId: z.number().int().nullable(),
});
export type Receipt = z.infer<typeof receiptSchema>;
export const noticeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({
    kind: z.literal("changed"),
    differences: z.array(z.strictObject({ before: snapshotSchema, after: snapshotSchema })),
    additional: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("rejected"), change: changeSchema }),
  z.strictObject({ kind: z.literal("uncertain"), change: changeSchema }),
  z.strictObject({ kind: z.literal("recoveredStopped") }),
  z.strictObject({ kind: z.literal("recoveredUncertain") }),
  z.strictObject({ kind: z.literal("recoveredObserved") }),
  z.strictObject({ kind: z.literal("recoveredDeleteAbsent"), change: changeSchema }),
  z.strictObject({
    kind: z.literal("blocked"),
    reason: z.enum(["cannotVerify", "accountChanged", "pastProtected", "coachOnly", "workoutOnly"]),
  }),
]);
export type Notice = z.infer<typeof noticeSchema>;
const payload = {
  pending: z.array(changeSchema),
  finished: z.array(receiptSchema),
  context: z.array(snapshotSchema),
  notice: noticeSchema,
};
const ready = { ...payload, delivery: z.string() };
export const recordSchema = z.strictObject({
  version: z.literal(1),
  account: z.string(),
  chatId: z.string(),
  setId: z.string(),
  revision: z.number().int().positive(),
  settledTurns: z.array(z.string()),
  state: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("staged"), ...payload, turnId: z.string() }),
    z.strictObject({
      kind: z.literal("incomplete"),
      turnId: z.string(),
      finished: z.array(receiptSchema),
    }),
    z.strictObject({ kind: z.literal("review-ready"), ...ready }),
    z.strictObject({ kind: z.literal("retry-ready"), ...ready }),
    z.strictObject({
      kind: z.literal("awaiting-approval"),
      ...payload,
      tokenDigest: z.string(),
      mode: z.enum(["approval", "retry"]),
    }),
    z.strictObject({ kind: z.literal("preflighting"), ...payload }),
    z.strictObject({
      kind: z.literal("executing"),
      ...payload,
      attempting: changeSchema,
      attemptId: z.string(),
    }),
    z.strictObject({
      kind: z.literal("uncertain"),
      ...payload,
      attempting: changeSchema,
      attemptId: z.string(),
    }),
    z.strictObject({ kind: z.literal("blocked"), ...payload }),
    z.strictObject({
      kind: z.literal("abandoned"),
      finished: z.array(receiptSchema),
      delivery: z.string().nullable(),
    }),
    z.strictObject({ kind: z.literal("completed"), finished: z.array(receiptSchema) }),
    z.strictObject({ kind: z.literal("canceled"), finished: z.array(receiptSchema) }),
  ]),
});
export type Record = z.infer<typeof recordSchema>;
export type Payload = Pick<
  Extract<Record["state"], { kind: "review-ready" }>,
  "pending" | "finished" | "context" | "notice"
>;
