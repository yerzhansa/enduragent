import { canonicalJson } from "@enduragent/kernel/archive";
import type { SelectedGenericRow, SelectedSourceRow, SourceArtifactRow } from "@enduragent/kernel/ingest";
import type { ReferenceCaptureManifest, RecordRef } from "@enduragent/kernel/reference/capture";
import {
  KEEP_ALL_ACTIVITIES,
  applyActivityProjectionFilter,
  assertNoTpKeysRemain,
  assertProjectionEvidenceEqual,
  compareCanonicalUtf8,
  decodeWellnessRow,
  deriveFtpHistory,
  normalizeStreams,
  parseActivityLandingEnvelope,
  parseCanonicalProjectionValue,
  parseGenericLandingEnvelope,
  parseRenamedActivity,
  renameTpFieldsOnActivity,
  type ActivityProjectionFilter,
  type ReferenceBundle,
  type VerifiedSnapshotReader,
} from "@enduragent/kernel/reference/local-bundle";
import { AthleteSchema, type Activity, type ActivityStreams, type WellnessDay } from "@enduragent/kernel/reference/schemas";
import { mapSettingsLanding, normalizeStreamLanding } from "./landing.js";

export type { VerifiedSnapshotReader } from "@enduragent/kernel/reference/local-bundle";

export interface LocalBundleSelectedEvidence {
  readonly activities: readonly SelectedSourceRow[];
  readonly settings: readonly SelectedGenericRow[];
  readonly wellness: readonly SourceArtifactRow[];
  readonly streams: readonly SelectedGenericRow[];
}

export class ProjectionError extends Error {
  readonly code = "PROJECTION_FAILED";
  constructor() {
    super("local bundle projection failed");
    this.name = "ProjectionError";
  }
}

function objectRow(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("projection snapshot row is invalid");
  }
  return value as Record<string, unknown>;
}

function currentRevision(record: RecordRef): NonNullable<RecordRef["store_evidence"]["current_revision"]> {
  const revision = record.store_evidence.current_revision;
  if (revision === null) throw new TypeError("projection current revision is absent");
  return revision;
}

function selectedActivity(record: RecordRef, rows: readonly SelectedSourceRow[]): SelectedSourceRow {
  const revision = currentRevision(record);
  const matches = rows.filter((row) => row.id === revision.source_record_id && row.revision_id === revision.revision_id);
  if (matches.length !== 1) throw new TypeError("activity source evidence is absent or ambiguous");
  const selected = matches[0];
  if (selected.artifact_key === null || selected.archive_address === null || selected.archive_rel_path === null
    || selected.archive_epoch_s === null || selected.artifact_key !== record.store_evidence.artifact_key
    || selected.archive_address !== record.snapshot.address || selected.archive_rel_path !== record.snapshot.rel_path
    || selected.raw_sha256 !== record.snapshot.address || selected.external_id !== record.external_id) {
    throw new TypeError("activity source evidence drifted");
  }
  return selected;
}

function selectedGeneric(record: RecordRef, rows: readonly SelectedGenericRow[], label: "streams" | "settings"): SelectedGenericRow {
  const revision = currentRevision(record);
  const matches = rows.filter((row) => row.source_record_id === revision.source_record_id
    && row.revision_id === revision.revision_id);
  if (matches.length !== 1) throw new TypeError(`${label} source evidence is absent or ambiguous`);
  const selected = matches[0];
  if (selected.artifact_key !== record.store_evidence.artifact_key
    || selected.archive_address !== record.snapshot.address || selected.archive_rel_path !== record.snapshot.rel_path
    || selected.external_id !== record.external_id) throw new TypeError(`${label} source evidence drifted`);
  return selected;
}

function selectedWellness(record: RecordRef, rows: readonly SourceArtifactRow[]): SourceArtifactRow {
  if (record.store_evidence.current_revision !== null) throw new TypeError("wellness revision evidence is invalid");
  const matches = rows.filter((row) => row.artifact_key === record.store_evidence.artifact_key);
  if (matches.length !== 1) throw new TypeError("wellness source evidence is absent or ambiguous");
  const selected = matches[0];
  if (selected.archive_address !== record.snapshot.address || selected.archive_rel_path !== record.snapshot.rel_path
    || selected.external_id !== record.external_id) throw new TypeError("wellness source evidence drifted");
  return selected;
}

interface SettingCandidate {
  readonly row: Readonly<Record<string, unknown>>;
  readonly id: number;
  readonly athleteId: string;
  readonly updatedMs: number;
}

function settingCandidate(row: Readonly<Record<string, unknown>>): SettingCandidate {
  if (typeof row.id !== "number" || !Number.isSafeInteger(row.id) || row.id < 0
    || typeof row.athlete_id !== "string" || row.athlete_id.length === 0
    || !Array.isArray(row.types) || row.types.length === 0
    || row.types.some((type) => typeof type !== "string" || type.length === 0)
    || typeof row.updated !== "string" || row.updated.length === 0) throw new ProjectionError();
  const updatedMs = Date.parse(row.updated);
  if (!Number.isFinite(updatedMs) || updatedMs < 0 || !Number.isSafeInteger(updatedMs)) throw new ProjectionError();
  return { row, id: row.id, athleteId: row.athlete_id, updatedMs };
}

function supersedeSettings(rows: readonly Readonly<Record<string, unknown>>[]): ReturnType<typeof AthleteSchema.parse> {
  const candidates = rows.map(settingCandidate);
  const athleteIds = new Set(candidates.map((candidate) => candidate.athleteId));
  if (athleteIds.size > 1) throw new ProjectionError();
  const winners = new Map<string, SettingCandidate>();
  for (const candidate of candidates) {
    const key = canonicalJson([candidate.id, candidate.athleteId]);
    const current = winners.get(key);
    if (current === undefined || candidate.updatedMs > current.updatedMs
      || (candidate.updatedMs === current.updatedMs && compareCanonicalUtf8(candidate.row, current.row) > 0)) {
      winners.set(key, candidate);
    }
  }
  const ordered = [...winners.values()].sort((left, right) => left.id - right.id
    || compareCanonicalUtf8(left.row, right.row)).map((candidate) => candidate.row);
  try { return AthleteSchema.parse({ sportSettings: ordered }); }
  catch { throw new ProjectionError(); }
}

export async function decodeLocalBundleProjection(
  manifest: ReferenceCaptureManifest,
  selected: LocalBundleSelectedEvidence,
  snapshots: VerifiedSnapshotReader,
  activityFilter: ActivityProjectionFilter = KEEP_ALL_ACTIVITIES,
): Promise<ReferenceBundle> {
  for (const endpoint of manifest.endpoints) await snapshots.readVerifiedSnapshot(endpoint.snapshot);
  const verified = {
    settings: [] as unknown[], activities: [] as unknown[], wellness: [] as unknown[], streams: [] as unknown[],
  };
  for (const lane of ["settings", "activities", "wellness", "streams"] as const) {
    for (const record of manifest.records[lane]) verified[lane].push(await snapshots.readVerifiedSnapshot(record.snapshot));
  }

  const activityRecordById = new Map(manifest.records.activities.map((record, index) => [record.external_id, { record, index }]));
  const activities: Activity[] = [];
  for (const id of manifest.deterministic_order.activities) {
    const attributed = activityRecordById.get(id);
    if (attributed === undefined) throw new TypeError("activity manifest order is invalid");
    const selectedRow = selectedActivity(attributed.record, selected.activities);
    const activityEnvelope = parseActivityLandingEnvelope(selectedRow.payload_json);
    const decodedActivity = parseRenamedActivity(renameTpFieldsOnActivity(objectRow(verified.activities[attributed.index])));
    assertNoTpKeysRemain(decodedActivity);
    assertProjectionEvidenceEqual(activityEnvelope.activity, decodedActivity, "activity");
    if (String(decodedActivity.id) !== attributed.record.external_id) throw new TypeError("activity identity changed");
    activities.push(decodedActivity);
  }

  const wellness: WellnessDay[] = [];
  for (let index = 0; index < manifest.records.wellness.length; index += 1) {
    const record = manifest.records.wellness[index];
    selectedWellness(record, selected.wellness);
    const day = decodeWellnessRow(verified.wellness[index]);
    if (String(day.id) !== record.external_id) throw new TypeError("wellness identity changed");
    wellness.push(day);
  }
  const ftpHistory = deriveFtpHistory(wellness);

  if (canonicalJson(manifest.records.streams.map((record) => record.external_id.slice("streams:".length)))
    !== canonicalJson(manifest.captured_stream_ids)
    || canonicalJson(manifest.deterministic_order.streams) !== canonicalJson(manifest.captured_stream_ids)) {
    throw new TypeError("stream manifest order is invalid");
  }
  const streams: Record<string, ActivityStreams> = {};
  for (let index = 0; index < manifest.records.streams.length; index += 1) {
    const record = manifest.records.streams[index];
    const selectedRow = selectedGeneric(record, selected.streams, "streams");
    const streamEnvelope = parseGenericLandingEnvelope(selectedRow.payload_json, "streams");
    const normalized = normalizeStreams(verified.streams[index]);
    const streamLanding = normalizeStreamLanding(objectRow(normalized));
    assertNoTpKeysRemain(streamLanding);
    assertProjectionEvidenceEqual(streamEnvelope.landing, streamLanding, "streams");
    const activityId = manifest.captured_stream_ids[index];
    if (record.external_id !== `streams:${activityId}`) throw new TypeError("stream identity changed");
    streams[activityId] = streamLanding as ActivityStreams;
  }

  const decodedSettings: Readonly<Record<string, unknown>>[] = [];
  for (let index = 0; index < manifest.records.settings.length; index += 1) {
    const record = manifest.records.settings[index];
    const selectedRow = selectedGeneric(record, selected.settings, "settings");
    const settingEnvelope = parseGenericLandingEnvelope(selectedRow.payload_json, "settings");
    const decodedSetting = objectRow(verified.settings[index]);
    assertNoTpKeysRemain(decodedSetting);
    settingCandidate(decodedSetting);
    const mappedDecodedSetting = await mapSettingsLanding(decodedSetting);
    const decodedSettingValue = parseCanonicalProjectionValue(
      mappedDecodedSetting.normalizedPayloadJson, "settings",
    );
    assertProjectionEvidenceEqual(settingEnvelope.landing, decodedSettingValue, "settings");
    settingCandidate(decodedSettingValue);
    if (mappedDecodedSetting.sourceRecordExternalId !== record.external_id) throw new TypeError("settings identity changed");
    decodedSettings.push(decodedSettingValue);
  }
  const athlete = supersedeSettings(decodedSettings);

  return applyActivityProjectionFilter({ activities, wellness, ftpHistory, streams, athlete }, activityFilter);
}
