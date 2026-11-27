import { z } from "zod";

const UlidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);

export const PlanCalendarWeekDeliverySchema = z.enum(["send-each-week", "approve-each-week"]);
export type PlanCalendarWeekDelivery = z.infer<typeof PlanCalendarWeekDeliverySchema>;

export const PlanCalendarApproveScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("first-weeks") }).strict(),
  z.object({ kind: z.literal("week"), week: z.number().int().min(1).max(52) }).strict(),
]);
export type PlanCalendarApproveScope = z.infer<typeof PlanCalendarApproveScopeSchema>;

export const PlanCalendarRpcParamsSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("approve-weeks"),
      planId: UlidSchema,
      scope: PlanCalendarApproveScopeSchema,
    })
    .strict(),
  z.object({ action: z.literal("read-settings") }).strict(),
  z
    .object({
      action: z.literal("save-settings"),
      weekDelivery: PlanCalendarWeekDeliverySchema,
    })
    .strict(),
]);
export type PlanCalendarRpcParams = z.infer<typeof PlanCalendarRpcParamsSchema>;

export const PlanCalendarRefusalSchema = z.enum([
  "no-active-plan",
  "already-approved",
  "not-approved-yet",
  "week-not-due",
]);
export type PlanCalendarRefusal = z.infer<typeof PlanCalendarRefusalSchema>;

export const PlanCalendarRpcResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("approved"),
      weeks: z.array(z.number().int().min(1).max(52)).max(52),
    })
    .strict(),
  z.object({ status: z.literal("refused"), reason: PlanCalendarRefusalSchema }).strict(),
  z
    .object({ status: z.literal("settings"), weekDelivery: PlanCalendarWeekDeliverySchema })
    .strict(),
]);
export type PlanCalendarRpcResult = z.infer<typeof PlanCalendarRpcResultSchema>;

export interface PlanCalendarRpcService {
  "plan.calendar"(request: PlanCalendarRpcParams): Promise<PlanCalendarRpcResult>;
}
