export type SqlValue = string | number | bigint | Uint8Array | null;
export type Row = Record<string, SqlValue>;

import type { RepairFixer } from "../ingest/repair/types.js";
import type { SubjectiveScore } from "../reference/schemas/inputs.js";

/**
 * Low-level async SQL-exec port. The SQLite driver in kernel-node implements it
 * (wrapping the synchronous DatabaseSync in resolved promises, per the
 * async-first port rule). No driver types cross this boundary.
 */
export interface SqlStore {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: readonly SqlValue[]): Promise<void>;
  get(sql: string, params?: readonly SqlValue[]): Promise<Row | undefined>;
  all(sql: string, params?: readonly SqlValue[]): Promise<Row[]>;
  close(): Promise<void>;
}

export interface SqlReadStore {
  get(sql: string, params?: readonly SqlValue[]): Promise<Row | undefined>;
  all(sql: string, params?: readonly SqlValue[]): Promise<Row[]>;
  close(): Promise<void>;
}

export interface AnchorHistoryRow {
  id: string;
  sport: string;
  anchor_type: string;
  value: number;
  unit: string;
  valid_from: number;
  source: string;
  confidence: string;
  note: string | null;
  provenance: string;
  device_id: string | null;
  hlc_physical_ms: number | null;
  hlc_counter: number | null;
}

export interface RawFileRow {
  sha256: string;
  path: string | null;
  ext: string | null;
  bytes: number | null;
  file_id_serial: number | null;
  file_id_time_created_utc: number | null;
  manufacturer: string | null;
  product: string | null;
}

export interface SourceRecordRow {
  id: string;
  workout_key: string | null;
  session_key: string | null;
  source: string;
  external_id: string;
  raw_sha256: string | null;
  quality_rank: number;
  payload_json: string;
}

export interface AnchorRepository {
  /** Insert iff no row exists for (sport, anchor_type, valid_from). Returns true if inserted. */
  insertIfAbsent(row: AnchorHistoryRow): Promise<boolean>;
  /** Effective-dated current row: max valid_from ≤ asOfEpochS, tie-broken by confidence precedence. */
  readCurrent(
    sport: string,
    anchorType: string,
    asOfEpochS: number,
  ): Promise<AnchorHistoryRow | undefined>;
}

export type RawFileColumn =
  | "sha256"
  | "path"
  | "ext"
  | "bytes"
  | "file_id_serial"
  | "file_id_time_created_utc"
  | "manufacturer"
  | "product";

export class RawFileInvariantError extends Error {
  readonly sha256: string;
  readonly mismatchedColumns: readonly RawFileColumn[];
  constructor(sha256: string, mismatchedColumns: readonly RawFileColumn[]) {
    super("raw file invariant mismatch");
    this.name = "RawFileInvariantError";
    this.sha256 = sha256;
    this.mismatchedColumns = [...mismatchedColumns];
  }
}

export interface RawFileRepository {
  upsert(row: RawFileRow): Promise<boolean>;
}

export interface SourceRecordRepository {
  upsert(row: SourceRecordRow): Promise<boolean>;
}

export interface SourceArtifactDraft {
  readonly source: "intervals-icu";
  readonly lane: "activities" | "streams" | "wellness" | "settings" | "bulk-fit";
  readonly externalId: string;
  readonly artifactKind: "snapshot" | "raw_file";
  readonly archiveAddress: string;
  readonly archiveRelPath: string;
  readonly archiveEpochSeconds: number;
}

export interface GenericLandingDraft {
  readonly externalId: string;
  readonly artifactKey: string;
  readonly archiveAddress: string;
  readonly endpoint: "streams" | "settings";
  readonly normalizedPayloadJson: string;
}

export interface WellnessLandingRow {
  readonly id: string;
  readonly date_key: number;
  readonly provenance: "sync";
  readonly source: "intervals-icu";
  readonly resting_hr: number | null;
  readonly hrv: number | null;
  readonly hrv_sdnn: number | null;
  readonly sleep_s: number | null;
  readonly sleep_score: number | null;
  readonly weight_kg: number | null;
  readonly soreness: number | null;
  readonly fatigue: SubjectiveScore | null;
  readonly fields_json: string;
  readonly device_id: null;
  readonly hlc_physical_ms: null;
  readonly hlc_counter: null;
}

export interface ZoneSetHistoryRow {
  readonly id: string;
  readonly sport: string;
  readonly stream: "power" | "hr";
  readonly anchor_ref: "ftp" | "lthr";
  readonly boundaries_json: string;
  readonly valid_from: number;
  readonly source: "intervals-icu";
  readonly provenance: "sync";
  readonly device_id: null;
  readonly hlc_physical_ms: null;
  readonly hlc_counter: null;
}

export type ActivityRevisionResult =
  | {
      readonly kind: "inserted-current";
      readonly revisionId: string;
      readonly selectorChanged: true;
    }
  | { readonly kind: "exact-current"; readonly revisionId: string; readonly selectorChanged: false }
  | {
      readonly kind: "reselected-current";
      readonly revisionId: string;
      readonly selectorChanged: true;
    }
  | {
      readonly kind: "appended-current";
      readonly revisionId: string;
      readonly selectorChanged: true;
    }
  | {
      readonly kind: "hydrated-current";
      readonly revisionId: string;
      readonly selectorChanged: true;
    };

export interface ActivityRevisionDraft {
  readonly sourceRow: SourceRecordRow;
  readonly artifactKey: string;
}

export interface IntervalsSourceRepository {
  recordArtifact(
    draft: SourceArtifactDraft,
  ): Promise<{ readonly artifactKey: string; readonly inserted: boolean }>;
  recordGenericLanding(draft: GenericLandingDraft): Promise<boolean>;
  applyActivityRevision(draft: ActivityRevisionDraft): Promise<ActivityRevisionResult>;
  upsertWellness(
    row: WellnessLandingRow,
  ): Promise<"inserted" | "updated" | "unchanged" | "manual-wins">;
  insertSyncedAnchor(row: AnchorHistoryRow): Promise<boolean>;
  insertSyncedZone(row: ZoneSetHistoryRow): Promise<boolean>;
  readCurrentCaptureEvidence(
    lane: "activities" | "settings" | "streams",
    externalId: string,
  ): Promise<{
    readonly artifactKey: string;
    readonly archiveAddress: string;
    readonly archiveRelPath: string;
    readonly sourceRecordId: string;
    readonly revisionId: string;
  }>;
  assertPinnedCaptureEvidence(input: {
    readonly lane: "activities" | "settings" | "streams" | "wellness";
    readonly externalId: string;
    readonly artifactKey: string;
    readonly archiveAddress: string;
    readonly archiveRelPath: string;
    readonly currentRevision: {
      readonly sourceRecordId: string;
      readonly revisionId: string;
    } | null;
  }): Promise<void>;
}

export interface DedupConfirmationRow {
  id: string;
  member_a: string;
  member_b: string;
  verdict: "merge" | "distinct";
  device_id: string;
  hlc_physical_ms: number;
  hlc_counter: number;
}

export interface DedupConfirmationRepository {
  insertIfAbsent(row: DedupConfirmationRow): Promise<boolean>;
  readAll(): Promise<readonly DedupConfirmationRow[]>;
}

export interface IntakeFlagsRow {
  readonly id: string;
  readonly swim_skill_floor: null;
  readonly continuous_distance_capable: null;
  readonly open_water_comfort: null;
  readonly clinician_cleared: boolean | null;
  readonly injury_status: "none" | "managing" | "returning";
  readonly device_id: string;
  readonly hlc_physical_ms: number;
  readonly hlc_counter: number;
}

export interface IntakeRepository {
  replace(row: IntakeFlagsRow): Promise<void>;
  read(): Promise<IntakeFlagsRow | undefined>;
}

export interface RepairLogInsert {
  readonly rawSha256: string;
  readonly sessionKey: string;
  readonly channel: string;
  readonly fixer: RepairFixer;
  readonly changedIndices: unknown;
  readonly params: unknown;
}

export interface RepairLogRow {
  readonly repair_key: string;
  readonly raw_sha256: string;
  readonly session_key: string;
  readonly channel: string;
  readonly fixer: RepairFixer;
  readonly changed_count: number;
  readonly changed_indices_json: string;
  readonly params_json: string;
}

export interface RepairLogRepository {
  insertOrAssertIdentical(input: RepairLogInsert): Promise<void>;
}
