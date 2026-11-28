import type { PlanCreationCardModel } from "@enduragent/coach-contract";
import { addCivilDays, type PlanCreationSnapshot } from "@enduragent/kernel/planning";
import type { SqlStore } from "@enduragent/kernel/store";
import { readOneFtp } from "./one-ftp.js";
import { projectPlanCreationCard } from "./plan-creation-answers.js";
import { dateText } from "./plan-calendar-status.js";

export async function projectCreationCard(
  snapshot: PlanCreationSnapshot,
  context: {
    readonly store: SqlStore;
    readonly today: string;
    readonly todayDateKey: number;
    readonly calendarConnected: boolean;
    readonly ftp: { readonly athleteId: string | null } | null;
  },
): Promise<PlanCreationCardModel> {
  let calendarWindow: PlanCreationCardModel["calendarWindow"] = null;
  if (context.calendarConnected) {
    const active = await context.store.get("SELECT id FROM plan WHERE status='active' LIMIT 1");
    calendarWindow = {
      startDate: dateText(addCivilDays(context.todayDateKey, active === undefined ? 0 : 1)),
      endDate: dateText(addCivilDays(context.todayDateKey, 6)),
    };
  }
  const ftp = context.ftp === null ? null : await readOneFtp(context.store, context.ftp.athleteId);
  return {
    ...projectPlanCreationCard(snapshot, { today: context.today, calendarWindow }),
    ftpWatts: ftp?.current?.watts ?? null,
  };
}
