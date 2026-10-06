import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AthleteHome } from "../home/resolve-athlete-home.js";
import type { LegacyPlanImportLogger } from "./legacy-plan-store.js";

const LegacyPlanSourceSchema = z.object({
  name: z.string().refine((value) => value.trim().length > 0),
  primaryGoal: z.unknown().optional(),
  totalWeeks: z.unknown().optional(),
  status: z.unknown().optional(),
  createdAt: z.unknown().optional(),
  targetDate: z.unknown().optional(),
});

function optionalDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp).toISOString().split("T")[0];
  const parsed = z.iso.date().safeParse(date);
  return parsed.success ? parsed.data : null;
}

function summarize(source: z.infer<typeof LegacyPlanSourceSchema>) {
  return {
    name: source.name,
    goal:
      typeof source.primaryGoal === "string" && source.primaryGoal.trim().length > 0
        ? source.primaryGoal
        : null,
    weeks:
      typeof source.totalWeeks === "number" &&
      Number.isSafeInteger(source.totalWeeks) &&
      source.totalWeeks > 0
        ? source.totalWeeks
        : null,
    sourceStatus: typeof source.status === "string" ? source.status : null,
    createdAt: optionalDate(source.createdAt),
    targetDate: optionalDate(source.targetDate),
    readOnly: true as const,
    source: "current-plan.json" as const,
  };
}

type LegacyPlanSummary = ReturnType<typeof summarize>;

function warn(logger: LegacyPlanImportLogger, message: string): void {
  try {
    logger.warn(message);
  } catch {}
}

export async function readLegacyCurrentPlanSummary(input: {
  readonly home: AthleteHome;
  readonly logger: LegacyPlanImportLogger;
}): Promise<LegacyPlanSummary | null> {
  let bytes: string;
  try {
    bytes = await readFile(join(input.home.root, "plans", "current-plan.json"), "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return null;
    }
    warn(input.logger, "Legacy Plan summary skipped because the source could not be read.");
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch {
    warn(input.logger, "Legacy Plan summary skipped because the source is malformed.");
    return null;
  }
  const parsed = LegacyPlanSourceSchema.safeParse(value);
  if (!parsed.success) {
    warn(input.logger, "Legacy Plan summary skipped because the source is malformed.");
    return null;
  }
  return summarize(parsed.data);
}
