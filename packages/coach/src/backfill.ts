import { randomUUID } from "node:crypto";
import type { ArchiveInstant, ArchiveWriteResult } from "@enduragent/kernel/archive";
import type {
  ImportArtifact,
  ImportReport,
  ImportReportDeps,
  PairDiagnostic,
  PlatformImportArtifact,
} from "@enduragent/kernel/ingest";
import {
  createSyncStateRepository,
  createTrainingCoverageRepository,
  dumpStore,
  type SourceArtifactDraft,
  type SqlStore,
  type SyncBudget,
} from "@enduragent/kernel/store";
import { createNodeImportRuntime, type NodeImportRuntime } from "@enduragent/kernel-node/ingest";
import type { AthleteHome } from "@enduragent/kernel-node/home";
import {
  REQUEST_ATTEMPTS,
  ZERO_DROPPED_ACTIVITY_ROWS,
  type DroppedActivityRowEvidence,
  type IntervalsIcuArtifact,
  type IntervalsIcuSource,
} from "@enduragent/sync-intervals-icu";
import { addCivilDays, todayInTZ } from "@enduragent/engine/sport";
import { parseBackfillCursor } from "./backfill-state.js";
import { enforceIntervalsStoreOwner } from "./account-identity.js";
import { coverageGapsWithinWindow } from "./coverage-gaps.js";
import {
  createIntervalsBackfillSource,
  DEFAULT_PER_REQUEST_TIMEOUT_MS,
  DEFAULT_REQUEST_INTERVAL_MS,
  sleepAbortably,
  type BackfillClock,
} from "./intervals-source.js";
import { withCoachStoreWriter } from "./runtime.js";

export {
  assertRuntimeAthleteOwner,
  checkIntervalsStoreOwnerAtPath,
  INTERVALS_CREDENTIAL_REQUEST_TIMEOUT_MS,
  INTERVALS_CREDENTIAL_VERIFICATION_TIMEOUT_MS,
  resolveIntervalsStoreOwnerFingerprint,
  RuntimeAthleteOwnerRefusal,
  verifyIntervalsCredentialAtPath,
} from "./account-identity.js";
export type {
  IntervalsCredentialVerificationRefusalReason,
  IntervalsCredentialVerificationResult,
  IntervalsStoreOwnerComparison,
  RuntimeAthleteOwnerClaim,
  RuntimeAthleteOwnerGuardOptions,
  RuntimeAthleteOwnerRefusalReason,
  StoreOwnerCheckOptions,
  StoreOwnerCheckResult,
} from "./account-identity.js";
export {
  createIntervalsBackfillSource,
  DEFAULT_PER_REQUEST_TIMEOUT_MS,
  DEFAULT_REQUEST_INTERVAL_MS,
} from "./intervals-source.js";
export type { BackfillClock } from "./intervals-source.js";

export const DEFAULT_BACKFILL_BATCH_SIZE = 400;
export const DEFAULT_BACKFILL_PAGE_DEADLINE_MS = 21_600_000;
export const TRAINING_HISTORY_BACKFILL_OLDEST = "1900-01-01";

function configured(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const selected = value === undefined ? fallback : value;
  if (
    typeof selected !== "number" ||
    !Number.isSafeInteger(selected) ||
    selected < minimum ||
    selected > maximum
  ) {
    throw new TypeError(`invalid ${name}`);
  }
  return selected;
}

function draft(
  externalId: string,
  archiveInstant: ArchiveInstant,
  archive: ArchiveWriteResult,
  lane: "activities" | "bulk-fit" = "bulk-fit",
): SourceArtifactDraft {
  return {
    source: "intervals-icu",
    lane,
    externalId,
    artifactKind: lane === "activities" ? "snapshot" : "raw_file",
    archiveAddress: archive.address,
    archiveRelPath: archive.relPath,
    archiveEpochSeconds: archiveInstant.epochSeconds,
  };
}

export interface RunBackfillPagesOptions {
  readonly store: SqlStore & { transaction<T>(work: () => Promise<T>): Promise<T> };
  readonly node: NodeImportRuntime;
  readonly source: IntervalsIcuSource;
  readonly clock: BackfillClock;
  readonly signal?: AbortSignal;
  readonly batchSize?: number;
  readonly perRequestTimeoutMs?: number;
  readonly backfillPageDeadlineMs?: number;
  readonly measurePhase?: ImportReportDeps["measurePhase"];
  readonly onPageCommitted?: (input: {
    readonly pages: number;
    readonly artifacts: number;
    readonly report: ImportReport | null;
  }) => void;
}

export interface RunActivityAuditPagesOptions extends RunBackfillPagesOptions {
  readonly historyOldestDate: string;
  readonly historyNewestDate: string;
  readonly calendarTimeZone: string;
  readonly cycleId?: () => string;
}

export interface BackfillRunResult {
  readonly pages: number;
  readonly artifacts: number;
  readonly reports: readonly ImportReport[];
  readonly droppedActivityRows: DroppedActivityRowEvidence;
}

function addDropped(
  total: DroppedActivityRowEvidence,
  page: DroppedActivityRowEvidence | undefined,
): DroppedActivityRowEvidence {
  if (page === undefined) return total;
  return {
    sourceRestricted: total.sourceRestricted + page.sourceRestricted,
    other: total.other + page.other,
    datedLocalDates: [...new Set([...total.datedLocalDates, ...page.datedLocalDates])].sort(),
    undatedCount: total.undatedCount + page.undatedCount,
  };
}

interface AuthoritativeBackfillCycle {
  readonly authorityId: string;
  readonly sourceCycle: number;
  readonly nextPageOrdinal: number;
}

export async function runActivityAuditPages(
  options: RunActivityAuditPagesOptions,
): Promise<BackfillRunResult> {
  const batchSize = configured(
    options.batchSize,
    DEFAULT_BACKFILL_BATCH_SIZE,
    1,
    1_000,
    "batch size",
  );
  const perRequestTimeoutMs = configured(
    options.perRequestTimeoutMs,
    DEFAULT_PER_REQUEST_TIMEOUT_MS,
    1_000,
    300_000,
    "request timeout",
  );
  const pageDeadlineMs = configured(
    options.backfillPageDeadlineMs,
    DEFAULT_BACKFILL_PAGE_DEADLINE_MS,
    60_000,
    86_400_000,
    "page deadline",
  );
  let pages = 0,
    artifacts = 0;
  let droppedActivityRows: DroppedActivityRowEvidence = ZERO_DROPPED_ACTIVITY_ROWS;
  const reports: ImportReport[] = [];
  const coverage = createTrainingCoverageRepository();
  let authoritativeCycle: AuthoritativeBackfillCycle | null | undefined;
  for (;;) {
    const before = await createSyncStateRepository(options.store).readWatermark(
      "intervals-icu",
      "activities",
    );
    const beforeValue = before.value;
    const beforeCursor = beforeValue === null ? null : parseBackfillCursor(beforeValue);
    const controller = new AbortController();
    const abort = (): void => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    const budget: SyncBudget = {
      signal: controller.signal,
      clock: options.clock,
      deadlineMonotonicMs: options.clock.monotonicNow() + pageDeadlineMs,
      perRequestTimeoutMs,
      maxRequests: REQUEST_ATTEMPTS * (batchSize + 1),
      maxArtifacts: batchSize,
    };
    const platformRecords: PlatformImportArtifact[] = [];
    let checkpoint: Extract<IntervalsIcuArtifact, { kind: "checkpoint" }> | null = null;
    try {
      for await (const artifact of options.source.pull(before, budget)) {
        if (checkpoint !== null) throw new Error("source item follows checkpoint");
        if (artifact.kind === "checkpoint") {
          checkpoint = artifact;
          continue;
        }
        if (
          artifact.kind !== "snapshot" ||
          artifact.source !== "intervals-icu" ||
          artifact.lane !== "activities" ||
          artifact.landing.kind !== "activity" ||
          typeof artifact.externalId !== "string" ||
          artifact.externalId.length === 0
        ) {
          throw new Error("invalid activities source artifact");
        }
        if (platformRecords.length >= batchSize)
          throw new Error("source exceeded page artifact budget");
        const evidence = draft(
          artifact.externalId,
          artifact.archiveInstant,
          artifact.archive,
          "activities",
        );
        const platform = artifact.landing.platform;
        if (
          platform.sourceEvidence === undefined ||
          platform.sourceEvidence.archive.address !== evidence.archiveAddress ||
          platform.sourceEvidence.archive.relPath !== evidence.archiveRelPath ||
          platform.sourceEvidence.externalId !== evidence.externalId
        )
          throw new Error("activity source evidence conflict");
        platformRecords.push(platform);
      }
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
    if (
      checkpoint === null ||
      checkpoint.watermark.source !== "intervals-icu" ||
      checkpoint.watermark.lane !== "activities"
    ) {
      throw new Error("invalid source checkpoint");
    }
    const checkpointValue = checkpoint.watermark.value;
    if (checkpointValue === null) throw new Error("invalid source checkpoint");
    const parsed = parseBackfillCursor(checkpointValue);
    if (authoritativeCycle === undefined) {
      if (beforeValue === null || beforeCursor === null || beforeCursor.complete) {
        authoritativeCycle = {
          authorityId: (options.cycleId ?? randomUUID)(),
          sourceCycle: parsed.cycle,
          nextPageOrdinal: 0,
        };
      } else {
        const previous = await coverage.readBackfillCheckpoint(options.store, {
          sourceCycle: beforeCursor.cycle,
          cursorAfter: beforeValue,
        });
        if (
          previous === undefined ||
          previous.terminal ||
          previous.requestedOldest !== options.historyOldestDate ||
          previous.requestedNewest !== options.historyNewestDate ||
          previous.calendarTimeZone !== options.calendarTimeZone
        ) {
          authoritativeCycle = null;
        } else {
          authoritativeCycle = {
            authorityId: previous.authorityId,
            sourceCycle: previous.sourceCycle,
            nextPageOrdinal: previous.pageOrdinal + 1,
          };
          droppedActivityRows = {
            sourceRestricted: previous.droppedSourceRestricted,
            other: previous.droppedOther,
            datedLocalDates: previous.gaps.datedLocalDates,
            undatedCount: previous.gaps.undatedCount,
          };
        }
      }
    }
    if (authoritativeCycle !== null && authoritativeCycle.sourceCycle !== parsed.cycle) {
      throw new Error("activity backfill cycle changed unexpectedly");
    }
    droppedActivityRows = addDropped(droppedActivityRows, checkpoint.droppedActivityRows);
    const terminalCommitEpochSeconds = parsed.complete
      ? Math.floor(options.clock.now() / 1_000)
      : null;
    if (
      terminalCommitEpochSeconds !== null &&
      (!Number.isSafeInteger(terminalCommitEpochSeconds) || terminalCommitEpochSeconds < 0)
    ) {
      throw new TypeError("activity backfill clock is invalid");
    }
    const appendCoverage = async (transactionStore: SqlStore): Promise<void> => {
      if (authoritativeCycle === null || authoritativeCycle === undefined) return;
      await coverage.appendBackfillCheckpointInTransaction(transactionStore, {
        authorityId: authoritativeCycle.authorityId,
        sourceCycle: authoritativeCycle.sourceCycle,
        pageOrdinal: authoritativeCycle.nextPageOrdinal,
        requestedOldest: options.historyOldestDate,
        requestedNewest: options.historyNewestDate,
        calendarTimeZone: options.calendarTimeZone,
        cursorAfter: checkpointValue,
        droppedSourceRestricted: droppedActivityRows.sourceRestricted,
        droppedOther: droppedActivityRows.other,
        gaps: coverageGapsWithinWindow({
          evidence: droppedActivityRows,
          oldest: options.historyOldestDate,
          newest: options.historyNewestDate,
        }),
        terminal: parsed.complete,
      });
      if (terminalCommitEpochSeconds !== null) {
        const elapsedThrough = addCivilDays(
          todayInTZ(options.calendarTimeZone, new Date(terminalCommitEpochSeconds * 1_000)),
          -1,
        );
        const coverageNewest =
          options.historyNewestDate < elapsedThrough ? options.historyNewestDate : elapsedThrough;
        if (coverageNewest < options.historyOldestDate) return;
        await coverage.appendCommitInTransaction(transactionStore, {
          source: "intervals-icu",
          lane: "activities",
          authorityKind: "activity-backfill",
          authorityId: authoritativeCycle.authorityId,
          calendarTimeZone: options.calendarTimeZone,
          coveredOldest: options.historyOldestDate,
          coveredNewest: coverageNewest,
          committedEpochSeconds: terminalCommitEpochSeconds,
          gaps: coverageGapsWithinWindow({
            evidence: droppedActivityRows,
            oldest: options.historyOldestDate,
            newest: coverageNewest,
          }),
        });
      }
    };
    let report: ImportReport | null = null;
    if (platformRecords.length === 0) {
      await options.store.transaction(async () => {
        await createSyncStateRepository(options.store).recordCompletionInTransaction({
          source: "intervals-icu",
          lane: "activities",
          watermarkBefore: before.value,
          watermarkAfter: checkpointValue,
          artifactsSeen: 0,
          sourceChanges: 0,
        });
        await appendCoverage(options.store);
      });
    } else {
      report = await options.node.importBatchWithReport(
        { files: [], platform_records: platformRecords },
        {
          ...(options.measurePhase === undefined ? {} : { measurePhase: options.measurePhase }),
          finalizeBatchInTransaction: async (transactionStore, result) => {
            const sourceChanges =
              result.source_artifact_inserted +
              result.raw_file_inserted +
              result.source_record_inserted +
              result.source_record_updated;
            await createSyncStateRepository(transactionStore).recordCompletionInTransaction({
              source: "intervals-icu",
              lane: "activities",
              watermarkBefore: before.value,
              watermarkAfter: checkpointValue,
              artifactsSeen: platformRecords.length,
              sourceChanges,
            });
            await appendCoverage(transactionStore);
          },
        },
      );
      reports.push(report);
    }
    if (authoritativeCycle !== null) {
      authoritativeCycle = {
        ...authoritativeCycle,
        nextPageOrdinal: authoritativeCycle.nextPageOrdinal + 1,
      };
    }
    pages += 1;
    artifacts += platformRecords.length;
    options.onPageCommitted?.({ pages, artifacts, report });
    if (parsed.complete) break;
  }
  return Object.freeze({
    pages,
    artifacts,
    reports: Object.freeze(reports),
    droppedActivityRows: Object.freeze(droppedActivityRows),
  });
}

export async function runBackfillPages(
  options: RunBackfillPagesOptions,
): Promise<BackfillRunResult> {
  const batchSize = configured(
    options.batchSize,
    DEFAULT_BACKFILL_BATCH_SIZE,
    1,
    1_000,
    "batch size",
  );
  const perRequestTimeoutMs = configured(
    options.perRequestTimeoutMs,
    DEFAULT_PER_REQUEST_TIMEOUT_MS,
    1_000,
    300_000,
    "request timeout",
  );
  const pageDeadlineMs = configured(
    options.backfillPageDeadlineMs,
    DEFAULT_BACKFILL_PAGE_DEADLINE_MS,
    60_000,
    86_400_000,
    "page deadline",
  );
  let pages = 0,
    artifacts = 0,
    terminalCursor: string | null = null;
  let droppedActivityRows: DroppedActivityRowEvidence = ZERO_DROPPED_ACTIVITY_ROWS;
  const reports: ImportReport[] = [];
  for (;;) {
    const before = await createSyncStateRepository(options.store).readWatermark(
      "intervals-icu",
      "bulk-fit",
    );
    const controller = new AbortController();
    const abort = (): void => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    const budget: SyncBudget = {
      signal: controller.signal,
      clock: options.clock,
      deadlineMonotonicMs: options.clock.monotonicNow() + pageDeadlineMs,
      perRequestTimeoutMs,
      maxRequests: REQUEST_ATTEMPTS * (batchSize + 1),
      maxArtifacts: batchSize,
    };
    const files: ImportArtifact[] = [];
    let checkpoint: Extract<IntervalsIcuArtifact, { kind: "checkpoint" }> | null = null;
    try {
      for await (const artifact of options.source.pull(before, budget)) {
        if (checkpoint !== null) throw new Error("source item follows checkpoint");
        if (artifact.kind === "checkpoint") {
          checkpoint = artifact;
          continue;
        }
        if (
          artifact.source !== "intervals-icu" ||
          artifact.lane !== "bulk-fit" ||
          artifact.kind !== "raw-file" ||
          typeof artifact.externalId !== "string" ||
          artifact.externalId.length === 0 ||
          artifact.file.ext !== "fit"
        ) {
          throw new Error("invalid bulk FIT source artifact");
        }
        if (files.length >= batchSize) throw new Error("source exceeded page artifact budget");
        const entry = draft(artifact.externalId, artifact.archiveInstant, artifact.archive);
        if (
          entry.archiveAddress !== artifact.file.source_evidence?.entry.archiveAddress &&
          artifact.file.source_evidence !== undefined
        ) {
          throw new Error("source evidence conflict");
        }
        files.push({
          ...artifact.file,
          source_evidence: {
            container:
              artifact.container === null
                ? null
                : draft(
                    artifact.container.externalId,
                    artifact.container.archiveInstant,
                    artifact.container.archive,
                  ),
            entry,
          },
        });
      }
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
    if (
      checkpoint === null ||
      checkpoint.watermark.source !== "intervals-icu" ||
      checkpoint.watermark.lane !== "bulk-fit"
    ) {
      throw new Error("invalid source checkpoint");
    }
    if (terminalCursor === null)
      droppedActivityRows = addDropped(droppedActivityRows, checkpoint.droppedActivityRows);
    const checkpointValue = checkpoint.watermark.value;
    const parsed = parseBackfillCursor(checkpointValue);
    let report: ImportReport | null = null;
    if (files.length === 0) {
      await options.store.transaction(async () => {
        await createSyncStateRepository(options.store).recordCompletionInTransaction({
          source: "intervals-icu",
          lane: "bulk-fit",
          watermarkBefore: before.value,
          watermarkAfter: checkpointValue,
          artifactsSeen: 0,
          sourceChanges: 0,
        });
      });
    } else {
      report = await options.node.importBatchWithReport(
        { files, platform_records: [] },
        {
          ...(options.measurePhase === undefined ? {} : { measurePhase: options.measurePhase }),
          finalizeBatchInTransaction: async (_store, result) => {
            const sourceChanges =
              result.source_artifact_inserted +
              result.raw_file_inserted +
              result.source_record_inserted +
              result.source_record_updated;
            await createSyncStateRepository(options.store).recordCompletionInTransaction({
              source: "intervals-icu",
              lane: "bulk-fit",
              watermarkBefore: before.value,
              watermarkAfter: checkpointValue,
              artifactsSeen: files.length,
              sourceChanges,
            });
          },
        },
      );
      reports.push(report);
    }
    pages += 1;
    artifacts += files.length;
    options.onPageCommitted?.({ pages, artifacts, report });
    if (terminalCursor !== null) {
      if (files.length !== 0 || checkpointValue !== terminalCursor)
        throw new Error("invalid terminal source replay");
      break;
    }
    if (parsed.complete) terminalCursor = checkpointValue;
  }
  return Object.freeze({
    pages,
    artifacts,
    reports: Object.freeze(reports),
    droppedActivityRows: Object.freeze(droppedActivityRows),
  });
}

export interface RunIntervalsBackfillOptions {
  readonly env: Record<string, string | undefined>;
  readonly apiKey: string;
  readonly athleteId: string;
  readonly historyNewestDate: string;
  readonly calendarTimeZone: string;
  readonly requestIntervalMs?: number;
  readonly batchSize?: number;
  readonly perRequestTimeoutMs?: number;
  readonly backfillPageDeadlineMs?: number;
  readonly signal?: AbortSignal;
  readonly clock?: BackfillClock;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly baseFetch?: typeof globalThis.fetch;
  readonly measurePhase?: ImportReportDeps["measurePhase"];
  readonly onPageCommitted?: RunBackfillPagesOptions["onPageCommitted"];
}

export interface RunIntervalsBackfillInWriterOptions extends Omit<
  RunIntervalsBackfillOptions,
  "env"
> {
  readonly home: AthleteHome;
  readonly store: SqlStore & {
    transaction<T>(work: () => Promise<T>): Promise<T>;
  };
}

const productionClock: BackfillClock = Object.freeze({
  now: () => Date.now(),
  monotonicNow: () => performance.now(),
});
export async function runIntervalsBackfillInWriter(
  options: RunIntervalsBackfillInWriterOptions,
): Promise<BackfillRunResult> {
  const requestIntervalMs = configured(
    options.requestIntervalMs,
    DEFAULT_REQUEST_INTERVAL_MS,
    250,
    60_000,
    "request interval",
  );
  const clock = options.clock ?? productionClock,
    sleep = options.sleep ?? sleepAbortably;
  await enforceIntervalsStoreOwner(options.store, {
    apiKey: options.apiKey,
    athleteId: options.athleteId,
    historyNewestDate: options.historyNewestDate,
    clock,
    sleep,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.baseFetch === undefined ? {} : { baseFetch: options.baseFetch }),
  });
  const node = createNodeImportRuntime({
    archiveDir: options.home.archiveDir,
    store: options.store,
  });
  const source = createIntervalsBackfillSource({
    apiKey: options.apiKey,
    athleteId: options.athleteId,
    historyNewestDate: options.historyNewestDate,
    minRequestIntervalMs: requestIntervalMs,
    archive: node.archive,
    clock,
    sleep,
    ...(options.baseFetch === undefined ? {} : { baseFetch: options.baseFetch }),
  });
  return runBackfillPages({
    store: options.store,
    node,
    source,
    clock,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
    ...(options.perRequestTimeoutMs === undefined
      ? {}
      : { perRequestTimeoutMs: options.perRequestTimeoutMs }),
    ...(options.backfillPageDeadlineMs === undefined
      ? {}
      : { backfillPageDeadlineMs: options.backfillPageDeadlineMs }),
    ...(options.measurePhase === undefined ? {} : { measurePhase: options.measurePhase }),
    ...(options.onPageCommitted === undefined ? {} : { onPageCommitted: options.onPageCommitted }),
  });
}

export function runIntervalsBackfill(
  options: RunIntervalsBackfillOptions,
): Promise<BackfillRunResult> {
  const { env, ...inWriterOptions } = options;
  return withCoachStoreWriter(env, ({ home, store }) => {
    return runIntervalsBackfillInWriter({ ...inWriterOptions, home, store });
  });
}

export interface DualPresentationAuditResult {
  readonly activities: BackfillRunResult;
  readonly bulkFit: BackfillRunResult;
  readonly rerunReports: readonly ImportReport[];
  readonly rerunRawFileInserts: number;
  readonly rerunSourceRecordInserts: number;
  readonly dumpBytesStable: boolean;
  readonly thresholdNearMisses: readonly PairDiagnostic[];
}

export function runIntervalsDualPresentationAudit(
  options: RunIntervalsBackfillOptions,
): Promise<DualPresentationAuditResult> {
  const requestIntervalMs = configured(
    options.requestIntervalMs,
    DEFAULT_REQUEST_INTERVAL_MS,
    250,
    60_000,
    "request interval",
  );
  const clock = options.clock ?? productionClock,
    sleep = options.sleep ?? sleepAbortably;
  return withCoachStoreWriter(options.env, async ({ home, store }) => {
    const node = createNodeImportRuntime({ archiveDir: home.archiveDir, store });
    const source = createIntervalsBackfillSource({
      apiKey: options.apiKey,
      athleteId: options.athleteId,
      historyNewestDate: options.historyNewestDate,
      minRequestIntervalMs: requestIntervalMs,
      archive: node.archive,
      clock,
      sleep,
      ...(options.baseFetch === undefined ? {} : { baseFetch: options.baseFetch }),
    });
    const shared = {
      store,
      node,
      source,
      clock,
      historyOldestDate: TRAINING_HISTORY_BACKFILL_OLDEST,
      historyNewestDate: options.historyNewestDate,
      calendarTimeZone: options.calendarTimeZone,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
      ...(options.perRequestTimeoutMs === undefined
        ? {}
        : { perRequestTimeoutMs: options.perRequestTimeoutMs }),
      ...(options.backfillPageDeadlineMs === undefined
        ? {}
        : { backfillPageDeadlineMs: options.backfillPageDeadlineMs }),
      ...(options.measurePhase === undefined ? {} : { measurePhase: options.measurePhase }),
      ...(options.onPageCommitted === undefined
        ? {}
        : { onPageCommitted: options.onPageCommitted }),
    };
    const activities = await runActivityAuditPages(shared);
    const bulkFit = await runBackfillPages(shared);
    const before = await dumpStore(store);
    const rows = await store.all(
      "SELECT sha256,path FROM raw_file WHERE ext='fit' ORDER BY sha256 COLLATE BINARY ASC",
    );
    const rerunReports: ImportReport[] = [];
    for (let offset = 0; offset < rows.length; offset += DEFAULT_BACKFILL_BATCH_SIZE) {
      const files: ImportArtifact[] = [];
      for (const row of rows.slice(offset, offset + DEFAULT_BACKFILL_BATCH_SIZE)) {
        if (
          typeof row.sha256 !== "string" ||
          !/^[0-9a-f]{64}$/.test(row.sha256) ||
          typeof row.path !== "string" ||
          row.path.length === 0
        )
          throw new Error("invalid persisted FIT archive row");
        files.push({
          input_path: `archive:${row.sha256}.fit`,
          bytes: await node.archive.readArtifact(row.path),
          ext: "fit",
        });
      }
      rerunReports.push(
        await node.importBatchWithReport(
          { files, platform_records: [] },
          options.measurePhase === undefined ? undefined : { measurePhase: options.measurePhase },
        ),
      );
    }
    const after = await dumpStore(store);
    const rerunRawFileInserts = rerunReports.reduce(
      (sum, report) => sum + report.inserts.raw_file,
      0,
    );
    const rerunSourceRecordInserts = rerunReports.reduce(
      (sum, report) => sum + report.inserts.source_record,
      0,
    );
    const thresholdNearMisses = rerunReports.flatMap((report) => report.threshold_near_misses);
    return Object.freeze({
      activities,
      bulkFit,
      rerunReports: Object.freeze(rerunReports),
      rerunRawFileInserts,
      rerunSourceRecordInserts,
      dumpBytesStable: before === after,
      thresholdNearMisses: Object.freeze(thresholdNearMisses),
    });
  });
}
