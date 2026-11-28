import { PlanWorkoutContentSchema } from "@enduragent/coach-contract";
import type { DescribeWorkout } from "@enduragent/engine/calendar";
import type { SqlStore } from "@enduragent/kernel/store";
import { intervalsStepsText } from "@enduragent/sport-cycling";
import { readOneFtp } from "./one-ftp.js";

export interface PlanWorkoutDescriberSource {
  readonly store: SqlStore;
  readonly athleteId: string | null;
}

function structureOf(structureJson: string): object | null {
  try {
    const value: unknown = JSON.parse(structureJson);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export function planWorkoutDescriber({
  ftpKnown,
}: {
  readonly ftpKnown: boolean;
}): DescribeWorkout {
  return (structureJson) => {
    const structure = structureOf(structureJson);
    if (structure === null) return null;
    if ("content" in structure) {
      if (!ftpKnown) return null;
      const content = PlanWorkoutContentSchema.safeParse(structure.content);
      return content.success ? intervalsStepsText(content.data) : null;
    }
    return "description" in structure && typeof structure.description === "string"
      ? structure.description
      : null;
  };
}

export const PLAN_WORKOUT_DESCRIBERS: readonly DescribeWorkout[] = [
  planWorkoutDescriber({ ftpKnown: true }),
  planWorkoutDescriber({ ftpKnown: false }),
];

export class FtpUnreadableError extends Error {
  constructor(cause: unknown) {
    super("The FTP could not be read.", { cause });
    this.name = "FtpUnreadableError";
  }
}

export async function readPlanWorkoutDescriber(
  source: PlanWorkoutDescriberSource,
): Promise<DescribeWorkout> {
  const ftp = await readOneFtp(source.store, source.athleteId).catch((cause: unknown) => {
    throw new FtpUnreadableError(cause);
  });
  return planWorkoutDescriber({ ftpKnown: ftp.current !== null });
}
