import { createHash } from "node:crypto";
import {
  PlanChangeEventSourceSchema,
  type PlanChangeEventSource,
} from "@enduragent/coach-contract";
import { canonicalJson } from "@enduragent/kernel/archive";
import { PlannedEventSchema, type LatestJson } from "@enduragent/kernel/reference/schemas";

export function createPlanChangeEventSourceReader(deps: {
  calendarConnected(): boolean | Promise<boolean>;
  readLatest():
    | Pick<LatestJson, "planned_workouts">
    | null
    | Promise<Pick<LatestJson, "planned_workouts"> | null>;
}): { read(): Promise<PlanChangeEventSource[]> } {
  return {
    async read() {
      if (!(await deps.calendarConnected())) return [];
      const latest = await deps.readLatest();
      return (latest?.planned_workouts ?? []).flatMap((value) => {
        const parsed = PlannedEventSchema.safeParse(value);
        if (!parsed.success) return [];
        const { id, name, start_date_local, category } = parsed.data;
        if (category !== "RACE_A" && category !== "RACE_B" && category !== "RACE_C") return [];
        const source = PlanChangeEventSourceSchema.safeParse({
          providerId: String(id),
          name,
          date: start_date_local.slice(0, 10),
          category,
          sourceRevision: createHash("sha256")
            .update(canonicalJson({ id, name, start_date_local, category }))
            .digest("hex"),
        });
        return source.success ? [source.data] : [];
      });
    },
  };
}
