import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as setTimeoutPromise } from "node:timers/promises";
import {
  REFERENCE_CAPTURE_STREAM_LIMIT,
  assertReferenceCaptureReplayable,
  createReferenceCapturePlan,
  planCalendarTimeZone,
  serializeReferenceCaptureManifest,
  serializeReferenceCapturePlan,
  validateReferenceCaptureManifest,
  type RecordRef,
  type ReferenceCaptureManifest,
  type ReferenceCapturePlan,
} from "@enduragent/kernel/reference/capture";
import {
  H,
  createIntervalsSourceRepository,
  createTrainingCoverageRepository,
  type CoverageCommitInput,
  type PhysicalRequestLedger,
  type SourceArtifactDraft,
  type SyncBudget,
} from "@enduragent/kernel/store";
import {
  loadReferenceCaptureSidecars,
  readVerifiedReferenceSnapshot,
  validateReferenceCaptureReview,
  writeReferenceCaptureSidecars,
  type AssertReferenceCaptureReplayable,
  type ReferenceCaptureReview,
} from "@enduragent/kernel-node/capture-manifest";
import { createNodeCrypto, createNodeImportRuntime } from "@enduragent/kernel-node/ingest";
import { activityDropEvidence, REQUEST_ATTEMPTS, type CaptureReport, type DroppedActivityRowEvidence, type IntervalsIcuCaptureSource, type ReferenceCaptureBatch } from "@enduragent/sync-intervals-icu";
import { addCivilDays, todayInTZ } from "@enduragent/engine/sport";
import { createIntervalsBackfillSource, DEFAULT_PER_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_INTERVAL_MS } from "./backfill.js";
import { coverageGapsWithinWindow } from "./coverage-gaps.js";
import {
  withCoachStoreWriter,
  type CoachStoreWriterContext,
} from "./runtime.js";

export type ReferenceCaptureFailureCategory = "capture" | "persistence" | "validation";

export class ReferenceCaptureRunError extends Error {
  readonly category: ReferenceCaptureFailureCategory;
  constructor(category: ReferenceCaptureFailureCategory, options?: ErrorOptions) {
    super("Reference capture failed", options);
    this.name = "ReferenceCaptureRunError";
    this.category = category;
  }
}

class ReferenceCaptureValidationError extends Error {}

export class ReplacedCaptureNotReplayableError extends Error {
  readonly replacesCaptureId: string;
  constructor(replacesCaptureId: string, options?: ErrorOptions) {
    super("The capture this run replaces could not be loaded and replayed. Nothing was written.", options);
    this.name = "ReplacedCaptureNotReplayableError";
    this.replacesCaptureId = replacesCaptureId;
  }
}

export interface ReferenceCaptureRun {
  readonly manifest: ReferenceCaptureManifest;
  readonly report: CaptureReport;
}

export interface RunReferenceCaptureOptions {
  readonly env: Record<string, string | undefined>;
  readonly writerContext?: CoachStoreWriterContext;
  readonly apiKey: string;
  readonly athleteId: string;
  readonly calendarTimeZone: string;
  readonly reviewedOn: string;
  readonly reason: ReferenceCaptureReview["reason"];
  readonly replacesCaptureId?: string;
  readonly budget?: SyncBudget;
  readonly baseFetch?: typeof globalThis.fetch;
  readonly attemptLedger?: PhysicalRequestLedger;
  readonly platform?: NodeJS.Platform;
}

export interface RunReferenceCaptureDependencies {
  readonly wallClock?: () => Date;
  readonly uuid?: () => string;
  readonly monotonicNow?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly writeSidecars?: typeof writeReferenceCaptureSidecars;
  readonly loadSidecars?: typeof loadReferenceCaptureSidecars;
}

function sourceArtifact(
  record: ReferenceCaptureBatch["records"][keyof ReferenceCaptureBatch["records"]][number],
): SourceArtifactDraft {
  const lane: SourceArtifactDraft["lane"] = record.landing.kind === "activity" ? "activities"
    : record.landing.kind === "settings" ? "settings"
    : record.landing.kind === "wellness" ? "wellness" : "streams";
  return {
    source: "intervals-icu" as const,
    lane,
    externalId: record.externalId,
    artifactKind: "snapshot" as const,
    archiveAddress: record.archive.address,
    archiveRelPath: record.archive.relPath,
    archiveEpochSeconds: record.archiveInstant.epochSeconds,
  };
}

function snapshot(value: { readonly archive: { readonly address: string; readonly relPath: string } }) {
  return { address: value.archive.address, rel_path: value.archive.relPath };
}

export async function runReferenceCapture(
  options: RunReferenceCaptureOptions,
  dependencies: RunReferenceCaptureDependencies = {},
): Promise<ReferenceCaptureRun> {
  const now = (dependencies.wallClock ?? (() => new Date()))();
  const captureId = (dependencies.uuid ?? randomUUID)();
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  const sleep = dependencies.sleep ?? ((ms: number, signal: AbortSignal) =>
    setTimeoutPromise(ms, undefined, { signal }).then(() => undefined));
  const controller = new AbortController();
  const budget: SyncBudget = options.budget ?? {
    signal: controller.signal,
    clock: { monotonicNow },
    deadlineMonotonicMs: monotonicNow() + 15 * 60 * 1_000,
    perRequestTimeoutMs: DEFAULT_PER_REQUEST_TIMEOUT_MS,
    maxRequests: REQUEST_ATTEMPTS * (3 + REFERENCE_CAPTURE_STREAM_LIMIT),
    maxArtifacts: 10_000,
  };
  let plan: ReferenceCapturePlan;
  let review: ReferenceCaptureReview;
  try {
    plan = createReferenceCapturePlan({
      now,
      calendarTimeZone: options.calendarTimeZone,
    });
    review = validateReferenceCaptureReview({ schema_version: 1, capture_id: captureId,
      reviewed_on: options.reviewedOn, replaces_capture_id: options.replacesCaptureId ?? null,
      reason: options.reason });
  } catch (error) {
    throw new ReferenceCaptureRunError("validation", { cause: error });
  }

  const capture = async ({ home, store }: CoachStoreWriterContext): Promise<ReferenceCaptureRun> => {
    const crypto = createNodeCrypto();
    const node = createNodeImportRuntime({ archiveDir: home.archiveDir, store });
    const source = createIntervalsBackfillSource({
      apiKey: options.apiKey,
      athleteId: options.athleteId,
      historyNewestDate: plan.window.newest,
      minRequestIntervalMs: DEFAULT_REQUEST_INTERVAL_MS,
      archive: node.archive,
      clock: { now: () => now.getTime(), monotonicNow },
      sleep,
      ...(options.baseFetch === undefined ? {} : { baseFetch: options.baseFetch }),
      ...(options.attemptLedger === undefined ? {} : { attemptLedger: options.attemptLedger }),
    }) as IntervalsIcuCaptureSource;
    const repository = createIntervalsSourceRepository(store, (fields) => {
      if (fields.length === 0) throw new TypeError("empty key tuple");
      return H(crypto, ...(fields as [string | number, ...(string | number)[]]));
    });
    const assertReplayable: AssertReferenceCaptureReplayable = async (candidate) => {
      try {
        await assertReferenceCaptureReplayable(candidate, {
          readVerifiedSnapshot: (reference) => readVerifiedReferenceSnapshot(reference, { archive: node.archive, crypto }),
          derivePayloadMembers: (plan, endpointPayloads) => source.deriveReferenceCaptureMembers(plan, endpointPayloads),
          assertStoreEvidence: (record, lane) => repository.assertPinnedCaptureEvidence({ lane,
            externalId: record.external_id, artifactKey: record.store_evidence.artifact_key,
            archiveAddress: record.snapshot.address, archiveRelPath: record.snapshot.rel_path,
            currentRevision: record.store_evidence.current_revision === null ? null : {
              sourceRecordId: record.store_evidence.current_revision.source_record_id,
              revisionId: record.store_evidence.current_revision.revision_id,
            } }),
        });
      } catch (error) { throw new ReferenceCaptureValidationError("capture replay validation failed", { cause: error }); }
    };

    const platform = options.platform === undefined ? {} : { platform: options.platform };
    if (options.replacesCaptureId !== undefined) {
      try {
        await loadReferenceCaptureSidecars({ root: home.root, captureId: options.replacesCaptureId, assertReplayable, ...platform });
      } catch (error) {
        throw new ReferenceCaptureRunError("capture",
          { cause: new ReplacedCaptureNotReplayableError(options.replacesCaptureId, { cause: error }) });
      }
    }

    let batch: ReferenceCaptureBatch;
    let droppedActivityRows: DroppedActivityRowEvidence;
    try {
      batch = await source.captureReference(plan, budget);
      if (serializeReferenceCapturePlan(batch.plan) !== serializeReferenceCapturePlan(plan)) {
        throw new TypeError("reference capture plan changed");
      }
      droppedActivityRows = activityDropEvidence(batch.report.activities);
    }
    catch (error) { throw new ReferenceCaptureRunError("capture", { cause: error }); }

    const coverage = createTrainingCoverageRepository();
    const elapsedThrough = addCivilDays(
      todayInTZ(planCalendarTimeZone(plan), new Date(plan.capture_epoch_ms)),
      -1,
    );
    const coverageNewest =
      plan.window.newest < elapsedThrough ? plan.window.newest : elapsedThrough;
    const coverageCommit: CoverageCommitInput = {
      source: "intervals-icu",
      lane: "activities",
      authorityKind: "reference-capture",
      authorityId: captureId,
      calendarTimeZone: planCalendarTimeZone(plan),
      coveredOldest: plan.window.oldest,
      coveredNewest: coverageNewest,
      committedEpochSeconds: Math.floor(plan.capture_epoch_ms / 1_000),
      gaps: coverageGapsWithinWindow({
        evidence: droppedActivityRows,
        oldest: plan.window.oldest,
        newest: coverageNewest,
      }),
    };
    const wellnessArtifactKeys = new Map<string, string>();
    try {
      if (batch.records.activities.length > 0) {
        await node.importBatchWithReport(
          {
            files: [],
            platform_records: batch.records.activities.map((record) => record.landing.platform),
          },
          {
            finalizeBatchInTransaction: async (transactionStore) => {
              await coverage.appendCommitInTransaction(transactionStore, coverageCommit);
            },
          },
        );
      }
      await store.transaction(async () => {
        if (batch.records.activities.length === 0) {
          await coverage.appendCommitInTransaction(store, coverageCommit);
        }
        for (const record of batch.records.settings) {
          const evidence = await repository.recordArtifact(sourceArtifact(record));
          await repository.recordGenericLanding({ externalId: record.landing.sourceRecordExternalId,
            artifactKey: evidence.artifactKey, archiveAddress: record.archive.address, endpoint: "settings",
            normalizedPayloadJson: record.landing.normalizedPayloadJson });
          for (const anchor of record.landing.anchors) await repository.insertSyncedAnchor(anchor);
          for (const zone of record.landing.zones) await repository.insertSyncedZone(zone);
        }
        for (const record of batch.records.wellness) {
          const evidence = await repository.recordArtifact(sourceArtifact(record));
          wellnessArtifactKeys.set(record.externalId, evidence.artifactKey);
          await repository.upsertWellness(record.landing.row);
        }
        for (const record of batch.records.streams) {
          const evidence = await repository.recordArtifact(sourceArtifact(record));
          await repository.recordGenericLanding({ externalId: record.landing.sourceRecordExternalId,
            artifactKey: evidence.artifactKey, archiveAddress: record.archive.address, endpoint: "streams",
            normalizedPayloadJson: record.landing.normalizedPayloadJson });
        }
      });
    } catch (error) {
      throw new ReferenceCaptureRunError("persistence", { cause: error });
    }

    const records = { settings: [] as RecordRef[], activities: [] as RecordRef[],
      wellness: [] as RecordRef[], streams: [] as RecordRef[] };
    try {
      for (const lane of ["settings", "activities", "wellness", "streams"] as const) {
        const sourceRecords = batch.records[lane];
        for (let ordinal = 0; ordinal < sourceRecords.length; ordinal += 1) {
          const record = sourceRecords[ordinal]!;
          if (lane === "wellness") {
            const artifactKey = wellnessArtifactKeys.get(record.externalId);
            if (artifactKey === undefined) throw new Error("wellness capture evidence is absent");
            records[lane].push({ ordinal, endpoint_ordinal: record.endpointOrdinal,
              payload_index: record.payloadIndex, external_id: record.externalId, snapshot: snapshot(record),
              store_evidence: { artifact_key: artifactKey, current_revision: null } });
          } else {
            const evidence = await repository.readCurrentCaptureEvidence(lane, record.externalId);
            if (evidence.archiveAddress !== record.archive.address || evidence.archiveRelPath !== record.archive.relPath) {
              throw new Error("current capture evidence disagrees with snapshot");
            }
            records[lane].push({ ordinal, endpoint_ordinal: record.endpointOrdinal,
              payload_index: record.payloadIndex, external_id: record.externalId, snapshot: snapshot(record),
              store_evidence: { artifact_key: evidence.artifactKey,
                current_revision: { source_record_id: evidence.sourceRecordId, revision_id: evidence.revisionId } } });
          }
        }
      }
    } catch (error) {
      throw new ReferenceCaptureRunError("persistence", { cause: error });
    }

    let manifest: ReferenceCaptureManifest;
    try {
      manifest = validateReferenceCaptureManifest({
        schema_version: 1,
        capture_id: captureId,
        source: "external-oracle",
        plan: batch.plan,
        operation_ledger: { link_kind: "capture-id", capture_id: captureId },
        endpoints: batch.endpoints.map((endpoint) => ({ ordinal: endpoint.ordinal, lane: endpoint.lane,
          endpoint: endpoint.endpoint, request: endpoint.request, snapshot: snapshot(endpoint) })),
        records,
        selected_stream_ids: [...batch.selected_stream_ids],
        captured_stream_ids: [...batch.captured_stream_ids],
        deterministic_order: {
          endpoint_ordinals: batch.endpoints.map((endpoint) => endpoint.ordinal),
          settings: batch.records.settings.map((record) => record.externalId),
          activities: batch.records.activities.map((record) => record.externalId),
          wellness: batch.records.wellness.map((record) => record.externalId),
          streams: [...batch.captured_stream_ids],
        },
      });
    } catch (error) {
      throw new ReferenceCaptureRunError("validation", { cause: error });
    }

    try {
      const committed = await (dependencies.writeSidecars ?? writeReferenceCaptureSidecars)({
        root: home.root, manifest, review, assertReplayable, ...platform,
      });
      const recorded = dependencies.loadSidecars === undefined ? committed
        : await dependencies.loadSidecars({ root: home.root, captureId, assertReplayable, ...platform });
      return { manifest: recorded.manifest, report: batch.report };
    } catch (error) {
      throw new ReferenceCaptureRunError(error instanceof ReferenceCaptureValidationError ? "validation" : "persistence", { cause: error });
    }
  };
  return options.writerContext === undefined
    ? withCoachStoreWriter(options.env, capture)
    : capture(options.writerContext);
}

export function referenceCaptureEvidenceSha256Input(manifest: ReferenceCaptureManifest): Uint8Array {
  return new TextEncoder().encode(serializeReferenceCaptureManifest(manifest));
}
