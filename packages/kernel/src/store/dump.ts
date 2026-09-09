import { canonicalRowJson } from "./canonical-json.js";
import type { Row, SqlStore } from "./ports.js";

export const DERIVED_TABLES = [
  "metric_snapshot",
  "mean_max_cache",
  "ingest_cluster_state",
  "ingest_dedup_session_state",
  "ingest_dedup_pair_state",
  "ingest_candidate_index",
  "repair_log",
  "stream",
  "swim_length",
  "lap",
  "session",
  "workout",
] as const;

export const DUMP_TABLES = [
  {
    table: "activity_analysis_projection",
    orderBy: "canonical_activity_id, source_revision, contract_version, section",
  },
  { table: "analytics_curve_current", orderBy: "singleton" },
  { table: "analytics_curve_evidence", orderBy: "evidence_id" },
  { table: "analytics_curve_generation", orderBy: "generation_id" },
  { table: "analytics_curve_generation_promotion", orderBy: "generation_id" },
  { table: "anchor_history", orderBy: "id" },
  { table: "athlete", orderBy: "id" },
  { table: "chat_plan_outbox", orderBy: "request_id" },
  { table: "dedup_confirmation", orderBy: "id" },
  { table: "field_merge_override_overlay", orderBy: "id" },
  { table: "ingest_candidate_index", orderBy: "candidate_id" },
  { table: "ingest_cluster_state", orderBy: "cluster_id" },
  { table: "ingest_dedup_pair_state", orderBy: "candidate_a, candidate_b" },
  { table: "ingest_dedup_session_state", orderBy: "session_group_id" },
  { table: "ingest_incremental_state", orderBy: "singleton" },
  { table: "ingest_metadata", orderBy: "singleton" },
  { table: "intake_flags", orderBy: "id" },
  { table: "lap", orderBy: "lap_key" },
  { table: "mean_max_cache", orderBy: "mmax_key" },
  { table: "metric_snapshot", orderBy: "snapshot_key" },
  { table: "plan", orderBy: "id" },
  { table: "planning_authority", orderBy: "singleton" },
  { table: "planning_plan", orderBy: "plan_id" },
  { table: "plan_revision", orderBy: "plan_id, revision_number, id" },
  { table: "plan_creation", orderBy: "created_at_ms, id" },
  { table: "plan_creation_answer", orderBy: "creation_id, sequence, id" },
  {
    table: "plan_creation_draft_revision",
    orderBy: "creation_id, revision_number, id",
  },
  { table: "athlete_preference", orderBy: "created_at_ms, id" },
  { table: "training_restriction", orderBy: "start_date_key, id" },
  { table: "plan_change", orderBy: "plan_id, created_at_ms, id" },
  { table: "planning_command", orderBy: "command_name, command_id" },
  { table: "plan_adaptation_ledger", orderBy: "plan_id, occurred_at_ms, id" },
  { table: "plan_conversation", orderBy: "id" },
  { table: "plan_conversation_turn", orderBy: "conversation_id, sequence, id" },
  { table: "plan_draft_revision", orderBy: "conversation_id, revision, id" },
  { table: "plan_intake", orderBy: "conversation_id" },
  { table: "plan_draft_build_checkpoint", orderBy: "conversation_id" },
  { table: "plan_proposal", orderBy: "plan_id, created_at_ms, id" },
  { table: "plan_proposal_premise", orderBy: "proposal_id, source_type, source_id, id" },
  { table: "plan_reconciliation_item", orderBy: "job_id, date_key, id" },
  { table: "plan_reconciliation_job", orderBy: "plan_id, kind, window_start_date_key, id" },
  { table: "plan_race_outcome", orderBy: "plan_id" },
  { table: "plan_replacement", orderBy: "previous_plan_id, created_at_ms, id" },
  { table: "plan_settings", orderBy: "plan_id" },
  { table: "plan_source_request", orderBy: "conversation_id, created_at_ms, id" },
  { table: "plan_workout", orderBy: "plan_id, date_key, id" },
  { table: "plan_workout_drift", orderBy: "plan_id, detected_at_ms, id" },
  { table: "plan_workout_match", orderBy: "plan_id, activity_date_key, id" },
  { table: "plan_weekly_review", orderBy: "plan_id, week_start_date_key, id" },
  { table: "planned_workout", orderBy: "id" },
  { table: "planning_request", orderBy: "request_id" },
  { table: "planning_request_terminal_result", orderBy: "request_id" },
  { table: "planning_request_tombstone", orderBy: "request_id" },
  { table: "pool_size_correction_overlay", orderBy: "id" },
  { table: "race_goal", orderBy: "id" },
  { table: "raw_file", orderBy: "sha256" },
  { table: "repair_fixer_settings", orderBy: "fixer" },
  { table: "repair_log", orderBy: "repair_key" },
  { table: "session", orderBy: "session_key" },
  { table: "source_artifact", orderBy: "artifact_key" },
  { table: "source_record", orderBy: "id" },
  { table: "source_record_current", orderBy: "source_record_id" },
  { table: "source_record_revision", orderBy: "revision_id" },
  { table: "sport_settings", orderBy: "id" },
  { table: "stream", orderBy: "stream_key" },
  { table: "stroke_correction_overlay", orderBy: "id" },
  { table: "swim_length", orderBy: "length_key" },
  { table: "wellness", orderBy: "id" },
  { table: "workout", orderBy: "workout_key" },
  { table: "zone_set_history", orderBy: "id" },
] as const;

/** Pure: already-ordered rows → the canonical section for one table (header line + one line per row). */
export function canonicalizeTable(table: string, rows: readonly Row[]): string {
  return [`# ${table}`, ...rows.map(canonicalRowJson)].join("\n");
}

/** Async: SELECT * ORDER BY <key> per table, canonicalize, concatenate. */
export async function dumpStore(store: SqlStore): Promise<string> {
  const sections: string[] = [];
  for (const { table, orderBy } of DUMP_TABLES) {
    const rows = await store.all(`SELECT * FROM ${table} ORDER BY ${orderBy} ASC`);
    sections.push(canonicalizeTable(table, rows));
  }
  return sections.join("\n");
}
