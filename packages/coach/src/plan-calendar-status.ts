import type { PlanCalendarStatus } from "@enduragent/coach-contract";
import type { PlanReconciliationJobRecord } from "@enduragent/kernel/planning";
import type { SqlStore } from "@enduragent/kernel/store";

export function dateText(dateKey: number): string {
  const digits = String(dateKey).padStart(8, "0");
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

export async function plansWaitingForApprove(
  store: Pick<SqlStore, "all">,
): Promise<ReadonlySet<string>> {
  const rows = await store.all(
    `SELECT delivery.plan_id FROM plan_week_delivery delivery
JOIN planning_plan plan ON plan.plan_id=delivery.plan_id
WHERE delivery.state_kind='waiting-for-first-approve' AND plan.status='active'
UNION SELECT plan_id FROM plan_cleanup_hold WHERE released_at_ms IS NULL`,
  );
  return new Set(rows.flatMap((row) => (typeof row.plan_id === "string" ? [row.plan_id] : [])));
}

function jobStatus(
  job: PlanReconciliationJobRecord | undefined,
  connected: boolean,
): PlanCalendarStatus {
  const window =
    job === undefined
      ? null
      : { start: dateText(job.windowStartDateKey), end: dateText(job.windowEndDateKey) };
  if (job?.status === "verified") {
    return {
      status: "verified",
      window,
      currentThrough: dateText(job.windowEndDateKey),
      error: null,
    };
  }
  if (!connected) {
    return { status: "not-connected", window, currentThrough: null, error: null };
  }
  if (job === undefined || job.status === "pending") {
    return { status: "pending", window, currentThrough: null, error: null };
  }
  if (job.status === "failed") {
    const error = job.kind === "mirror" ? "Calendar sync failed." : "Calendar cleanup failed.";
    const retry = job.kind === "cleanup" || job.failureCount < 5 ? " Retry available." : "";
    return { status: "failed", window, currentThrough: null, error: `${error}${retry}` };
  }
  return { status: "running", window, currentThrough: null, error: null };
}

export function planCalendarStatus(input: {
  readonly job: PlanReconciliationJobRecord | undefined;
  readonly connected: boolean;
  readonly waitingForApprove: boolean;
}): PlanCalendarStatus {
  const failedCleanup = input.job?.kind === "cleanup" && input.job.status === "failed";
  if (input.waitingForApprove && !failedCleanup) {
    return { status: "waiting-for-approve", window: null, currentThrough: null, error: null };
  }
  const status = jobStatus(input.job, input.connected);
  return input.waitingForApprove ? { ...status, waitingForApprove: true } : status;
}
