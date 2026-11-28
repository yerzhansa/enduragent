import {
  bestAveragePower,
  isFtpTestWorkoutName,
  type FtpTestResult,
} from "@enduragent/engine/calendar";
import { createPlanWorkoutMatchRepository } from "@enduragent/kernel/planning";
import {
  parseGenericLandingEnvelope,
  type MigratorStore,
  type SqlStore,
} from "@enduragent/kernel/store";
import { createLegacyPlanRepository } from "@enduragent/kernel-node/planning";
import { z } from "zod";

export interface FtpTestResultSource {
  read(): Promise<readonly FtpTestResult[]>;
}

const ChannelSchema = z.array(z.number().nullable());
const StreamLandingSchema = z.object({ time: ChannelSchema, watts: ChannelSchema }).passthrough();

async function twentyMinuteWatts(
  store: SqlStore,
  providerActivityIds: ReadonlySet<string>,
): Promise<ReadonlyMap<string, number>> {
  const found = new Map<string, number>();
  const externalIds = [...providerActivityIds].map((id) => `streams:${id}`);
  if (externalIds.length === 0) return found;
  const rows = await store.all(
    `SELECT sr.external_id, r.payload_json
FROM source_record AS sr
JOIN source_record_current AS c ON c.source_record_id = sr.id
JOIN source_record_revision AS r
  ON r.source_record_id = c.source_record_id AND r.revision_id = c.revision_id
JOIN source_artifact AS a ON a.artifact_key = r.artifact_key
WHERE sr.source = 'intervals-icu' AND a.lane = 'streams'
  AND sr.external_id IN (${externalIds.map(() => "?").join(",")})`,
    externalIds,
  );
  for (const row of rows) {
    if (typeof row.external_id !== "string" || typeof row.payload_json !== "string") continue;
    const streams = StreamLandingSchema.safeParse(
      parseGenericLandingEnvelope(row.payload_json, "streams").landing,
    );
    if (!streams.success) continue;
    const watts = bestAveragePower(streams.data.time, streams.data.watts);
    if (watts !== null) found.set(row.external_id.replace(/^streams:/u, ""), watts);
  }
  return found;
}

async function sessionStarts(
  store: SqlStore,
  sessionKeys: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  if (sessionKeys.length === 0) return new Map();
  const rows = await store.all(
    `SELECT session_key, start_utc FROM session WHERE session_key IN (${sessionKeys.map(() => "?").join(",")})`,
    sessionKeys,
  );
  return new Map(
    rows.flatMap((row) =>
      typeof row.session_key === "string" && typeof row.start_utc === "number"
        ? [[row.session_key, row.start_utc * 1_000] as const]
        : [],
    ),
  );
}

export function createStoredFtpTestResults(
  store: SqlStore & Pick<MigratorStore, "transaction">,
): FtpTestResultSource {
  return {
    async read() {
      const active = await store.get("SELECT plan_id FROM planning_plan WHERE status='active'");
      if (typeof active?.plan_id !== "string") return [];
      const tests = new Set(
        (await createLegacyPlanRepository(store).readWorkouts(active.plan_id))
          .filter((workout) => isFtpTestWorkoutName(workout.name))
          .map((workout) => workout.id),
      );
      if (tests.size === 0) return [];
      const confirmed = (
        await createPlanWorkoutMatchRepository(store).readForPlan(active.plan_id)
      ).filter(
        (match) =>
          match.decision === "confirmed" &&
          tests.has(match.planWorkoutId) &&
          match.providerActivityId !== null,
      );
      const watts = await twentyMinuteWatts(
        store,
        new Set(confirmed.flatMap((match) => match.providerActivityId ?? [])),
      );
      const starts = await sessionStarts(
        store,
        confirmed.map((match) => match.activityId),
      );
      return confirmed.flatMap((match) => {
        const best =
          match.providerActivityId === null ? undefined : watts.get(match.providerActivityId);
        const startMs = starts.get(match.activityId);
        return best === undefined || startMs === undefined
          ? []
          : [
              {
                activityId: match.activityId,
                dateKey: match.activityDateKey,
                startMs,
                twentyMinuteWatts: best,
              },
            ];
      });
    },
  };
}
