import { performance } from "node:perf_hooks";
import type {
  Config,
  AthleteDataReader,
  ReferenceRuntime,
  SubsystemLogger,
} from "@enduragent/core";
import { createStoreAthleteDataReader, createSubsystemLogger } from "@enduragent/core";
import { resolveUserTimezone } from "@enduragent/engine/sport";
import {
  createCanonicalActivityReader,
  createPhysicalRequestLedger,
  type CanonicalActivityReader,
  type PhysicalRequestCounts,
  type PhysicalRequestLedger,
  type SqlReadStore,
  type SyncBudget,
} from "@enduragent/kernel/store";
import type { ReferenceCaptureManifest } from "@enduragent/kernel/reference/capture";
import type { ProducedLocalBundle } from "@enduragent/kernel/reference/local-bundle";
import type { AthleteHome } from "@enduragent/kernel-node/home";
import { openReadonlySqliteStorage } from "@enduragent/kernel-node/sqlite";
import {
  EMPTY_DROPPED_ACTIVITIES,
  type DroppedActivities,
} from "@enduragent/coach-contract";
import { join } from "node:path";
import { runAnalyticsCurveRefresh } from "./analytics-curves.js";
import { runReferenceCapture } from "./capture.js";
import { createLocalBundleProducer } from "./local-bundle-producer.js";
import type { CoachStoreWriterContext } from "./runtime.js";
import {
  createWallClockScheduler,
  type WallClockScheduler,
  type WallClockSchedulerDependencies,
} from "./daemon/scheduler.js";

export const STORE_REFRESH_INTERVAL_MS = 21_600_000;
export const STORE_REQUEST_LIMIT = 64 as const;
export const LEGACY_REQUEST_LIMIT = 15 as const;
export const TOTAL_REQUEST_LIMIT = 79 as const;
export const STORE_MAX_ARTIFACTS = 1_000;
export const STORE_REQUEST_TIMEOUT_MS = 30_000;
export const STORE_WINDOW_DEADLINE_MS = 600_000;
const CANONICAL_KEY = /^[0-9a-f]{64}$/;
const PUBLICATION_PAGE_SIZE = 200;
const PUBLICATION_DEADLINE_MS = 30_000;

export interface StoreWindowResult {
  readonly published: boolean;
  readonly counts: PhysicalRequestCounts;
  readonly legacySucceeded: boolean;
  readonly droppedActivities: DroppedActivities;
}

export interface StoreWriteResult<T> {
  readonly value: T;
  readonly activityReadAvailable: boolean;
}

export interface StoreRuntimeDependencies {
  readonly capture?: typeof runReferenceCapture;
  readonly refreshCurves?: typeof runAnalyticsCurveRefresh;
  readonly produce?: (manifest: ReferenceCaptureManifest) => Promise<ProducedLocalBundle>;
  readonly now?: () => Date;
  readonly monotonicNow?: () => number;
  readonly openReadonlyStore?: (path: string) => SqlReadStore;
  readonly schedulerDependencies?: Partial<WallClockSchedulerDependencies>;
}

export interface StoreRuntimeOptions {
  readonly env: Record<string, string | undefined>;
  readonly config: Config;
  readonly readConfig?: () => Config;
  readonly home: AthleteHome;
  readonly reference: ReferenceRuntime;
  readonly writerContext?: CoachStoreWriterContext;
  readonly dependencies?: StoreRuntimeDependencies;
  readonly platform?: NodeJS.Platform;
}

function sameHome(left: AthleteHome, right: AthleteHome): boolean {
  return (
    left.root === right.root &&
    left.storeDir === right.storeDir &&
    left.archiveDir === right.archiveDir &&
    left.configDir === right.configDir
  );
}

export class StoreRuntime {
  readonly athleteData: AthleteDataReader;
  private readonly openReadonlyStore: (path: string) => SqlReadStore;
  private readonly storePath: string;
  private readonlyStore: SqlReadStore | undefined;
  private readonly canonicalActivities: CanonicalActivityReader;
  private readonly dependencies: Required<
    Pick<StoreRuntimeDependencies, "capture" | "refreshCurves" | "produce" | "now" | "monotonicNow">
  >;
  private readonly logger: SubsystemLogger;
  private readonly scheduler: WallClockScheduler;
  private snapshotValue: ProducedLocalBundle | undefined;
  private activeLedger: PhysicalRequestLedger | undefined;
  private activeController: AbortController | undefined;
  private activeBeforeWindowController: AbortController | undefined;
  private activeWindow: Promise<StoreWindowResult> | undefined;
  private droppedActivitiesValue = EMPTY_DROPPED_ACTIVITIES;
  private admissionActive = false;
  private readonly admissionQueue: Array<() => void> = [];
  private readonly admissionDrainWaiters = new Set<() => void>();
  private activeAdmissionController: AbortController | undefined;
  private closePromise: Promise<void> | undefined;
  private closed = false;

  constructor(private readonly options: StoreRuntimeOptions) {
    if (
      options.writerContext !== undefined &&
      !sameHome(options.home, options.writerContext.home)
    ) {
      throw new TypeError("Writer home does not match the store runtime home.");
    }
    const dependencies = options.dependencies ?? {};
    const now = dependencies.now ?? (() => new Date());
    const schedulerDependencies = dependencies.schedulerDependencies ?? {};
    this.logger = createSubsystemLogger("sync", options.home.root);
    this.dependencies = {
      capture: dependencies.capture ?? runReferenceCapture,
      refreshCurves: dependencies.refreshCurves ?? runAnalyticsCurveRefresh,
      produce:
        dependencies.produce ??
        ((manifest) =>
          createLocalBundleProducer({
            storePath: join(options.home.storeDir, "store.db"),
            archiveRoot: options.home.archiveDir,
          }).produce(manifest)),
      now,
      monotonicNow: dependencies.monotonicNow ?? (() => performance.now()),
    };
    this.openReadonlyStore = dependencies.openReadonlyStore ?? openReadonlySqliteStorage;
    this.storePath = join(options.home.storeDir, "store.db");
    this.canonicalActivities = {
      listActivities: (input) => this.canonicalActivityReader().listActivities(input),
      getActivity: (input) => this.canonicalActivityReader().getActivity(input),
      getStreams: (input) => this.canonicalActivityReader().getStreams(input),
    };
    try {
      this.canonicalActivityReader();
    } catch {}
    this.scheduler = createWallClockScheduler({
      cadenceMs: STORE_REFRESH_INTERVAL_MS,
      run: async () => {
        await this.runWindow();
      },
      onError: (error) => {
        this.logger.error("scheduled_store_refresh_failed", error);
      },
      dependencies: {
        nowEpochMs: schedulerDependencies.nowEpochMs ?? (() => now().getTime()),
        setTimeout: schedulerDependencies.setTimeout ?? globalThis.setTimeout,
        clearTimeout: schedulerDependencies.clearTimeout ?? globalThis.clearTimeout,
      },
    });
    this.athleteData = createStoreAthleteDataReader({
      snapshot: () => this.snapshotValue,
      canonicalActivities: this.canonicalActivities,
      clockNow: () => this.dependencies.now().getTime(),
    });
  }

  attemptLedgerForRun(): PhysicalRequestLedger {
    if (this.activeLedger === undefined) throw new Error("No paired refresh window is active.");
    return this.activeLedger;
  }

  currentSnapshot(): ProducedLocalBundle | undefined {
    return this.snapshotValue;
  }

  startScheduler(): void {
    if (this.closed) return;
    this.scheduler.start();
  }

  runWindow(): Promise<StoreWindowResult> {
    if (this.closed) return Promise.reject(new Error("Store runtime is closed."));
    if (this.activeWindow !== undefined) return this.activeWindow;
    const task = this.runExclusive((signal) => this.runWindowInternal(signal));
    this.installActiveWindow(task);
    return task;
  }

  runWindowAfter(work: (signal: AbortSignal) => Promise<void>): Promise<StoreWindowResult> {
    if (typeof work !== "function")
      return Promise.reject(new TypeError("Window work must be a function."));
    if (this.closed) return Promise.reject(new Error("Store runtime is closed."));
    const task = this.runExclusive(async (signal) => {
      this.activeBeforeWindowController = this.activeAdmissionController;
      try {
        await work(signal);
        signal.throwIfAborted();
        return await this.runWindowInternal(signal);
      } finally {
        this.activeBeforeWindowController = undefined;
      }
    });
    this.installActiveWindow(task);
    return task;
  }

  currentDroppedActivities(): DroppedActivities {
    return this.droppedActivitiesValue;
  }

  runExclusive<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (typeof work !== "function") {
      return Promise.reject(new TypeError("Exclusive work must be a function."));
    }
    if (this.closed) return Promise.reject(new Error("Store runtime is closed."));
    return new Promise<T>((resolve, reject) => {
      const run = (): void => {
        if (this.closed) {
          reject(new Error("Store runtime is closed."));
          this.advanceAdmission();
          return;
        }
        this.admissionActive = true;
        const controller = new AbortController();
        this.activeAdmissionController = controller;
        let task: Promise<T>;
        try {
          task = Promise.resolve(work(controller.signal));
        } catch (error) {
          task = Promise.reject(error);
        }
        void task.then(resolve, reject).finally(() => {
          if (this.activeAdmissionController === controller) {
            this.activeAdmissionController = undefined;
          }
          this.advanceAdmission();
        });
      };
      if (this.admissionActive) this.admissionQueue.push(run);
      else run();
    });
  }

  private advanceAdmission(): void {
    this.admissionActive = false;
    const next = this.admissionQueue.shift();
    if (next !== undefined) {
      next();
      return;
    }
    for (const resolve of this.admissionDrainWaiters) resolve();
    this.admissionDrainWaiters.clear();
  }

  private drainAdmissions(): Promise<void> {
    if (!this.admissionActive && this.admissionQueue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.admissionDrainWaiters.add(resolve));
  }

  private canonicalActivityReader(): CanonicalActivityReader {
    if (this.readonlyStore === undefined) {
      this.readonlyStore = this.openReadonlyStore(this.storePath);
    }
    return createCanonicalActivityReader(this.readonlyStore);
  }

  private async attestCanonicalActivities(
    workoutKeys: readonly string[],
    signal: AbortSignal,
  ): Promise<boolean> {
    if (workoutKeys.length < 1 || workoutKeys.some((key) => !CANONICAL_KEY.test(key))) {
      return false;
    }
    const uniqueWorkoutKeys = [...new Set(workoutKeys)];
    if (uniqueWorkoutKeys.length !== workoutKeys.length) return false;
    const reader = this.canonicalActivityReader();
    const deadline = this.dependencies.monotonicNow() + PUBLICATION_DEADLINE_MS;
    const withinBudget = (): boolean => {
      signal.throwIfAborted();
      return this.dependencies.monotonicNow() <= deadline;
    };
    let streamReadbackComplete = false;
    for (const workoutKey of uniqueWorkoutKeys) {
      if (!withinBudget()) return false;
      const rows = await this.readonlyStore!.all(
        `SELECT
  s.session_key,
  count(st.channel) AS stream_count,
  count(CASE WHEN st.channel = 'time' THEN 1 END) AS time_count
FROM session AS s
LEFT JOIN stream AS st ON st.session_key = s.session_key
WHERE s.workout_key = ?
GROUP BY s.session_key, s.session_seq
ORDER BY time_count DESC, stream_count DESC, s.session_seq ASC, s.session_key ASC
LIMIT 1`,
        [workoutKey],
      );
      if (!withinBudget() || rows.length !== 1) return false;
      const row = rows[0]!;
      if (typeof row.session_key !== "string" || !CANONICAL_KEY.test(row.session_key)) {
        return false;
      }
      if (
        typeof row.stream_count !== "number" ||
        !Number.isSafeInteger(row.stream_count) ||
        row.stream_count < 0 ||
        typeof row.time_count !== "number" ||
        !Number.isSafeInteger(row.time_count) ||
        row.time_count < 0 ||
        row.time_count > 1 ||
        (row.stream_count === 0 && row.time_count !== 0) ||
        (row.stream_count > 0 && row.time_count !== 1)
      ) {
        return false;
      }
      const detail = await reader.getActivity({ id: row.session_key });
      if (!withinBudget() || detail === undefined || detail.workoutId !== workoutKey) return false;
      let cursor: { readonly startEpochSeconds: number; readonly id: string } | undefined;
      let listed = false;
      while (!listed) {
        if (!withinBudget()) return false;
        const page = await reader.listActivities({
          start: detail.localDate,
          end: detail.localDate,
          limit: PUBLICATION_PAGE_SIZE,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (!withinBudget()) return false;
        listed = page.activities.some(
          (activity) => activity.id === detail.id && activity.workoutId === workoutKey,
        );
        if (listed) break;
        if (page.nextCursor === null) return false;
        cursor = page.nextCursor;
      }
      if (row.stream_count > 0 && !streamReadbackComplete) {
        const readable = await reader.getStreams({ id: detail.id, channels: ["time"] });
        if (
          !withinBudget() ||
          readable === undefined ||
          readable.activityId !== detail.id ||
          !Array.isArray(readable.channels.time) ||
          readable.channels.time.length < 1
        ) {
          return false;
        }
        streamReadbackComplete = true;
      }
    }
    return true;
  }

  runActivityWrite<T>(
    work: (signal: AbortSignal) => Promise<T>,
    workoutKeys: (value: T) => readonly string[],
  ): Promise<StoreWriteResult<T>> {
    return this.runExclusive(async (signal) => {
      const value = await work(signal);
      signal.throwIfAborted();
      let activityReadAvailable = false;
      try {
        activityReadAvailable = await this.attestCanonicalActivities(workoutKeys(value), signal);
      } catch {
        signal.throwIfAborted();
      }
      signal.throwIfAborted();
      return Object.freeze({ value, activityReadAvailable });
    });
  }

  private installActiveWindow(task: Promise<StoreWindowResult>): void {
    this.activeWindow = task;
    void task
      .finally(() => {
        if (this.activeWindow === task) this.activeWindow = undefined;
      })
      .catch(() => {});
  }

  private async runWindowInternal(admissionSignal: AbortSignal): Promise<StoreWindowResult> {
    admissionSignal.throwIfAborted();
    const config = this.options.readConfig?.() ?? this.options.config;
    const calendarTimeZone = resolveUserTimezone(config.session.timezone);
    if (config.intervals.apiKey.length === 0) {
      return Object.freeze({
        published: false,
        counts: createPhysicalRequestLedger({
          storeLimit: STORE_REQUEST_LIMIT,
          legacyLimit: LEGACY_REQUEST_LIMIT,
          totalLimit: TOTAL_REQUEST_LIMIT,
        }).snapshot(),
        legacySucceeded: true,
        droppedActivities: this.droppedActivitiesValue,
      });
    }
    const ledger = createPhysicalRequestLedger({
      storeLimit: STORE_REQUEST_LIMIT,
      legacyLimit: LEGACY_REQUEST_LIMIT,
      totalLimit: TOTAL_REQUEST_LIMIT,
    });
    const controller = new AbortController();
    const abortWindow = (): void => controller.abort(admissionSignal.reason);
    if (admissionSignal.aborted) abortWindow();
    else admissionSignal.addEventListener("abort", abortWindow, { once: true });
    this.activeLedger = ledger;
    this.activeController = controller;
    const now = this.dependencies.now();
    const monotonicStart = this.dependencies.monotonicNow();
    const budget: SyncBudget = {
      signal: controller.signal,
      clock: { monotonicNow: this.dependencies.monotonicNow },
      deadlineMonotonicMs: monotonicStart + STORE_WINDOW_DEADLINE_MS,
      perRequestTimeoutMs: STORE_REQUEST_TIMEOUT_MS,
      maxRequests: STORE_REQUEST_LIMIT,
      maxArtifacts: STORE_MAX_ARTIFACTS,
    };
    try {
      controller.signal.throwIfAborted();
      const capturePromise = this.dependencies.capture({
        env: this.options.env,
        ...(this.options.writerContext === undefined
          ? {}
          : { writerContext: this.options.writerContext }),
        apiKey: config.intervals.apiKey,
        athleteId: config.intervals.athleteId,
        calendarTimeZone,
        reviewedOn: now.toISOString().slice(0, 10),
        reason: this.snapshotValue === undefined ? "initial" : "provider-refresh",
        ...(this.snapshotValue === undefined
          ? {}
          : { replacesCaptureId: this.snapshotValue.captureId }),
        budget,
        attemptLedger: ledger,
        ...(this.options.platform === undefined ? {} : { platform: this.options.platform }),
      });
      const legacyPromise = this.options.reference.runScheduledOnce(controller.signal);
      const [captureResult, legacyResult] = await Promise.allSettled([
        capturePromise,
        legacyPromise,
      ]);
      controller.signal.throwIfAborted();
      let published = false;
      if (captureResult.status === "fulfilled" && captureResult.value !== undefined) {
        try {
          await this.dependencies.refreshCurves({
            env: this.options.env,
            ...(this.options.writerContext === undefined
              ? {}
              : { writerContext: this.options.writerContext }),
            apiKey: config.intervals.apiKey,
            athleteId: config.intervals.athleteId,
            frozenAt: now,
            frozenOn: captureResult.value.plan.frozenNow.slice(0, 10),
            budget,
            attemptLedger: ledger,
          });
        } catch (error) {
          this.logger.warn("analytics_curve_refresh_failed", error);
        }
        controller.signal.throwIfAborted();
        const produced = await this.dependencies.produce(captureResult.value);
        this.snapshotValue = produced;
        published = true;
      }
      const counts = ledger.snapshot();
      if (captureResult.status === "rejected") throw captureResult.reason;
      const droppedActivities =
        legacyResult.status === "fulfilled" && legacyResult.value.kind === "ran"
          ? legacyResult.value.droppedActivities
          : this.droppedActivitiesValue;
      if (legacyResult.status === "fulfilled" && legacyResult.value.kind === "ran") {
        this.droppedActivitiesValue = droppedActivities;
      }
      return Object.freeze({
        published,
        counts,
        legacySucceeded:
          legacyResult.status === "fulfilled" && legacyResult.value.kind !== "failed",
        droppedActivities,
      });
    } finally {
      admissionSignal.removeEventListener("abort", abortWindow);
      if (this.activeLedger === ledger) this.activeLedger = undefined;
      if (this.activeController === controller) this.activeController = undefined;
    }
  }

  close(): Promise<void> {
    this.closePromise ??= (async () => {
      this.closed = true;
      const reason = new Error("Store runtime closed.");
      this.activeAdmissionController?.abort(reason);
      this.activeBeforeWindowController?.abort(reason);
      this.activeController?.abort(reason);
      let failure: unknown;
      try {
        await this.scheduler.close();
      } catch (error) {
        failure = error;
      }
      try {
        await this.drainAdmissions();
      } catch (error) {
        failure ??= error;
      }
      try {
        await this.readonlyStore?.close();
      } catch (error) {
        failure ??= error;
      }
      if (failure !== undefined) throw failure;
    })();
    return this.closePromise;
  }
}

export function createStoreRuntime(options: StoreRuntimeOptions): StoreRuntime {
  return new StoreRuntime(options);
}
