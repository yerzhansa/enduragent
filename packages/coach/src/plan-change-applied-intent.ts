import { PlanChangeModelSchema, type StoredPlanChangeIntent } from "@enduragent/coach-contract";
import { PlanChangeEnvelopeSchema } from "@enduragent/kernel/planning";
import type { SqlStore } from "@enduragent/kernel/store";
import { z } from "zod";

export async function readAppliedIntent(
  store: SqlStore,
  planId: string,
  changeId: string,
): Promise<StoredPlanChangeIntent | null> {
  const original = await store.get(
    "SELECT diff_json FROM plan_change WHERE id=? AND plan_id=? AND status='applied'",
    [changeId, planId],
  );
  if (original === undefined) return null;
  const envelope = PlanChangeEnvelopeSchema.parse(JSON.parse(z.string().parse(original.diff_json)));
  return PlanChangeModelSchema.shape.intent.parse(envelope.intent);
}
