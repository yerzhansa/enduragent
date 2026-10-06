import { canonicalJson, type ArchiveInstant, type ArchiveWriteResult } from "@enduragent/kernel/archive";
import type { HttpRequest, HttpResponse } from "@enduragent/kernel/ports";
import {
  REFERENCE_CAPTURE_STREAM_TYPES,
  selectReferenceCaptureStreamIds,
  validateReferenceCapturePlan,
  type DerivedCaptureMember,
  type DerivedCaptureMembers,
  type ReferenceCaptureEndpointPayload,
  type ReferenceCapturePlan,
} from "@enduragent/kernel/reference/capture";
import {
  assertProjectionEvidenceEqual,
  parseCanonicalProjectionValue,
} from "@enduragent/kernel/reference/local-bundle";
import type { SourceLane, SourceWatermark, SyncBudget } from "@enduragent/kernel/store";
import { activityIdentity, mapActivityLanding, mapSettingsLanding, mapWellnessLanding, normalizeStreamLanding } from "./landing.js";
import { advanceWindow, compactCursor, compareBinary, parseCivilDate, parseCursor, type CursorRange, type RangeCursor } from "./cursor.js";
import { createRequester, IntervalsHttpError, MIN_CONFIGURED_INTERVAL_MS, SyncBudgetExceededError, type IntervalsRequester } from "./http.js";
import { BULK_FIT_BATCH_SIZE, BULK_SAFE_ACTIVITY_ID, IncompleteBulkFitBatchError, MAX_FIT_BYTES, MAX_ZIP_BYTES, extractBulkFitZip } from "./zip.js";
import { INTERVALS_ICU_CAPABILITIES, INTERVALS_ICU_SOURCE_ID, MAX_JSON_BYTES, ZERO_DROPPED_ACTIVITY_ROWS, type DroppedActivityRowEvidence, type IntervalsIcuArtifact, type IntervalsIcuCaptureSource, type IntervalsIcuCheckpoint, type IntervalsIcuSourceOptions, type ReferenceCaptureActivityRecord, type ReferenceCaptureBatch, type ReferenceCaptureEndpoint, type ReferenceCaptureSettingsRecord, type ReferenceCaptureStreamRecord, type ReferenceCaptureWellnessRecord } from "./types.js";

const BASE_URL = "https://intervals.icu";
const JSON_TYPE = "application/json";
const ZIP_TYPE = "application/zip";

function nonempty(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} is invalid`);
  return value;
}

function objectRow(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} is invalid`);
  return value as Record<string, unknown>;
}

function epochForDate(date: string): number {
  parseCivilDate(date);
  return Math.max(0, Date.parse(`${date}T00:00:00.000Z`) / 1_000);
}

function baseContentType(response: HttpResponse): string {
  return (response.headers["content-type"] ?? "").split(";", 1)[0]!.trim().toLowerCase();
}

function parseJsonResponse(response: HttpResponse): unknown {
  if (response.status !== 200 || baseContentType(response) !== JSON_TYPE) throw new TypeError("intervals.icu JSON response is invalid");
  if (response.body.byteLength > MAX_JSON_BYTES) throw new TypeError("intervals.icu JSON response is too large");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(response.body); }
  catch { throw new TypeError("intervals.icu JSON encoding is invalid"); }
  try { return JSON.parse(text); }
  catch { throw new TypeError("intervals.icu JSON response is invalid"); }
}

function endpointUrl(path: string, params: readonly (readonly [string, string])[] = []): string {
  const url = new URL(path, BASE_URL);
  for (const [key, value] of params) url.searchParams.append(key, value);
  return url.toString();
}

function rangeUrl(athleteId: string, endpoint: "activities" | "wellness", cursor: RangeCursor): string {
  return endpointUrl(`/api/v1/athlete/${encodeURIComponent(athleteId)}/${endpoint}`,
    [["oldest", cursor.requestStart ?? cursor.window_start], ["newest", cursor.window_end]]);
}

interface ActivityIndexEntry extends ReturnType<typeof activityIdentity> {
  readonly row: Record<string, unknown>;
}

const SOURCE_RESTRICTED_PROVIDER = "STRAVA";

function isSourceRestrictedRow(entry: unknown): boolean {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
  return (entry as Record<string, unknown>).source === SOURCE_RESTRICTED_PROVIDER;
}

class DropTally {
  private restricted = 0;
  private rest = 0;
  private readonly dates = new Set<string>();
  private undated = 0;
  record(entry: unknown): void {
    if (isSourceRestrictedRow(entry)) this.restricted += 1;
    else this.rest += 1;
    const local =
      entry !== null && typeof entry === "object" && !Array.isArray(entry)
        ? (entry as Record<string, unknown>).start_date_local
        : undefined;
    if (typeof local === "string") {
      try {
        this.dates.add(parseCivilDate(local.slice(0, 10)));
        return;
      } catch {}
    }
    this.undated += 1;
  }
  evidence(): DroppedActivityRowEvidence {
    return Object.freeze({
      sourceRestricted: this.restricted,
      other: this.rest,
      datedLocalDates: Object.freeze([...this.dates].sort(compareBinary)),
      undatedCount: this.undated,
    });
  }
}

interface ActivityScan {
  readonly rows: readonly ActivityIndexEntry[];
  readonly dropped: DroppedActivityRowEvidence;
}

function activityIndex(value: unknown): ActivityScan {
  if (!Array.isArray(value)) throw new TypeError("activities response is invalid");
  const rows: ActivityIndexEntry[] = [];
  const tally = new DropTally();
  for (const entry of value) {
    const row = objectRow(entry, "activity row");
    const type = row.type;
    if (typeof type !== "string" || type.length === 0) { tally.record(row); continue; }
    for (const [field, label] of [["moving_time", "moving time"], ["elapsed_time", "elapsed time"]] as const) {
      const item = row[field];
      if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0) throw new TypeError(`activity ${label} is invalid`);
    }
    rows.push({ ...activityIdentity(row), row });
  }
  rows.sort((a, b) => compareBinary(a.key, b.key));
  return { rows, dropped: tally.evidence() };
}

function checkpoint(lane: SourceLane, cursor: RangeCursor, droppedActivityRows: DroppedActivityRowEvidence): IntervalsIcuCheckpoint {
  return { kind: "checkpoint", watermark: { source: "intervals-icu", lane, value: compactCursor(cursor) }, droppedActivityRows };
}

function nextCursor(cursor: RangeCursor, range: CursorRange, remaining: number, processedKey: string | null): RangeCursor {
  if (remaining > 0) return { ...cursor, last_key: processedKey };
  return advanceWindow({ ...cursor, last_key: processedKey }, range);
}

async function fetchJson(requester: IntervalsRequester, endpoint: Parameters<IntervalsRequester["request"]>[0], request: HttpRequest): Promise<unknown> {
  return parseJsonResponse(await requester.request(endpoint, request));
}

function rowInstant(epochSeconds: number): ArchiveInstant {
  return { epochSeconds };
}

function wellnessIdentity(row: Record<string, unknown>): { readonly id: string; readonly key: string; readonly instant: ArchiveInstant } {
  const id = parseCivilDate(row.id);
  return { id, key: `${id}\u001f${id}`, instant: rowInstant(epochForDate(id)) };
}

function settingsIdentity(row: Record<string, unknown>): string {
  if (typeof row.id !== "number" || !Number.isSafeInteger(row.id)) throw new TypeError("sport setting id is invalid");
  const athleteId = nonempty(row.athlete_id, "sport setting athlete id");
  if (!Array.isArray(row.types) || row.types.length === 0
    || row.types.some((type) => typeof type !== "string" || type.length === 0)) throw new TypeError("sport setting types are invalid");
  return canonicalJson([row.id, athleteId, row.types, nonempty(row.updated, "sport setting update")]);
}

function settingEpoch(row: Record<string, unknown>): number {
  const milliseconds = typeof row.updated === "string" ? Date.parse(row.updated) : Number.NaN;
  return Number.isFinite(milliseconds) && milliseconds >= 0 && milliseconds % 1_000 === 0
    && Number.isSafeInteger(milliseconds / 1_000) ? milliseconds / 1_000 : 0;
}

function streamUrl(activityId: string): string {
  return endpointUrl(`/api/v1/activity/${encodeURIComponent(activityId)}/streams.json`, [
    ["types", "time"], ["types", "watts"], ["types", "heartrate"], ["types", "dfa_a1"],
    ["types", "artifacts"], ["includeDefaults", "false"],
  ]);
}

function bulkUrl(athleteId: string, ids: readonly string[]): string {
  return endpointUrl(`/api/v1/athlete/${encodeURIComponent(athleteId)}/download-fit-files`, [
    ["power", "true"], ["hr", "true"], ...ids.map((id) => ["ids", id] as const),
  ]);
}

function fitUrl(activityId: string): string {
  return endpointUrl(`/api/v1/activity/${encodeURIComponent(activityId)}/fit-file`);
}

interface FitReady {
  readonly activityId: string;
  readonly startUtc: number;
  readonly bytes: Uint8Array;
  readonly archive: ArchiveWriteResult;
}

export function createIntervalsIcuSource(options: IntervalsIcuSourceOptions): IntervalsIcuCaptureSource {
  const athleteId = nonempty(options.athleteId, "athlete id");
  const range: CursorRange = {
    oldest: parseCivilDate(options.historyOldestDate ?? "1900-01-01"),
    newest: parseCivilDate(options.historyNewestDate),
  };
  if (compareBinary(range.oldest, range.newest) > 0) throw new TypeError("history range is invalid");
  if (!Number.isSafeInteger(options.minRequestIntervalMs) || options.minRequestIntervalMs < MIN_CONFIGURED_INTERVAL_MS) {
    throw new TypeError("minimum request interval is invalid");
  }

  async function* pull(watermark: SourceWatermark, budget: SyncBudget): AsyncGenerator<IntervalsIcuArtifact> {
    if (watermark.source !== "intervals-icu") throw new TypeError("source watermark does not belong to intervals.icu");
    if (!["activities", "streams", "wellness", "settings", "bulk-fit"].includes(watermark.lane)) {
      throw new TypeError("source lane is unsupported");
    }
    const lane = watermark.lane as "activities" | "streams" | "wellness" | "settings" | "bulk-fit";
    const cursor = parseCursor(watermark.value, lane, range);
    const requester = createRequester({
      http: options.httpFactory({ outer: budget.signal, perRequestTimeoutMs: budget.perRequestTimeoutMs }),
      budget,
      minRequestIntervalMs: options.minRequestIntervalMs,
      wallClock: options.wallClock,
      sleep: options.sleep,
      attemptLedger: options.attemptLedger,
    });
    let yielded = 0;
    const beforeYield = (): void => {
      requester.assertActive();
      if (yielded >= budget.maxArtifacts) throw new Error("artifact yield exceeds validated budget");
      yielded += 1;
    };
    const yieldCheckpoint = async function* (value: RangeCursor,
      dropped: DroppedActivityRowEvidence = ZERO_DROPPED_ACTIVITY_ROWS): AsyncGenerator<IntervalsIcuArtifact> {
      requester.assertActive();
      yield checkpoint(lane, value, dropped);
    };

    if (lane === "bulk-fit" && cursor.complete) {
      yield* yieldCheckpoint(cursor);
      return;
    }
    if (!requester.canRequest()) {
      yield* yieldCheckpoint(cursor);
      return;
    }

    if (lane === "activities" || lane === "wellness") {
      const transport = await fetchJson(requester, lane, { method: "GET", url: rangeUrl(athleteId, lane, cursor) });
      await options.archive.writeSnapshot(transport, rowInstant(epochForDate(cursor.requestStart ?? cursor.window_start)));
      if (!Array.isArray(transport)) throw new TypeError(`${lane} response is invalid`);
      const scan = lane === "activities" ? activityIndex(transport) : null;
      const indexed = scan !== null ? [...scan.rows] : transport.map((entry) => {
        const row = objectRow(entry, "wellness row"), identity = wellnessIdentity(row);
        return { externalId: identity.id, startUtc: identity.instant.epochSeconds, localDate: identity.id, key: identity.key, row };
      }).sort((a, b) => compareBinary(a.key, b.key));
      const droppedRows =
        scan === null || cursor.last_key !== null ? ZERO_DROPPED_ACTIVITY_ROWS : scan.dropped;
      const remaining = indexed.filter((entry) => cursor.last_key === null || compareBinary(entry.key, cursor.last_key) > 0);
      let processedKey = cursor.last_key;
      let processed = 0;
      for (const entry of remaining) {
        if (yielded >= budget.maxArtifacts) break;
        const instant = rowInstant(entry.startUtc);
        const archive = await options.archive.writeSnapshot(entry.row, instant);
        const landingCopy = structuredClone(entry.row);
        if (lane === "activities") {
          const normalized = options.acl.activity(landingCopy);
          options.acl.assertClean(normalized);
          const platform = await mapActivityLanding({ normalized, archiveInstant: instant, archive });
          beforeYield();
          yield { kind: "snapshot", source: "intervals-icu", lane: "activities", externalId: entry.externalId,
            archiveInstant: instant, archive, payload: entry.row, landing: { kind: "activity", platform } };
        } else {
          const normalized = options.acl.wellness(landingCopy);
          options.acl.assertClean(normalized);
          const row = await mapWellnessLanding(normalized);
          if (row.date_key !== Number(entry.externalId.replaceAll("-", ""))) throw new TypeError("wellness identity changed during normalization");
          beforeYield();
          yield { kind: "snapshot", source: "intervals-icu", lane: "wellness", externalId: entry.externalId,
            archiveInstant: instant, archive, payload: entry.row, landing: { kind: "wellness", row } };
        }
        processed += 1;
        processedKey = entry.key;
      }
      yield* yieldCheckpoint(nextCursor(cursor, range, remaining.length - processed, processedKey), droppedRows);
      return;
    }

    if (lane === "settings") {
      const transport = await fetchJson(requester, "settings", { method: "GET",
        url: endpointUrl(`/api/v1/athlete/${encodeURIComponent(athleteId)}`) });
      await options.archive.writeSnapshot(transport, rowInstant(epochForDate(range.newest)));
      const profile = objectRow(transport, "athlete settings");
      const sourceSettings = profile.sportSettings === undefined ? [] : profile.sportSettings;
      if (!Array.isArray(sourceSettings)) throw new TypeError("sport settings response is invalid");
      const indexed = sourceSettings.map((entry) => {
        const row = objectRow(entry, "sport setting");
        const externalId = settingsIdentity(row);
        return { row, externalId, key: externalId };
      }).sort((a, b) => compareBinary(a.key, b.key));
      const remaining = indexed.filter((entry) => cursor.last_key === null || compareBinary(entry.key, cursor.last_key) > 0);
      let processedKey = cursor.last_key, processed = 0;
      for (const entry of remaining) {
        if (yielded >= budget.maxArtifacts) break;
        const instant = rowInstant(settingEpoch(entry.row));
        const archive = await options.archive.writeSnapshot(entry.row, instant);
        const normalizedSetting = structuredClone(entry.row);
        options.acl.assertClean(normalizedSetting);
        const mappedSetting = await mapSettingsLanding(normalizedSetting);
        assertProjectionEvidenceEqual(
          parseCanonicalProjectionValue(mappedSetting.normalizedPayloadJson, "settings"),
          normalizedSetting, "settings",
        );
        if (mappedSetting.externalId !== entry.externalId) throw new TypeError("sport setting identity changed during normalization");
        beforeYield();
        yield { kind: "snapshot", source: "intervals-icu", lane: "settings",
          externalId: mappedSetting.sourceRecordExternalId, archiveInstant: instant, archive, payload: entry.row,
          landing: { kind: "settings", sourceRecordExternalId: mappedSetting.sourceRecordExternalId,
            normalizedPayloadJson: mappedSetting.normalizedPayloadJson, anchors: mappedSetting.anchors, zones: mappedSetting.zones } };
        processed += 1; processedKey = entry.key;
      }
      const next = remaining.length === processed ? { ...cursor, last_key: null, complete: true }
        : { ...cursor, last_key: processedKey };
      yield* yieldCheckpoint(next);
      return;
    }

    const activityTransport = await fetchJson(requester, "activities", { method: "GET", url: rangeUrl(athleteId, "activities", cursor) });
    await options.archive.writeSnapshot(activityTransport, rowInstant(epochForDate(cursor.requestStart ?? cursor.window_start)));
    const activityScan = activityIndex(activityTransport);
    const droppedRows =
      cursor.last_key === null ? activityScan.dropped : ZERO_DROPPED_ACTIVITY_ROWS;
    const remaining = activityScan.rows.filter((entry) => cursor.last_key === null || compareBinary(entry.key, cursor.last_key) > 0);
    let processedKey = cursor.last_key, processed = 0;

    if (lane === "streams") {
      for (const activity of remaining) {
        if (yielded >= budget.maxArtifacts || !requester.canRequest()) break;
        let transport: unknown;
        try {
          transport = await fetchJson(requester, "streams", { method: "GET", url: streamUrl(activity.externalId) });
        } catch (error) {
          if (error instanceof IntervalsHttpError && error.status === 404) {
            processed += 1; processedKey = activity.key; continue;
          }
          throw error;
        }
        const instant = rowInstant(activity.startUtc);
        const archive = await options.archive.writeSnapshot(transport, instant);
        const landingCopy = structuredClone(transport);
        const normalized = options.acl.streams(landingCopy);
        options.acl.assertClean(normalized);
        const streamLanding = normalizeStreamLanding(normalized);
        const normalizedPayloadJson = canonicalJson(streamLanding);
        assertProjectionEvidenceEqual(
          parseCanonicalProjectionValue(normalizedPayloadJson, "streams"),
          streamLanding, "streams",
        );
        const externalId = `streams:${activity.externalId}`;
        beforeYield();
        yield { kind: "snapshot", source: "intervals-icu", lane: "streams", externalId,
          archiveInstant: instant, archive, payload: transport,
          landing: { kind: "streams", sourceRecordExternalId: externalId,
            normalizedPayloadJson } };
        processed += 1; processedKey = activity.key;
      }
      yield* yieldCheckpoint(nextCursor(cursor, range, remaining.length - processed, processedKey), droppedRows);
      return;
    }

    let offset = 0;
    bulkLoop: while (offset < remaining.length) {
      const first = remaining[offset]!;
      const safe = BULK_SAFE_ACTIVITY_ID.test(first.externalId);
      const group = safe
        ? remaining.slice(offset, offset + BULK_FIT_BATCH_SIZE).filter((entry, index, values) => index === 0
          || values.slice(0, index).every((prior) => BULK_SAFE_ACTIVITY_ID.test(prior.externalId)))
          .filter((entry) => BULK_SAFE_ACTIVITY_ID.test(entry.externalId))
        : [first];
      if (yielded + group.length > budget.maxArtifacts) break;
      if (!requester.canRequest()) break;
      const starts = new Map(group.map((entry) => [entry.externalId, entry.startUtc]));
      const requestedIds = group.map((entry) => entry.externalId).sort(compareBinary);
      let container: { readonly externalId: string; readonly archiveInstant: ArchiveInstant; readonly archive: ArchiveWriteResult } | null = null;
      let bytesById: ReadonlyMap<string, Uint8Array>;
      if (safe) {
        try {
          const response = await requester.request("bulk-fit", { method: "POST", url: bulkUrl(athleteId, requestedIds) });
          if (response.status !== 200 || baseContentType(response) !== ZIP_TYPE || response.body.byteLength === 0
            || response.body.byteLength > MAX_ZIP_BYTES) throw new TypeError("bulk FIT ZIP response is invalid");
          const archiveInstant = rowInstant(Math.min(...group.map((entry) => entry.startUtc)));
          const archive = await options.archive.writeArtifact(response.body, "zip", archiveInstant);
          container = { externalId: `batch:${canonicalJson(requestedIds)}`, archiveInstant, archive };
          const entries = extractBulkFitZip(response.body, requestedIds);
          bytesById = new Map(entries.map((entry) => [entry.activityId, entry.bytes]));
        } catch (error) {
          if (!(error instanceof IntervalsHttpError) || (error.status !== 404 && error.status !== 405)) throw error;
          if (!requester.canRequest(requestedIds.length)) break bulkLoop;
          const fallback = new Map<string, Uint8Array>();
          const returned: string[] = [];
          for (const id of requestedIds) {
            try {
              const response = await requester.request("fit-file", { method: "GET", url: fitUrl(id) });
              if (response.status !== 200 || response.body.byteLength === 0 || response.body.byteLength > MAX_FIT_BYTES) {
                throw new TypeError("fallback FIT response is invalid");
              }
              fallback.set(id, new Uint8Array(response.body)); returned.push(id);
            } catch (fallbackError) {
              if (fallbackError instanceof IntervalsHttpError && fallbackError.status === 404) continue;
              throw fallbackError;
            }
          }
          const missing = requestedIds.filter((id) => !fallback.has(id));
          if (missing.length > 0) throw new IncompleteBulkFitBatchError({ requested: requestedIds,
            returned, missing, unexpected: [] });
          bytesById = fallback;
        }
      } else {
        const response = await requester.request("fit-file", { method: "GET", url: fitUrl(first.externalId) });
        if (response.status !== 200 || response.body.byteLength === 0 || response.body.byteLength > MAX_FIT_BYTES) {
          throw new TypeError("fallback FIT response is invalid");
        }
        bytesById = new Map([[first.externalId, new Uint8Array(response.body)]]);
      }
      const ready: FitReady[] = [];
      for (const id of requestedIds) {
        const bytes = bytesById.get(id);
        const startUtc = starts.get(id);
        if (bytes === undefined || startUtc === undefined) throw new Error("complete FIT batch attribution is invalid");
        const archive = await options.archive.writeArtifact(bytes, "fit", rowInstant(startUtc));
        ready.push({ activityId: id, startUtc, bytes, archive });
      }
      for (const entry of ready) {
        beforeYield();
        yield { kind: "raw-file", source: "intervals-icu", lane: "bulk-fit", externalId: entry.activityId,
          archiveInstant: rowInstant(entry.startUtc), archive: entry.archive,
          file: { input_path: `intervals-icu/${encodeURIComponent(entry.activityId)}.fit`, ext: "fit", bytes: entry.bytes },
          container };
      }
      processed += group.length;
      processedKey = group[group.length - 1]!.key;
      offset += group.length;
    }
    yield* yieldCheckpoint(nextCursor(cursor, range, remaining.length - processed, processedKey), droppedRows);
  }

  let capturedActivityDrops: DroppedActivityRowEvidence = ZERO_DROPPED_ACTIVITY_ROWS;

  const placeholderArchive: ArchiveWriteResult = Object.freeze({
    address: "0".repeat(64),
    relPath: `1970/01/${"0".repeat(64)}.json.gz`,
    deduped: false,
  });

  async function deriveStreamMember(endpoint: ReferenceCaptureEndpointPayload): Promise<DerivedCaptureMember | null> {
    try {
      if (endpoint.lane !== "streams" || endpoint.endpoint !== "activity-streams"
        || endpoint.request.activity_id === null) throw new TypeError("stream endpoint is invalid");
      const normalized = options.acl.streams(structuredClone(endpoint.payload));
      options.acl.assertClean(normalized);
      normalizeStreamLanding(normalized);
      return { endpoint_ordinal: endpoint.ordinal, payload_index: null,
        external_id: `streams:${endpoint.request.activity_id}`, payload: endpoint.payload };
    } catch {
      return null;
    }
  }

  async function deriveReferenceCaptureMembers(
    capturePlan: ReferenceCapturePlan,
    endpointPayloads: readonly ReferenceCaptureEndpointPayload[],
  ): Promise<DerivedCaptureMembers> {
    const plan = validateReferenceCapturePlan(capturePlan);
    if (!Array.isArray(endpointPayloads) || endpointPayloads.length < 3) throw new TypeError("capture endpoints are invalid");
    for (let index = 0; index < endpointPayloads.length; index += 1) {
      const endpoint = endpointPayloads[index]!;
      if (endpoint === null || typeof endpoint !== "object" || endpoint.ordinal !== index) {
        throw new TypeError("capture endpoint order is invalid");
      }
    }
    const profile = objectRow(endpointPayloads[0]!.payload, "athlete settings");
    const sourceSettings = profile.sportSettings === undefined ? [] : profile.sportSettings;
    if (!Array.isArray(sourceSettings)) throw new TypeError("sport settings response is invalid");
    if (!Array.isArray(endpointPayloads[1]!.payload)) throw new TypeError("activities response is invalid");
    if (!Array.isArray(endpointPayloads[2]!.payload)) throw new TypeError("wellness response is invalid");

    const settings: DerivedCaptureMember[] = [];
    for (let index = 0; index < sourceSettings.length; index += 1) {
      try {
        const row = objectRow(sourceSettings[index], "sport setting");
        settingsIdentity(row);
        const copy = structuredClone(row);
        options.acl.assertClean(copy);
        const landing = await mapSettingsLanding(copy);
        settings.push({ endpoint_ordinal: 0, payload_index: index,
          external_id: landing.sourceRecordExternalId, payload: row });
      } catch {}
    }

    const activities: DerivedCaptureMember[] = [];
    const activityPayload = endpointPayloads[1]!.payload as unknown[];
    const activityDrops = new DropTally();
    for (let index = 0; index < activityPayload.length; index += 1) {
      try {
        const row = objectRow(activityPayload[index], "activity row");
        nonempty(row.type, "activity type");
        for (const [field, label] of [["moving_time", "moving time"], ["elapsed_time", "elapsed time"]] as const) {
          const item = row[field];
          if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0) throw new TypeError(`activity ${label} is invalid`);
        }
        const identity = activityIdentity(row);
        const normalized = options.acl.activity(structuredClone(row));
        options.acl.assertClean(normalized);
        await mapActivityLanding({ normalized, archiveInstant: rowInstant(identity.startUtc), archive: placeholderArchive });
        activities.push({ endpoint_ordinal: 1, payload_index: index, external_id: identity.externalId, payload: row });
      } catch { activityDrops.record(activityPayload[index]); }
    }
    capturedActivityDrops = activityDrops.evidence();

    const wellness: DerivedCaptureMember[] = [];
    const wellnessPayload = endpointPayloads[2]!.payload as unknown[];
    for (let index = 0; index < wellnessPayload.length; index += 1) {
      try {
        const row = objectRow(wellnessPayload[index], "wellness row");
        const identity = wellnessIdentity(row);
        const normalized = options.acl.wellness(structuredClone(row));
        options.acl.assertClean(normalized);
        const landing = await mapWellnessLanding(normalized);
        if (landing.date_key !== Number(identity.id.replaceAll("-", ""))) throw new TypeError("wellness identity changed");
        wellness.push({ endpoint_ordinal: 2, payload_index: index, external_id: identity.id, payload: row });
      } catch {}
    }

    const streams: DerivedCaptureMember[] = [];
    for (const endpoint of endpointPayloads.slice(3)) {
      const member = await deriveStreamMember(endpoint);
      if (member !== null) streams.push(member);
    }
    for (const [lane, members] of Object.entries({ settings, activities, wellness, streams })) {
      const ids = members.map((member) => member.external_id);
      if (new Set(ids).size !== ids.length) throw new TypeError(`duplicate retained ${lane} ID`);
    }
    return Object.freeze({
      settings: Object.freeze(settings), activities: Object.freeze(activities),
      wellness: Object.freeze(wellness), streams: Object.freeze(streams),
      selected_stream_ids: Object.freeze(selectReferenceCaptureStreamIds(activities.map((member) => member.payload), plan)),
    });
  }

  async function captureReference(
    inputPlan: ReferenceCapturePlan,
    budget: SyncBudget,
  ): Promise<ReferenceCaptureBatch> {
    const plan = validateReferenceCapturePlan(inputPlan);
    const requester = createRequester({
      http: options.httpFactory({ outer: budget.signal, perRequestTimeoutMs: budget.perRequestTimeoutMs }),
      budget,
      minRequestIntervalMs: options.minRequestIntervalMs,
      wallClock: { now: () => plan.capture_epoch_ms },
      sleep: options.sleep,
      attemptLedger: options.attemptLedger,
    });
    if (!requester.canRequest(3)) throw new SyncBudgetExceededError();
    const required: ReferenceCaptureEndpointPayload[] = [
      { ordinal: 0, lane: "settings", endpoint: "athlete-profile",
        request: { oldest: null, newest: null, activity_id: null, stream_types: [], include_defaults: null },
        payload: await fetchJson(requester, "settings", { method: "GET",
          url: endpointUrl(`/api/v1/athlete/${encodeURIComponent(athleteId)}`) }) },
      { ordinal: 1, lane: "activities", endpoint: "activities",
        request: { oldest: plan.window.oldest, newest: plan.window.newest, activity_id: null, stream_types: [], include_defaults: null },
        payload: await fetchJson(requester, "activities", { method: "GET",
          url: rangeUrl(athleteId, "activities", { v: 1, cycle: 0, window_start: plan.window.oldest,
            window_end: plan.window.newest, last_key: null, complete: false }) }) },
      { ordinal: 2, lane: "wellness", endpoint: "wellness",
        request: { oldest: plan.window.oldest, newest: plan.window.newest, activity_id: null, stream_types: [], include_defaults: null },
        payload: await fetchJson(requester, "wellness", { method: "GET",
          url: rangeUrl(athleteId, "wellness", { v: 1, cycle: 0, window_start: plan.window.oldest,
            window_end: plan.window.newest, last_key: null, complete: false }) }) },
    ];
    const requiredMembers = await deriveReferenceCaptureMembers(plan, required);
    const selectedIds = [...requiredMembers.selected_stream_ids];
    const requiredUnits = 3 + requiredMembers.settings.length + requiredMembers.activities.length
      + requiredMembers.wellness.length + selectedIds.length;
    if (requiredUnits > budget.maxArtifacts) throw new SyncBudgetExceededError();
    if (selectedIds.length > 0 && !requester.canRequest(selectedIds.length)) throw new SyncBudgetExceededError();

    const successfulStreams: ReferenceCaptureEndpointPayload[] = [];
    for (const activityId of selectedIds) {
      requester.assertActive();
      let payload: unknown;
      try {
        payload = await fetchJson(requester, "streams", { method: "GET", url: streamUrl(activityId) });
      } catch (error) {
        if (error instanceof SyncBudgetExceededError || budget.signal.aborted) throw error;
        requester.assertActive();
        continue;
      }
      const endpoint: ReferenceCaptureEndpointPayload = {
        ordinal: 3 + successfulStreams.length,
        lane: "streams",
        endpoint: "activity-streams",
        request: { oldest: null, newest: null, activity_id: activityId,
          stream_types: [...REFERENCE_CAPTURE_STREAM_TYPES], include_defaults: false },
        payload,
      };
      if (await deriveStreamMember(endpoint) !== null) successfulStreams.push(endpoint);
    }
    const endpointPayloads = [...required, ...successfulStreams];
    const members = await deriveReferenceCaptureMembers(plan, endpointPayloads);
    if (members.streams.length !== successfulStreams.length) throw new Error("captured stream attribution is invalid");

    const activityInstantById = new Map<string, number>();
    for (const member of members.activities) {
      const identity = activityIdentity(member.payload as Record<string, unknown>);
      activityInstantById.set(member.external_id, identity.startUtc);
    }
    const requiredInstants = [epochForDate(plan.window.newest), epochForDate(plan.window.oldest), epochForDate(plan.window.oldest)];
    const endpoints: ReferenceCaptureEndpoint[] = [];
    for (const endpoint of endpointPayloads) {
      const epochSeconds = endpoint.ordinal < 3 ? requiredInstants[endpoint.ordinal]!
        : activityInstantById.get(endpoint.request.activity_id!);
      if (epochSeconds === undefined) throw new Error("stream activity instant is absent");
      const archiveInstant = rowInstant(epochSeconds);
      const archive = await options.archive.writeSnapshot(endpoint.payload, archiveInstant);
      endpoints.push({ ...endpoint, archiveInstant, archive });
    }

    const settings: ReferenceCaptureSettingsRecord[] = [];
    for (const member of members.settings) {
      const row = member.payload as Record<string, unknown>, archiveInstant = rowInstant(settingEpoch(row));
      const archive = await options.archive.writeSnapshot(row, archiveInstant);
      const normalizedSetting = structuredClone(row); options.acl.assertClean(normalizedSetting);
      const mappedSetting = await mapSettingsLanding(normalizedSetting);
      assertProjectionEvidenceEqual(
        parseCanonicalProjectionValue(mappedSetting.normalizedPayloadJson, "settings"),
        normalizedSetting, "settings",
      );
      settings.push({ endpointOrdinal: member.endpoint_ordinal, payloadIndex: member.payload_index,
        externalId: member.external_id, payload: row, archiveInstant, archive,
        landing: { kind: "settings", sourceRecordExternalId: mappedSetting.sourceRecordExternalId,
          normalizedPayloadJson: mappedSetting.normalizedPayloadJson, anchors: mappedSetting.anchors, zones: mappedSetting.zones } });
    }
    const activities: ReferenceCaptureActivityRecord[] = [];
    for (const member of members.activities) {
      const row = member.payload as Record<string, unknown>, identity = activityIdentity(row);
      const archiveInstant = rowInstant(identity.startUtc), archive = await options.archive.writeSnapshot(row, archiveInstant);
      const normalized = options.acl.activity(structuredClone(row)); options.acl.assertClean(normalized);
      const platform = await mapActivityLanding({ normalized, archiveInstant, archive });
      activities.push({ endpointOrdinal: member.endpoint_ordinal, payloadIndex: member.payload_index,
        externalId: member.external_id, payload: row, archiveInstant, archive, landing: { kind: "activity", platform } });
    }
    const wellness: ReferenceCaptureWellnessRecord[] = [];
    for (const member of members.wellness) {
      const row = member.payload as Record<string, unknown>, identity = wellnessIdentity(row);
      const archiveInstant = identity.instant, archive = await options.archive.writeSnapshot(row, archiveInstant);
      const normalized = options.acl.wellness(structuredClone(row)); options.acl.assertClean(normalized);
      wellness.push({ endpointOrdinal: member.endpoint_ordinal, payloadIndex: member.payload_index,
        externalId: member.external_id, payload: row, archiveInstant, archive,
        landing: { kind: "wellness", row: await mapWellnessLanding(normalized) } });
    }
    const streams: ReferenceCaptureStreamRecord[] = [];
    for (let index = 0; index < members.streams.length; index += 1) {
      const member = members.streams[index]!, endpoint = endpoints[3 + index]!;
      const normalized = options.acl.streams(structuredClone(member.payload)); options.acl.assertClean(normalized);
      const streamLanding = normalizeStreamLanding(normalized);
      const normalizedPayloadJson = canonicalJson(streamLanding);
      assertProjectionEvidenceEqual(
        parseCanonicalProjectionValue(normalizedPayloadJson, "streams"),
        streamLanding, "streams",
      );
      streams.push({ endpointOrdinal: member.endpoint_ordinal, payloadIndex: null, externalId: member.external_id,
        payload: member.payload, archiveInstant: endpoint.archiveInstant, archive: endpoint.archive,
        landing: { kind: "streams", sourceRecordExternalId: member.external_id,
          normalizedPayloadJson } });
    }
    return Object.freeze({ plan, endpoints: Object.freeze(endpoints), records: Object.freeze({
      settings: Object.freeze(settings), activities: Object.freeze(activities),
      wellness: Object.freeze(wellness), streams: Object.freeze(streams),
    }), selected_stream_ids: Object.freeze(selectedIds),
    captured_stream_ids: Object.freeze(successfulStreams.map((endpoint) => endpoint.request.activity_id!)),
    dropped_activity_rows: capturedActivityDrops });
  }

  return Object.freeze({ id: INTERVALS_ICU_SOURCE_ID, capabilities: INTERVALS_ICU_CAPABILITIES,
    pull, captureReference, deriveReferenceCaptureMembers });
}
