import { canonicalJson, type ArchiveInstant, type ArchiveWriteResult } from "@enduragent/kernel/archive";
import { buildPlatformPresentation, type ConcernValue, type PlatformImportArtifact } from "@enduragent/kernel/ingest";
import type { CryptoPort } from "@enduragent/kernel/ports";
import { SPORT_FAMILIES } from "@enduragent/kernel/reference/metrics";
import { decodeWellnessRow, RowRejection, type NormalizedWellnessFields } from "@enduragent/kernel/reference/local-bundle";
import { WellnessColumnsSchema, type SubjectiveScore, type WellnessDay } from "@enduragent/kernel/reference/schemas";
import { H, sortKeys, type AnchorHistoryRow, type WellnessLandingRow, type ZoneSetHistoryRow } from "@enduragent/kernel/store";
import { civilDateEpochSeconds, compareBinary, isCivilDate, parseCivilDate } from "./cursor.js";

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  return value as Record<string, unknown>;
}

function nonempty(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} is invalid`);
  return value;
}

function safeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function finiteNonnegative(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || Object.is(value, -0)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function externalId(value: unknown): string {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value) && Number.isSafeInteger(value) && !Object.is(value, -0)) return String(value);
  throw new TypeError("activity id is invalid");
}

function startEpoch(value: unknown, name: string): number {
  const text = nonempty(value, name);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds % 1_000 !== 0) throw new TypeError(`${name} is invalid`);
  const seconds = milliseconds / 1_000;
  if (!Number.isSafeInteger(seconds)) throw new TypeError(`${name} is invalid`);
  return seconds;
}

function dateKey(value: unknown, name: string): number {
  const text = nonempty(value, name).slice(0, 10);
  parseCivilDate(text);
  return Number(text.replaceAll("-", ""));
}

const webCrypto = {
  async sha256(data: Uint8Array): Promise<Uint8Array> {
    const copy = new Uint8Array(data.byteLength); copy.set(data);
    return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", copy));
  },
} as CryptoPort;
const hash = (...fields: readonly [string | number, ...(string | number)[]]): Promise<string> => H(webCrypto, ...fields);
const compactCanonical = (value: unknown): string => JSON.stringify(sortKeys(value));

export async function mapActivityLanding(options: {
  readonly normalized: Readonly<Record<string, unknown>>;
  readonly archiveInstant: ArchiveInstant;
  readonly archive: ArchiveWriteResult;
}): Promise<PlatformImportArtifact> {
  const activity = record(options.normalized, "activity");
  const id = externalId(activity.id);
  const start_utc = startEpoch(activity.start_date, "activity start");
  const local_date_key = dateKey(activity.start_date_local, "activity local start");
  const type = nonempty(activity.type, "activity type");
  const moving = safeInteger(activity.moving_time, "activity moving time");
  const duration = safeInteger(activity.elapsed_time, "activity elapsed time");
  const distance = activity.distance === undefined || activity.distance === null
    ? null : finiteNonnegative(activity.distance, "activity distance");
  const sport = Object.hasOwn(SPORT_FAMILIES, type) ? SPORT_FAMILIES[type]! : "other";
  const normalizedActivityJson = canonicalJson(activity);
  const summaryJson = compactCanonical(activity);
  const concerns: Record<string, ConcernValue> = {
    "session.sport": sport,
    "session.start_utc": start_utc,
    "session.local_date_key": local_date_key,
    "session.elapsed_s": duration,
    "session.moving_s": moving,
    "session.is_transition": type === "Transition",
    "session.summary_json": summaryJson,
    "stream:time": duration > 0
      ? { timestamps: [start_utc, start_utc + duration], values: [start_utc, start_utc + duration] }
      : { timestamps: [start_utc], values: [start_utc] },
  };
  if (distance !== null) concerns["session.distance_m"] = distance;
  const platform: PlatformImportArtifact = {
    source: "intervals-icu",
    activity_id: id,
    activity,
    dedup: { sport_family: sport, is_transition: type === "Transition", start_utc, duration_s: duration, distance_m: distance },
    concerns,
    raw_snapshot_address: options.archive.address,
    raw_snapshot_rel_path: options.archive.relPath,
    sourceEvidence: { source: "intervals-icu", lane: "activities", externalId: id,
      archiveInstant: options.archiveInstant, archive: options.archive, normalizedActivityJson },
  };
  await buildPlatformPresentation(platform, (fields) => hash(...fields as [string | number, ...(string | number)[]]));
  return platform;
}

type WellnessLoadAverages = Readonly<Required<NormalizedWellnessFields>>;

interface WellnessFieldArchive {
  readonly source: "intervals-icu";
  readonly subjectiveFatigue: SubjectiveScore | null;
  readonly load: WellnessLoadAverages;
  readonly values: Readonly<Record<string, unknown>>;
}

export interface WellnessLanding {
  readonly externalId: string;
  readonly instant: ArchiveInstant;
  readonly cursorKey: string;
  readonly wire: Readonly<Record<string, unknown>>;
  readonly row: WellnessLandingRow;
}

function wellnessFieldArchive(day: WellnessDay, subjectiveFatigue: SubjectiveScore | null): WellnessFieldArchive {
  const load: WellnessLoadAverages = {
    fitness: day.fitness ?? null,
    fatigue: day.fatigue ?? null,
    fitnessContribution: day.fitnessContribution ?? null,
    fatigueContribution: day.fatigueContribution ?? null,
    weeklyFitnessChange: day.weeklyFitnessChange ?? null,
  };
  const values = Object.fromEntries(Object.entries(day)
    .filter(([key]) => !Object.hasOwn(load, key) && key !== "subjectiveFatigue"));
  return { source: "intervals-icu", subjectiveFatigue, load, values };
}

async function mapWellnessLanding(day: WellnessDay, dateKey: number): Promise<WellnessLandingRow> {
  const parsed = WellnessColumnsSchema.safeParse(day);
  if (!parsed.success) throw new RowRejection("landing", parsed.error.issues[0]?.path.join(".") ?? null);
  const columns = parsed.data;
  const subjectiveFatigue = columns.subjectiveFatigue ?? null;
  return {
    id: await hash("wellness", dateKey, "intervals-icu"),
    date_key: dateKey,
    provenance: "sync",
    source: "intervals-icu",
    resting_hr: columns.restingHR ?? null,
    hrv: columns.hrv ?? null,
    hrv_sdnn: columns.hrvSDNN ?? null,
    sleep_s: columns.sleepSecs ?? null,
    sleep_score: columns.sleepQuality ?? null,
    weight_kg: columns.weight ?? null,
    soreness: columns.soreness ?? null,
    fatigue: subjectiveFatigue,
    fields_json: canonicalJson(wellnessFieldArchive(day, subjectiveFatigue)),
    device_id: null,
    hlc_physical_ms: null,
    hlc_counter: null,
  };
}

function isWireRow(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function landWellnessRow(payload: unknown): Promise<WellnessLanding> {
  if (!isWireRow(payload)) throw new RowRejection("shape");
  const date = payload.id;
  if (!isCivilDate(date)) throw new RowRejection("identity", "id");
  return {
    externalId: date,
    instant: { epochSeconds: civilDateEpochSeconds(date) },
    cursorKey: `${date}\u001f${date}`,
    wire: payload,
    row: await mapWellnessLanding(decodeWellnessRow(payload), Number(date.replaceAll("-", ""))),
  };
}

export function normalizeStreamLanding(normalized: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const source = record(normalized, "streams");
  const result: Record<string, unknown> = {};
  let length: number | null = null;
  for (const key of ["time", "watts", "heartrate", "dfa_a1", "artifacts"] as const) {
    if (!Object.hasOwn(source, key)) continue;
    const channel = source[key];
    if (!Array.isArray(channel) || channel.some((sample) => sample !== null
      && (typeof sample !== "number" || !Number.isFinite(sample)))) throw new TypeError("stream channel is invalid");
    if (length === null) length = channel.length;
    else if (channel.length !== length) throw new TypeError("stream channel lengths differ");
    result[key] = [...channel];
  }
  return Object.freeze(result);
}

function optionalPositive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function zones(value: unknown): readonly number[] | null {
  return Array.isArray(value) && value.length >= 2
    && value.every((entry) => typeof entry === "number" && Number.isFinite(entry) && entry >= 0)
    ? value as number[] : null;
}

function zoneNames(value: unknown, length: number): readonly string[] | null {
  return Array.isArray(value) && value.length === length
    && value.every((entry) => typeof entry === "string" && entry.length > 0) ? value as string[] : null;
}

export interface SettingsLanding {
  readonly externalId: string;
  readonly sourceRecordExternalId: string;
  readonly normalizedPayloadJson: string;
  readonly archiveEpochSeconds: number;
  readonly anchors: readonly AnchorHistoryRow[];
  readonly zones: readonly ZoneSetHistoryRow[];
}

export async function mapSettingsLanding(normalized: Readonly<Record<string, unknown>>): Promise<SettingsLanding> {
  const setting = record(normalized, "sport setting");
  if (typeof setting.id !== "number" || !Number.isSafeInteger(setting.id)) throw new TypeError("sport setting id is invalid");
  const athleteId = nonempty(setting.athlete_id, "sport setting athlete id");
  if (!Array.isArray(setting.types) || setting.types.length === 0
    || setting.types.some((type) => typeof type !== "string" || type.length === 0)) throw new TypeError("sport setting types are invalid");
  const types = setting.types as string[];
  const updated = nonempty(setting.updated, "sport setting update");
  const externalId = canonicalJson([setting.id, athleteId, types, updated]);
  const updatedMs = Date.parse(updated);
  const validFrom = Number.isFinite(updatedMs) && updatedMs >= 0 && updatedMs % 1_000 === 0
    && Number.isSafeInteger(updatedMs / 1_000) ? updatedMs / 1_000 : null;
  const families = [...new Set(types.filter((type) => Object.hasOwn(SPORT_FAMILIES, type)).map((type) => SPORT_FAMILIES[type]!))]
    .sort();
  const anchors: AnchorHistoryRow[] = [];
  const zoneRows: ZoneSetHistoryRow[] = [];
  if (validFrom !== null) for (const family of families) {
    const anchorValues = [
      ["ftp", "W", family === "cycling" ? optionalPositive(setting.ftp) : null],
      ["lthr", "bpm", optionalPositive(setting.lthr)],
      ["max_hr", "bpm", optionalPositive(setting.max_hr)],
    ] as const;
    for (const [anchorType, unit, value] of anchorValues) if (value !== null) anchors.push({
      id: await hash("anchor_history", "intervals-icu", externalId, family, anchorType), sport: family,
      anchor_type: anchorType, value, unit, valid_from: validFrom, source: "intervals-icu", confidence: "platform",
      note: null, provenance: "sync", device_id: null, hlc_physical_ms: null, hlc_counter: null,
    });
    for (const [stream, anchorRef, values, names] of [
      ["power", "ftp", zones(setting.power_zones), setting.power_zone_names],
      ["hr", "lthr", zones(setting.hr_zones), setting.hr_zone_names],
    ] as const) if (values !== null) zoneRows.push({
      id: await hash("zone_set_history", "intervals-icu", externalId, family, stream), sport: family,
      stream, anchor_ref: anchorRef, boundaries_json: canonicalJson({ boundaries: values, names: zoneNames(names, values.length) }),
      valid_from: validFrom, source: "intervals-icu", provenance: "sync", device_id: null,
      hlc_physical_ms: null, hlc_counter: null,
    });
  }
  anchors.sort((a, b) => compareBinary(a.sport, b.sport) || compareBinary(a.anchor_type, b.anchor_type));
  zoneRows.sort((a, b) => compareBinary(a.sport, b.sport) || compareBinary(a.stream, b.stream));
  return { externalId, sourceRecordExternalId: `settings:${externalId}`, normalizedPayloadJson: canonicalJson(setting),
    archiveEpochSeconds: validFrom ?? 0, anchors, zones: zoneRows };
}

export function activityIdentity(row: Readonly<Record<string, unknown>>): { readonly externalId: string; readonly startUtc: number; readonly localDate: string; readonly key: string } {
  const id = externalId(row.id);
  const localDate = nonempty(row.start_date_local, "activity local start").slice(0, 10);
  parseCivilDate(localDate);
  return { externalId: id, startUtc: startEpoch(row.start_date, "activity start"), localDate, key: `${localDate}\u001f${id}` };
}
