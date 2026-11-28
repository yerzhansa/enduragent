import type {
  AcceptedFtp,
  FtpEstimateSample,
  FtpProposal,
  IcuFtpVersion,
} from "@enduragent/engine/calendar";
import { FTP_PROPOSAL_START } from "@enduragent/engine/calendar";
import { readSelectedGenericRows } from "@enduragent/kernel/ingest";
import { parseGenericLandingEnvelope, type SqlStore } from "@enduragent/kernel/store";
import { z } from "zod";
import { readIntervalsStoreOwnerState, storeOwnerFingerprint } from "./account-identity.js";

const RIDE_TYPE = "Ride";
const WattsSchema = z.number().int().min(1).max(9_999);
const DateKeySchema = z.number().int().min(10101).max(99991231);

const BasisSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("planned-test"),
      activityId: z.string().min(1),
      dateKey: DateKeySchema,
    })
    .strict(),
  z.object({ kind: z.literal("drift") }).strict(),
]);

const MemorySchema = z
  .object({
    pause: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("none") }).strict(),
      z.object({ kind: z.literal("until"), dateKey: DateKeySchema }).strict(),
    ]),
    answeredTest: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("none") }).strict(),
      z
        .object({
          kind: z.literal("answered"),
          activityId: z.string().min(1),
          dateKey: DateKeySchema,
        })
        .strict(),
    ]),
    ftpSeen: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("none") }).strict(),
      z
        .object({ kind: z.literal("seen"), watts: WattsSchema, sinceDateKey: DateKeySchema })
        .strict(),
    ]),
  })
  .strict();

const ProposalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("quiet"), memory: MemorySchema }).strict(),
  z
    .object({
      kind: z.literal("shown"),
      watts: WattsSchema,
      basis: BasisSchema,
      memory: MemorySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("confirming"),
      watts: WattsSchema,
      basis: BasisSchema,
      icuWattsShown: WattsSchema.nullable(),
      memory: MemorySchema,
    })
    .strict(),
]);

const StateSchema = z
  .object({
    proposal: ProposalSchema,
    shownOnDateKey: DateKeySchema.nullable(),
    usedIcuWatts: WattsSchema.nullable(),
    icuChangedAtMs: z.number().int().nonnegative().nullable(),
    athleteId: z.string().max(128).nullable(),
  })
  .strict();

export interface FtpProposalRecord {
  readonly proposal: FtpProposal;
  readonly shownOnDateKey: number | null;
  readonly usedIcuWatts: number | null;
  readonly icuChangedAtMs: number | null;
  readonly athleteId: string | null;
}

export const FTP_RECORD_START: FtpProposalRecord = Object.freeze({
  proposal: FTP_PROPOSAL_START,
  shownOnDateKey: null,
  usedIcuWatts: null,
  icuChangedAtMs: null,
  athleteId: null,
});

const SettingsLandingSchema = z
  .object({
    athlete_id: z.string(),
    types: z.array(z.string()),
    ftp: z.number().nullish(),
    indoor_ftp: z.number().nullish(),
    updated: z.string().min(1),
  })
  .passthrough();

function watts(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 9_999
    ? Math.round(value)
    : null;
}

async function rideSettingsLandings(store: SqlStore) {
  const rows = await readSelectedGenericRows(store, { source: "intervals-icu", lane: "settings" });
  return rows.flatMap((row) => {
    const landing = SettingsLandingSchema.safeParse(
      parseGenericLandingEnvelope(row.payload_json, "settings").landing,
    );
    return landing.success && landing.data.types.includes(RIDE_TYPE) ? [landing.data] : [];
  });
}

function sameAthlete(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

export async function readFtpOwner(
  store: SqlStore,
  configured: string | null,
): Promise<string | null> {
  const athletes = [
    ...new Set(
      (await rideSettingsLandings(store)).flatMap((landing) =>
        landing.athlete_id.length > 0 ? [landing.athlete_id] : [],
      ),
    ),
  ];
  const owner = await readIntervalsStoreOwnerState(store);
  if (owner.status === "owned") {
    return athletes.find((athlete) => storeOwnerFingerprint(athlete) === owner.fingerprint) ?? null;
  }
  if (athletes.length === 1) return athletes[0] ?? null;
  return configured === null
    ? null
    : (athletes.find((athlete) => sameAthlete(athlete, configured)) ?? null);
}

export async function readIcuFtpVersions(
  store: SqlStore,
  athleteId: string | null,
): Promise<IcuFtpVersion[]> {
  const versions = new Map<number, IcuFtpVersion>();
  for (const landing of await rideSettingsLandings(store)) {
    if (athleteId !== null && landing.athlete_id !== athleteId) continue;
    const updatedMs = Date.parse(landing.updated);
    if (!Number.isFinite(updatedMs) || updatedMs < 0) continue;
    versions.set(updatedMs, {
      updatedMs,
      ftpWatts: watts(landing.ftp),
      indoorFtpWatts: watts(landing.indoor_ftp),
    });
  }
  return [...versions.values()].sort((left, right) => left.updatedMs - right.updatedMs);
}

const SportInfoSchema = z.array(z.object({ type: z.unknown(), eftp: z.unknown() }).passthrough());

function rideEstimate(fieldsJson: unknown): number | null {
  if (typeof fieldsJson !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(fieldsJson);
  } catch {
    return null;
  }
  const values =
    parsed !== null && typeof parsed === "object" && "values" in parsed ? parsed.values : null;
  const info =
    values !== null && typeof values === "object" && "sportInfo" in values
      ? SportInfoSchema.safeParse(values.sportInfo)
      : null;
  if (info === null || !info.success) return null;
  const ride = info.data.find((entry) => entry.type === RIDE_TYPE);
  return typeof ride?.eftp === "number" ? watts(ride.eftp) : null;
}

export async function readFtpEstimates(
  store: SqlStore,
  range: { readonly startDateKey: number; readonly endDateKey: number },
): Promise<FtpEstimateSample[]> {
  const rows = await store.all(
    "SELECT date_key, fields_json FROM wellness WHERE date_key BETWEEN ? AND ? ORDER BY date_key",
    [range.startDateKey, range.endDateKey],
  );
  return rows.flatMap((row) => {
    const estimate = rideEstimate(row.fields_json);
    return typeof row.date_key === "number" && estimate !== null
      ? [{ dateKey: row.date_key, estimatedFtpWatts: estimate }]
      : [];
  });
}

export async function readAcceptedFtp(
  store: SqlStore,
  athleteId: string | null,
): Promise<AcceptedFtp[]> {
  const rows = await store.all(
    athleteId === null
      ? "SELECT watts, basis, set_at_ms, icu_updated_ms FROM ftp_accepted ORDER BY set_at_ms, id"
      : "SELECT watts, basis, set_at_ms, icu_updated_ms FROM ftp_accepted WHERE athlete_id = ? ORDER BY set_at_ms, id",
    athleteId === null ? [] : [athleteId],
  );
  return rows.map((row) => ({
    watts: WattsSchema.parse(row.watts),
    basis: z.enum(["planned-test", "drift"]).parse(row.basis),
    setAtMs: z.number().int().nonnegative().parse(row.set_at_ms),
    icuUpdatedMs: z.number().int().nonnegative().nullable().parse(row.icu_updated_ms),
  }));
}

export async function recordAcceptedFtp(
  store: SqlStore,
  row: {
    readonly id: string;
    readonly athleteId: string;
    readonly watts: number;
    readonly previousWatts: number | null;
    readonly basis: AcceptedFtp["basis"];
    readonly icuUpdatedMs: number | null;
    readonly writtenAtMs: number;
  },
): Promise<void> {
  await store.run(
    "INSERT INTO ftp_accepted (id,athlete_id,watts,previous_watts,basis,set_at_ms,icu_updated_ms,written_at_ms) VALUES (?,?,?,?,?,?,?,?)",
    [
      row.id,
      row.athleteId,
      row.watts,
      row.previousWatts,
      row.basis,
      row.icuUpdatedMs ?? row.writtenAtMs,
      row.icuUpdatedMs,
      row.writtenAtMs,
    ],
  );
}

export async function readFtpRecord(
  store: SqlStore,
  athleteId: string | null,
): Promise<FtpProposalRecord> {
  const start = { ...FTP_RECORD_START, athleteId };
  const row = await store.get("SELECT state_json FROM ftp_proposal_state WHERE id=1");
  if (typeof row?.state_json !== "string") return start;
  const parsed = StateSchema.safeParse(JSON.parse(row.state_json));
  if (!parsed.success) return start;
  const owner = parsed.data.athleteId;
  if (athleteId !== null && owner !== null && owner !== athleteId) return start;
  return { ...parsed.data, athleteId: athleteId ?? owner };
}

export async function saveFtpRecord(
  store: SqlStore,
  record: FtpProposalRecord,
  nowMs: number,
): Promise<void> {
  await store.run(
    `INSERT INTO ftp_proposal_state (id,state_json,updated_at_ms) VALUES (1,?,?)
ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json,updated_at_ms=excluded.updated_at_ms`,
    [JSON.stringify(StateSchema.parse(record)), nowMs],
  );
}

export async function countWorkoutsOnIntervals(
  store: SqlStore,
  todayDateKey: number,
): Promise<number> {
  const row = await store.get(
    `SELECT count(*) AS count FROM plan_icu_copy AS copy
JOIN planning_plan AS plan ON plan.plan_id = copy.plan_id AND plan.status = 'active'
WHERE copy.date_key >= ? AND copy.state_kind IN ('on-icu','changed-in-icu','kept-as-yours','moving-by-you')`,
    [todayDateKey],
  );
  return typeof row?.count === "number" ? Math.min(row.count, 500) : 0;
}

export async function readAppliedFtps(
  store: SqlStore,
  sessionKeys: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  const found = new Map<string, number>();
  for (let start = 0; start < sessionKeys.length; start += 500) {
    const chunk = sessionKeys.slice(start, start + 500);
    const rows = await store.all(
      `SELECT session_key, json_extract(summary_json, '$.icu_ftp') AS icu_ftp FROM session
WHERE session_key IN (${chunk.map(() => "?").join(",")}) AND json_valid(summary_json)`,
      chunk,
    );
    for (const row of rows) {
      const applied = typeof row.icu_ftp === "number" ? watts(row.icu_ftp) : null;
      if (typeof row.session_key === "string" && applied !== null) {
        found.set(row.session_key, applied);
      }
    }
  }
  return found;
}

export async function readFtpInUseSinceMs(
  store: SqlStore,
  ftpWatts: number,
): Promise<number | null> {
  const rows = await store.all(
    `SELECT start_utc, json_extract(summary_json, '$.icu_ftp') AS icu_ftp FROM session
WHERE sport = 'cycling' AND json_valid(summary_json) AND json_type(summary_json, '$.icu_ftp') IN ('integer','real')
  AND COALESCE(sub_sport, '') NOT IN ('indoor_cycling', 'virtual_activity', 'spin')
ORDER BY start_utc DESC LIMIT 2000`,
  );
  let since: number | null = null;
  for (const row of rows) {
    if (typeof row.start_utc !== "number" || typeof row.icu_ftp !== "number") continue;
    if (watts(row.icu_ftp) !== ftpWatts) break;
    since = row.start_utc * 1_000;
  }
  return since;
}
