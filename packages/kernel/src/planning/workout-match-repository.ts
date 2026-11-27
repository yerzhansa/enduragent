import type { Row, SqlStore } from "../store/ports.js";

export type PlanWorkoutMatchSource = "platform" | "heuristic";
export type PlanWorkoutMatchDecision = "suggested" | "confirmed" | "rejected" | "unpaired";

export interface PlanWorkoutMatchRecord {
  readonly id: string;
  readonly planId: string;
  readonly planWorkoutId: string;
  readonly activityId: string;
  readonly providerActivityId: string | null;
  readonly providerEventId: number | null;
  readonly source: PlanWorkoutMatchSource;
  readonly decision: PlanWorkoutMatchDecision;
  readonly activityDateKey: number;
  readonly activitySport: string;
  readonly activityDurationS: number | null;
  readonly observedAtMs: number;
  readonly decidedAtMs: number | null;
  readonly deviceId: string;
  readonly hlcPhysicalMs: number;
  readonly hlcCounter: number;
}

export interface PlanActivityObservation {
  readonly activityId: string;
  readonly providerActivityId: string | null;
  readonly dateKey: number;
  readonly sport: string;
  readonly durationS: number | null;
  readonly pairedEventId: number | null;
}

export interface PlanWorkoutProviderIdentity {
  readonly planWorkoutId: string;
  readonly providerEventId: number;
}

export interface PlanWorkoutMatchSyncStatus {
  readonly lastSuccessfulSyncAtMs: number | null;
  readonly awaitingSync: boolean;
}

export interface PlanWorkoutMatchRepository {
  observe(record: PlanWorkoutMatchRecord): Promise<PlanWorkoutMatchRecord | null>;
  readForPlan(planId: string): Promise<readonly PlanWorkoutMatchRecord[]>;
  readForWorkout(planWorkoutId: string): Promise<readonly PlanWorkoutMatchRecord[]>;
  decide(input: {
    readonly id: string;
    readonly decision: Exclude<PlanWorkoutMatchDecision, "suggested">;
    readonly decidedAtMs: number;
    readonly deviceId: string;
    readonly hlcPhysicalMs: number;
    readonly hlcCounter: number;
  }): Promise<PlanWorkoutMatchRecord>;
  listActivities(
    startDateKey: number,
    endDateKey: number,
  ): Promise<readonly PlanActivityObservation[]>;
  readProviderIdentities(planId: string): Promise<readonly PlanWorkoutProviderIdentity[]>;
  readSyncStatus(): Promise<PlanWorkoutMatchSyncStatus>;
}

export class PlanWorkoutMatchValidationError extends Error {
  readonly code: "invalid-match" | "missing-match" | "invalid-transition" | "already-confirmed";

  constructor(code: PlanWorkoutMatchValidationError["code"]) {
    super(`plan workout match rejected: ${code}`);
    this.name = "PlanWorkoutMatchValidationError";
    this.code = code;
  }
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const HASH = /^[0-9a-f]{64}$/;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SOURCE = new Set<unknown>(["platform", "heuristic"]);
const DECISION = new Set<unknown>(["suggested", "confirmed", "rejected", "unpaired"]);

function integer(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new PlanWorkoutMatchValidationError("invalid-match");
  }
  return value;
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new PlanWorkoutMatchValidationError("invalid-match");
  return value;
}

function nullableInteger(row: Row, key: string): number | null {
  const value = row[key];
  if (value !== null && (typeof value !== "number" || !Number.isSafeInteger(value))) {
    throw new PlanWorkoutMatchValidationError("invalid-match");
  }
  return value;
}

function nullableText(row: Row, key: string): string | null {
  const value = row[key];
  if (value !== null && typeof value !== "string") {
    throw new PlanWorkoutMatchValidationError("invalid-match");
  }
  return value;
}

function validDateKey(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 10_101 && value <= 99_991_231;
}

function validate(record: PlanWorkoutMatchRecord): void {
  const platformValid =
    record.source === "platform" &&
    record.providerActivityId !== null &&
    record.providerEventId !== null &&
    record.providerEventId > 0;
  const heuristicValid = record.source === "heuristic" && record.providerEventId === null;
  if (
    !ULID.test(record.id) ||
    !ULID.test(record.planId) ||
    !ULID.test(record.planWorkoutId) ||
    !HASH.test(record.activityId) ||
    !SOURCE.has(record.source) ||
    !DECISION.has(record.decision) ||
    !validDateKey(record.activityDateKey) ||
    record.activitySport.length === 0 ||
    (record.activityDurationS !== null &&
      (!Number.isSafeInteger(record.activityDurationS) || record.activityDurationS <= 0)) ||
    !Number.isSafeInteger(record.observedAtMs) ||
    record.observedAtMs < 0 ||
    (record.decidedAtMs !== null &&
      (!Number.isSafeInteger(record.decidedAtMs) || record.decidedAtMs < record.observedAtMs)) ||
    !DEVICE_ID.test(record.deviceId) ||
    !Number.isSafeInteger(record.hlcPhysicalMs) ||
    record.hlcPhysicalMs < 0 ||
    !Number.isSafeInteger(record.hlcCounter) ||
    record.hlcCounter < 0 ||
    (!platformValid && !heuristicValid) ||
    (record.decision === "suggested" &&
      (record.source !== "heuristic" || record.decidedAtMs !== null)) ||
    (record.decision !== "suggested" && record.decidedAtMs === null) ||
    (record.decision === "unpaired" && record.source !== "platform")
  ) {
    throw new PlanWorkoutMatchValidationError("invalid-match");
  }
}

function fromRow(row: Row): PlanWorkoutMatchRecord {
  const record: PlanWorkoutMatchRecord = {
    id: text(row, "id"),
    planId: text(row, "plan_id"),
    planWorkoutId: text(row, "plan_workout_id"),
    activityId: text(row, "activity_id"),
    providerActivityId: nullableText(row, "provider_activity_id"),
    providerEventId: nullableInteger(row, "provider_event_id"),
    source: text(row, "source") as PlanWorkoutMatchSource,
    decision: text(row, "decision") as PlanWorkoutMatchDecision,
    activityDateKey: integer(row, "activity_date_key"),
    activitySport: text(row, "activity_sport"),
    activityDurationS: nullableInteger(row, "activity_duration_s"),
    observedAtMs: integer(row, "observed_at_ms"),
    decidedAtMs: nullableInteger(row, "decided_at_ms"),
    deviceId: text(row, "device_id"),
    hlcPhysicalMs: integer(row, "hlc_physical_ms"),
    hlcCounter: integer(row, "hlc_counter"),
  };
  validate(record);
  return Object.freeze(record);
}

function pairedEventId(payloadJson: string): number | null {
  try {
    const payload = JSON.parse(payloadJson) as {
      readonly paired_event_id?: unknown;
      readonly activity?: { readonly paired_event_id?: unknown };
    };
    const value = payload.activity?.paired_event_id ?? payload.paired_event_id;
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

const COLUMNS = `id, plan_id, plan_workout_id, activity_id, provider_activity_id,
provider_event_id, source, decision, activity_date_key, activity_sport,
activity_duration_s, observed_at_ms, decided_at_ms, device_id, hlc_physical_ms, hlc_counter`;

export function createPlanWorkoutMatchRepository(store: SqlStore): PlanWorkoutMatchRepository {
  const readById = async (id: string): Promise<PlanWorkoutMatchRecord | undefined> => {
    const row = await store.get(`SELECT ${COLUMNS} FROM plan_workout_match WHERE id=?`, [id]);
    return row === undefined ? undefined : fromRow(row);
  };

  const repository: PlanWorkoutMatchRepository = {
    async observe(record) {
      validate(record);
      await store.run(
        `INSERT INTO plan_workout_match (${COLUMNS})
SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
WHERE NOT EXISTS (
  SELECT 1 FROM plan_workout_match other
  WHERE other.plan_id=? AND other.decision='confirmed'
    AND NOT (other.plan_workout_id=? AND other.activity_id=?)
    AND (other.plan_workout_id=? OR other.activity_id=?)
)
ON CONFLICT (plan_workout_id, activity_id) DO UPDATE SET
  provider_activity_id=excluded.provider_activity_id,
  provider_event_id=excluded.provider_event_id,
  source=excluded.source,
  decision=excluded.decision,
  activity_date_key=excluded.activity_date_key,
  activity_sport=excluded.activity_sport,
  activity_duration_s=excluded.activity_duration_s,
  observed_at_ms=excluded.observed_at_ms,
  decided_at_ms=excluded.decided_at_ms,
  device_id=excluded.device_id,
  hlc_physical_ms=excluded.hlc_physical_ms,
  hlc_counter=excluded.hlc_counter
WHERE plan_workout_match.decision='suggested'`,
        [
          record.id,
          record.planId,
          record.planWorkoutId,
          record.activityId,
          record.providerActivityId,
          record.providerEventId,
          record.source,
          record.decision,
          record.activityDateKey,
          record.activitySport,
          record.activityDurationS,
          record.observedAtMs,
          record.decidedAtMs,
          record.deviceId,
          record.hlcPhysicalMs,
          record.hlcCounter,
          record.planId,
          record.planWorkoutId,
          record.activityId,
          record.planWorkoutId,
          record.activityId,
        ],
      );
      const stored = await store.get(
        `SELECT ${COLUMNS} FROM plan_workout_match WHERE plan_workout_id=? AND activity_id=?`,
        [record.planWorkoutId, record.activityId],
      );
      return stored === undefined ? null : fromRow(stored);
    },
    async readForPlan(planId) {
      if (!ULID.test(planId)) throw new PlanWorkoutMatchValidationError("invalid-match");
      return (
        await store.all(
          `SELECT ${COLUMNS} FROM plan_workout_match WHERE plan_id=? ORDER BY activity_date_key,id`,
          [planId],
        )
      ).map(fromRow);
    },
    async readForWorkout(planWorkoutId) {
      if (!ULID.test(planWorkoutId)) throw new PlanWorkoutMatchValidationError("invalid-match");
      return (
        await store.all(
          `SELECT ${COLUMNS} FROM plan_workout_match WHERE plan_workout_id=? ORDER BY observed_at_ms DESC,id`,
          [planWorkoutId],
        )
      ).map(fromRow);
    },
    async decide(input) {
      if (
        !ULID.test(input.id) ||
        !DECISION.has(input.decision) ||
        !Number.isSafeInteger(input.decidedAtMs) ||
        input.decidedAtMs < 0 ||
        !DEVICE_ID.test(input.deviceId) ||
        !Number.isSafeInteger(input.hlcPhysicalMs) ||
        input.hlcPhysicalMs < 0 ||
        !Number.isSafeInteger(input.hlcCounter) ||
        input.hlcCounter < 0
      ) {
        throw new PlanWorkoutMatchValidationError("invalid-match");
      }
      const current = await readById(input.id);
      if (current === undefined) throw new PlanWorkoutMatchValidationError("missing-match");
      const allowed =
        (current.decision === "suggested" &&
          (input.decision === "confirmed" || input.decision === "rejected")) ||
        (current.source === "platform" &&
          current.decision === "confirmed" &&
          input.decision === "unpaired") ||
        (current.source === "platform" &&
          current.decision === "unpaired" &&
          input.decision === "confirmed") ||
        (current.source === "heuristic" &&
          current.decision === "confirmed" &&
          input.decision === "rejected") ||
        (current.source === "heuristic" &&
          current.decision === "rejected" &&
          input.decision === "confirmed");
      if (!allowed) throw new PlanWorkoutMatchValidationError("invalid-transition");
      await store.run(
        `UPDATE plan_workout_match SET decision=?, decided_at_ms=?, device_id=?,
hlc_physical_ms=?, hlc_counter=? WHERE id=? AND (? <> 'confirmed' OR NOT EXISTS (
  SELECT 1 FROM plan_workout_match other
  WHERE other.plan_id=plan_workout_match.plan_id AND other.decision='confirmed'
    AND other.id<>plan_workout_match.id
    AND (other.plan_workout_id=plan_workout_match.plan_workout_id
      OR other.activity_id=plan_workout_match.activity_id)
))`,
        [
          input.decision,
          input.decidedAtMs,
          input.deviceId,
          input.hlcPhysicalMs,
          input.hlcCounter,
          input.id,
          input.decision,
        ],
      );
      const stored = await readById(input.id);
      if (stored === undefined) throw new PlanWorkoutMatchValidationError("missing-match");
      if (stored.decision !== input.decision) {
        throw new PlanWorkoutMatchValidationError("already-confirmed");
      }
      return stored;
    },
    async listActivities(startDateKey, endDateKey) {
      if (!validDateKey(startDateKey) || !validDateKey(endDateKey) || endDateKey < startDateKey) {
        throw new PlanWorkoutMatchValidationError("invalid-match");
      }
      const rows = await store.all(
        `SELECT s.session_key, s.local_date_key, s.sport,
COALESCE(s.timer_s,s.moving_s,s.elapsed_s) AS duration_s,
sr.external_id, COALESCE(rev.payload_json,sr.payload_json) AS payload_json
FROM session s
LEFT JOIN source_record sr ON sr.session_key=s.session_key AND sr.source='intervals-icu'
LEFT JOIN source_record_current current ON current.source_record_id=sr.id
LEFT JOIN source_record_revision rev ON rev.source_record_id=current.source_record_id
  AND rev.revision_id=current.revision_id
WHERE s.local_date_key BETWEEN ? AND ?
ORDER BY s.local_date_key,s.session_key,sr.external_id`,
        [startDateKey, endDateKey],
      );
      const seen = new Set<string>();
      const observations: PlanActivityObservation[] = [];
      for (const row of rows) {
        const activityId = text(row, "session_key");
        if (seen.has(activityId)) continue;
        seen.add(activityId);
        const payload = nullableText(row, "payload_json");
        observations.push(
          Object.freeze({
            activityId,
            providerActivityId: nullableText(row, "external_id"),
            dateKey: integer(row, "local_date_key"),
            sport: text(row, "sport"),
            durationS: nullableInteger(row, "duration_s"),
            pairedEventId: payload === null ? null : pairedEventId(payload),
          }),
        );
      }
      return observations;
    },
    async readProviderIdentities(planId) {
      if (!ULID.test(planId)) throw new PlanWorkoutMatchValidationError("invalid-match");
      const rows = await store.all(
        `SELECT plan_workout_id,provider_event_id FROM (
SELECT copy.plan_workout_id,
  CAST(json_extract(copy.state_json,'$.baseline.eventId') AS INTEGER) AS provider_event_id,
  0 AS source_rank,copy.updated_at_ms AS updated_at_ms,copy.plan_workout_id AS tie
FROM plan_icu_copy copy
WHERE copy.plan_id=? AND copy.state_kind IN ('on-icu','moving-by-you','changed-in-icu')
UNION ALL
SELECT item.plan_workout_id,item.provider_event_id,1,job.updated_at_ms,item.id
FROM plan_reconciliation_item item
JOIN plan_reconciliation_job job ON job.id=item.job_id
WHERE job.plan_id=? AND job.kind='mirror' AND job.status='verified'
  AND item.status='verified' AND item.plan_workout_id IS NOT NULL
  AND item.provider_event_id IS NOT NULL
) WHERE provider_event_id IS NOT NULL
ORDER BY source_rank,updated_at_ms DESC,tie`,
        [planId, planId],
      );
      const seen = new Set<string>();
      const identities: PlanWorkoutProviderIdentity[] = [];
      for (const row of rows) {
        const planWorkoutId = text(row, "plan_workout_id");
        if (seen.has(planWorkoutId)) continue;
        seen.add(planWorkoutId);
        identities.push(
          Object.freeze({
            planWorkoutId,
            providerEventId: integer(row, "provider_event_id"),
          }),
        );
      }
      return identities;
    },
    async readSyncStatus() {
      const [success, failure] = await Promise.all([
        store.get(`SELECT max(archive_epoch_s) AS epoch_s FROM source_artifact
WHERE source='intervals-icu' AND lane='activities'`),
        store.get("SELECT source FROM sync_failure WHERE source='intervals-icu'"),
      ]);
      const epoch = success?.epoch_s;
      return Object.freeze({
        lastSuccessfulSyncAtMs:
          typeof epoch === "number" && Number.isSafeInteger(epoch) ? epoch * 1_000 : null,
        awaitingSync: failure !== undefined,
      });
    },
  };
  return Object.freeze(repository);
}
