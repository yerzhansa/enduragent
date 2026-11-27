import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AsyncMutex } from "../concurrency/mutex.js";
import { Cooldown } from "../concurrency/cooldown.js";
import { createRunSync } from "./sync/run-sync.js";
import { Scheduler } from "./sync/scheduler.js";
import { makeProductionFetcher } from "./sync/fetch-reference-data.js";
import { readLatestVersioned } from "./io/read-latest-versioned.js";
import { type LatestJson } from "./schemas/latest.js";
import { SYNC_COOLDOWN_MS, SCHEDULED_SYNC_INTERVAL_MS } from "./freshness.js";
import { assertDisjointCoverage, assertSubsetCoverage } from "./sport-adapter-invariants.js";
import type { FetchedReference, RunSyncOpts, SyncResult } from "./sync/run-sync.js";
import type { ReferenceServices } from "./services.js";
import type { Sport } from "../sport.js";
import type { PhysicalRequestLedger } from "@enduragent/kernel/store";
import { resolveUserTimezone } from "@enduragent/engine/sport";

export const INITIAL_SYNC_FAILED_LOG_PREFIX = "Reference: initial sync failed";
export const RATE_LIMIT_FOLLOW_UP_MIN_DELAY_MS = 1_000;
export const RATE_LIMIT_FOLLOW_UP_MAX_DELAY_MS = 30_000;

export interface ReferenceRuntime {
  readonly services: ReferenceServices;
  readonly scheduler: Scheduler;
  runScheduledOnce(signal?: AbortSignal): Promise<SyncResult>;
}

export interface BootstrapReferenceDeps {
  readonly dataDir: string;
  readonly intervals: { readonly apiKey: string; readonly athleteId?: string };
  readonly readIntervals?: () => { readonly apiKey: string; readonly athleteId?: string };
  readonly readCalendarTimeZone: () => string;
  readonly sport: Sport;
  readonly fetchReferenceData?: (
    signal: AbortSignal,
    intervals: { readonly apiKey: string; readonly athleteId?: string },
    calendarTimeZone: string,
  ) => Promise<FetchedReference>;
  readonly startScheduler?: boolean;
  readonly attemptLedgerForRun?: () => PhysicalRequestLedger;
}

async function runWithRateLimitFollowUp(
  runSync: (opts: RunSyncOpts) => Promise<SyncResult>,
  opts: RunSyncOpts,
): Promise<SyncResult> {
  const result = await runSync(opts);
  if (result.kind !== "failed" || result.retryAfterMs === undefined) return result;
  const followUpDelayMs = Math.max(RATE_LIMIT_FOLLOW_UP_MIN_DELAY_MS, result.retryAfterMs);
  if (followUpDelayMs > RATE_LIMIT_FOLLOW_UP_MAX_DELAY_MS) return result;
  await delay(followUpDelayMs, undefined, opts.signal === undefined ? {} : { signal: opts.signal });
  return await runSync(opts);
}

export async function bootstrapReference(deps: BootstrapReferenceDeps): Promise<ReferenceRuntime> {
  const adapters = deps.sport.referenceAdapters?.() ?? [];
  assertDisjointCoverage(adapters);
  assertSubsetCoverage(adapters, deps.sport.intervalsActivityTypes);

  const referenceDataPath = join(deps.dataDir, "data");
  mkdirSync(referenceDataPath, { recursive: true, mode: 0o700 });

  const readIntervals = deps.readIntervals ?? (() => deps.intervals);
  const fetchReferenceData =
    deps.fetchReferenceData ??
    makeProductionFetcher({
      adapters,
      sportTypes: deps.sport.intervalsActivityTypes,
      attemptLedgerForRun: deps.attemptLedgerForRun,
    });
  const fetchReferenceDataForRun = (signal: AbortSignal) =>
    fetchReferenceData(signal, readIntervals(), resolveUserTimezone(deps.readCalendarTimeZone()));

  const mutex = new AsyncMutex();
  const cooldown = new Cooldown();
  const runSyncInternal = createRunSync({
    dataDir: referenceDataPath,
    mutex,
    cooldown,
    cooldownWindowMs: SYNC_COOLDOWN_MS,
    fetchReferenceData: fetchReferenceDataForRun,
  });
  const scheduler = new Scheduler({
    dataDir: referenceDataPath,
    runSync: runSyncInternal,
    intervalMs: SCHEDULED_SYNC_INTERVAL_MS,
  });

  if (deps.startScheduler !== false) {
    try {
      const firstSync = await runSyncInternal({ caller: "scheduled" });
      if (firstSync.kind === "failed") {
        console.warn(
          `${INITIAL_SYNC_FAILED_LOG_PREFIX} (${firstSync.reason}). Continuing with cached data if available; the next scheduled sync will retry.`,
        );
      }
    } catch (err) {
      console.warn(
        `${INITIAL_SYNC_FAILED_LOG_PREFIX} (${err instanceof Error ? err.message : String(err)}). Continuing with empty cache; lazy fallback will retry.`,
      );
    }
    scheduler.start();
  }

  const services: ReferenceServices = {
    runSync: (req) => runSyncInternal({ caller: "/sync", chatId: req.chatId }),
    loadLatest: (): LatestJson | null =>
      readLatestVersioned(join(referenceDataPath, "latest.json")),
    maybeRefreshIfStale: () => Promise.resolve({ kind: "fresh" }),
  };

  return {
    services,
    scheduler,
    runScheduledOnce: (signal) =>
      runWithRateLimitFollowUp(runSyncInternal, {
        caller: "scheduled",
        ...(signal === undefined ? {} : { signal }),
      }),
  };
}
