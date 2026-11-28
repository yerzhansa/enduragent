import { z } from "zod";
import { TrainingExportCivilDateSchema } from "./training-export.js";

export const PlanCreationUlidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
export const PlanCreationCivilDateSchema = TrainingExportCivilDateSchema;

export const PlanCreationPlanLengthWeeksSchema = z.union([
  z.literal(4),
  z.literal(8),
  z.literal(12),
  z.literal(16),
]);
export const PlanCreationWeekdaySchema = z.number().int().min(1).max(7);
