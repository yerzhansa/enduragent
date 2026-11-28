import { canonicalJson } from "@enduragent/kernel/archive";
import type { SqlStore } from "@enduragent/kernel/store";

export interface ReviewRideFacts {
  readonly watts?: number;
  readonly heartRate?: number;
}

export async function seedReviewRide(
  store: Pick<SqlStore, "run">,
  key: string,
  dateKey: number,
  facts: ReviewRideFacts,
): Promise<void> {
  const day = String(dateKey);
  const iso = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
  const start = Date.parse(`${iso}T06:40:00Z`) / 1000;
  await store.run(
    "INSERT INTO workout (workout_key, start_utc, tz_offset_s, name, dedup_cluster_id) VALUES (?, ?, 3600, NULL, ?)",
    [key, start, key],
  );
  await store.run(
    `INSERT INTO session (session_key, workout_key, session_seq, sport, sub_sport, start_utc, tz_offset_s,
      local_date_key, moving_s, distance_m, is_transition)
     VALUES (?, ?, 0, 'cycling', 'road', ?, 3600, ?, 3540, 24100, 0)`,
    [key, key, start, dateKey],
  );
  const artifact = `${key.slice(0, 63)}f`;
  const external = `i${key.slice(0, 6)}${dateKey}`;
  await store.run(
    "INSERT INTO source_artifact(artifact_key,source,lane,external_id,artifact_kind,archive_address,archive_rel_path,archive_epoch_s) VALUES(?,?,?,?,?,?,?,?)",
    [
      artifact,
      "intervals-icu",
      "activities",
      external,
      "snapshot",
      "d".repeat(64),
      `1998/${artifact}.json.gz`,
      start,
    ],
  );
  await store.run(
    "INSERT INTO source_record(id,workout_key,session_key,source,external_id,raw_sha256,quality_rank,payload_json,artifact_key) VALUES(?,?,?,?,?,?,?,?,?)",
    [
      `${key.slice(0, 63)}e`,
      key,
      key,
      "intervals-icu",
      external,
      "c".repeat(64),
      1,
      canonicalJson({
        activity: {
          id: external,
          name: "Synthetic road ride",
          icu_training_load: 52,
          ...(facts.watts === undefined ? {} : { average_watts: facts.watts }),
          ...(facts.heartRate === undefined ? {} : { average_heartrate: facts.heartRate }),
          start_date_local: `${iso}T07:40:00`,
          type: "Ride",
        },
        concerns: {},
        dedup: {},
        schema_version: 1,
      }),
      artifact,
    ],
  );
}
