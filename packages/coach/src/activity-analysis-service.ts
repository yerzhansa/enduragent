import {
  ACTIVITY_ANALYSIS_SCHEMA_VERSION,
  ActivityAnalysisDataSchemaMap,
  ActivityAnalysisRequestSchema,
  ActivityAnalysisResultSchema,
  AnalysisUnavailableReasonSchema,
  MAX_ACTIVITY_ANALYSIS_RESPONSE_BYTES,
  type ActivityAnalysisData,
  type ActivityAnalysisRequest,
  type ActivityAnalysisResult,
  type ActivityAnalysisSection,
  type AnalysisComputed,
  type AnalysisRefreshFailureCode,
  type AnalysisSection,
  type AnalysisUnavailableReason,
  type CanonicalActivitySummary,
} from "@enduragent/coach-contract";
import {
  ACTIVITY_ANALYSIS_PROJECTION_CONTRACT_VERSION,
  createActivityAnalysisProjectionRepository,
  type ActivityAnalysisProjectionRepository,
  type CanonicalActivityDetail,
  type CanonicalActivityReader,
  type SqlStore,
  type TrustedActivitySourceResolution,
  type TrustedActivitySourceResolver,
  type TrustedProviderActivityId,
} from "@enduragent/kernel/store";
import { awaitWithSignal } from "./abortable-operation.js";

export const ACTIVITY_ANALYSIS_AGGREGATE_DEADLINE_MS = 90_000;
export const ACTIVITY_ANALYSIS_SECTION_CONCURRENCY = 2;
const MAX_MEMORY_CACHE_ENTRIES = 128 * 6;

const SECTION_RESULT_KEYS = {
  "aerobic-drift": "aerobicDrift",
  intervals: "intervals",
  "best-efforts": "bestEfforts",
  "power-distribution": "powerDistribution",
  "heart-rate-distribution": "heartRateDistribution",
  "power-heart-rate": "powerHeartRate",
} as const satisfies Record<ActivityAnalysisSection, keyof ActivityAnalysisData>;

export type ActivityAnalysisSourceStatus =
  | { readonly kind: "resolved"; readonly providerActivityId: TrustedProviderActivityId }
  | { readonly kind: "unavailable"; readonly reason: "source-not-found" | "ambiguous-source" };

export type ActivityAnalysisSectionOutput<K extends keyof ActivityAnalysisData> =
  | {
      readonly kind: "computed";
      readonly data: ActivityAnalysisData[K];
      readonly source: "local-canonical" | "provider";
    }
  | { readonly kind: "unavailable"; readonly reason: AnalysisUnavailableReason };

export interface ActivityAnalysisSectionInput {
  readonly activity: CanonicalActivityDetail;
  readonly sourceRevision: string;
  readonly source: ActivityAnalysisSourceStatus;
  readonly signal: AbortSignal;
}

export interface ActivityAnalysisSectionAnalyzer<K extends keyof ActivityAnalysisData> {
  analyze(input: ActivityAnalysisSectionInput): Promise<ActivityAnalysisSectionOutput<K>>;
}

export type ActivityAnalysisSectionAnalyzers = {
  readonly [K in keyof ActivityAnalysisData]?: ActivityAnalysisSectionAnalyzer<K>;
};

export interface ActivityAnalysisService {
  getActivityAnalysis(
    request: ActivityAnalysisRequest,
    signal?: AbortSignal,
  ): Promise<ActivityAnalysisResult>;
}

export interface ActivityAnalysisServiceOptions {
  readonly activities: Pick<CanonicalActivityReader, "getActivity">;
  readonly sources: TrustedActivitySourceResolver;
  readonly cache: ActivityAnalysisProjectionRepository;
  readonly analyzers?: ActivityAnalysisSectionAnalyzers;
  readonly runCacheWrite?: <T>(work: (signal: AbortSignal) => Promise<T>) => Promise<T>;
  readonly now?: () => number;
  readonly aggregateDeadlineMs?: number;
}

export class ActivityAnalysisServiceError extends Error {
  readonly code: "activity-not-found" | "invalid-clock";

  constructor(code: "activity-not-found" | "invalid-clock") {
    super(`activity analysis failed: ${code}`);
    this.name = "ActivityAnalysisServiceError";
    this.code = code;
  }
}

export class ActivityAnalysisComputationError extends Error {
  readonly code: AnalysisRefreshFailureCode;

  constructor(code: AnalysisRefreshFailureCode, options?: ErrorOptions) {
    super(`activity analysis section failed: ${code}`, options);
    this.name = "ActivityAnalysisComputationError";
    this.code = code;
  }
}

interface CacheIdentity {
  readonly canonicalActivityId: string;
  readonly sourceRevision: string;
  readonly section: ActivityAnalysisSection;
}

interface SharedSectionTask {
  readonly controller: AbortController;
  readonly promise: Promise<AnalysisSection<unknown>>;
  consumers: number;
  settled: boolean;
}

interface ActivityWaiter {
  readonly activityId: string;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
}

function cacheKey(identity: CacheIdentity): string {
  return `${identity.canonicalActivityId}\u0000${identity.sourceRevision}\u0000${identity.section}`;
}

function summary(activity: CanonicalActivityDetail): CanonicalActivitySummary {
  return {
    id: activity.id,
    workoutId: activity.workoutId,
    sessionSequence: activity.sessionSequence,
    isMultisport: activity.isMultisport,
    sport: activity.sport,
    subSport: activity.subSport,
    isTransition: activity.isTransition,
    startEpochSeconds: activity.startEpochSeconds,
    timezoneOffsetSeconds: activity.timezoneOffsetSeconds,
    localDate: activity.localDate,
    elapsedSeconds: activity.elapsedSeconds,
    timerSeconds: activity.timerSeconds,
    movingSeconds: activity.movingSeconds,
    distanceMeters: activity.distanceMeters,
  };
}

function nowInstant(now: () => number): { readonly epochSeconds: number; readonly instant: string } {
  const epochMilliseconds = now();
  if (!Number.isSafeInteger(epochMilliseconds) || epochMilliseconds < 0) {
    throw new ActivityAnalysisServiceError("invalid-clock");
  }
  return {
    epochSeconds: Math.floor(epochMilliseconds / 1_000),
    instant: new Date(epochMilliseconds).toISOString(),
  };
}

function sourceStatus(resolution: TrustedActivitySourceResolution): ActivityAnalysisSourceStatus {
  if (resolution.kind === "resolved") {
    return { kind: "resolved", providerActivityId: resolution.providerActivityId };
  }
  return {
    kind: "unavailable",
    reason: resolution.reason === "ambiguous" ? "ambiguous-source" : "source-not-found",
  };
}

function refreshFailureReason(code: AnalysisRefreshFailureCode): AnalysisUnavailableReason {
  if (code === "source-changed") return "temporary-failure";
  return AnalysisUnavailableReasonSchema.safeParse(code).success ? code : "temporary-failure";
}

function failureCode(
  error: unknown,
  deadline: AbortSignal,
  operation: AbortSignal,
): AnalysisRefreshFailureCode {
  if (error instanceof ActivityAnalysisComputationError) return error.code;
  if (deadline.aborted) return "timeout";
  if (operation.aborted) return "cancelled";
  if (error instanceof Error && error.name === "AbortError") return "cancelled";
  if (error instanceof Error && error.name === "ZodError") return "malformed-response";
  return "temporary-failure";
}

function persisted<T>(value: AnalysisComputed<T>): AnalysisComputed<T> {
  return {
    ...value,
    provenance: { ...value.provenance, delivery: "persisted-cache" },
  };
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function assertComputedSource(
  resultKey: keyof ActivityAnalysisData,
  data: ActivityAnalysisData[keyof ActivityAnalysisData],
  source: "local-canonical" | "provider",
  sourceStatusValue: ActivityAnalysisSourceStatus,
): void {
  if (source === "provider" && sourceStatusValue.kind !== "resolved") {
    throw new ActivityAnalysisComputationError("malformed-response");
  }
  if (
    resultKey === "intervals"
    && (data as ActivityAnalysisData["intervals"]).source !== source
  ) {
    throw new ActivityAnalysisComputationError("malformed-response");
  }
  if (resultKey === "powerHeartRate" && source !== "provider") {
    throw new ActivityAnalysisComputationError("malformed-response");
  }
}

class SectionSemaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  async run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    await this.acquire(signal);
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  private acquire(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.active < ACTIVITY_ANALYSIS_SECTION_CONCURRENCY) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const resume = (): void => {
        signal.removeEventListener("abort", abort);
        this.active += 1;
        resolve();
      };
      const abort = (): void => {
        const index = this.waiters.indexOf(resume);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal.reason);
      };
      this.waiters.push(resume);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  private release(): void {
    this.active -= 1;
    this.waiters.shift()?.();
  }
}

class ActivityGate {
  private activeActivityId: string | undefined;
  private activeCount = 0;
  private readonly waiters: ActivityWaiter[] = [];

  async run<T>(activityId: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    await this.acquire(activityId, signal);
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  private async acquire(activityId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.activeActivityId === undefined || this.activeActivityId === activityId) {
      this.activeActivityId = activityId;
      this.activeCount += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: ActivityWaiter = {
        activityId,
        resolve,
        reject,
        signal,
        onAbort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(signal.reason);
        },
      };
      this.waiters.push(waiter);
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      if (signal.aborted) waiter.onAbort();
    });
    return this.acquire(activityId, signal);
  }

  private release(): void {
    this.activeCount -= 1;
    if (this.activeCount !== 0) return;
    this.activeActivityId = undefined;
    const nextActivity = this.waiters[0]?.activityId;
    if (nextActivity === undefined) return;
    const ready = this.waiters.filter((waiter) => waiter.activityId === nextActivity);
    for (const waiter of ready) {
      const index = this.waiters.indexOf(waiter);
      if (index >= 0) this.waiters.splice(index, 1);
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve();
    }
  }
}

class ActivityAnalysisServiceImplementation implements ActivityAnalysisService {
  private readonly analyzers: ActivityAnalysisSectionAnalyzers;
  private readonly now: () => number;
  private readonly aggregateDeadlineMs: number;
  private readonly memory = new Map<string, AnalysisComputed<unknown>>();
  private readonly inFlight = new Map<string, SharedSectionTask>();
  private readonly sections = new SectionSemaphore();
  private readonly activities = new ActivityGate();

  constructor(private readonly options: ActivityAnalysisServiceOptions) {
    this.analyzers = options.analyzers ?? {};
    this.now = options.now ?? Date.now;
    this.aggregateDeadlineMs = options.aggregateDeadlineMs ?? ACTIVITY_ANALYSIS_AGGREGATE_DEADLINE_MS;
    if (!Number.isSafeInteger(this.aggregateDeadlineMs) || this.aggregateDeadlineMs < 1) {
      throw new TypeError("activity analysis deadline is invalid");
    }
  }

  async getActivityAnalysis(
    request: ActivityAnalysisRequest,
    signal?: AbortSignal,
  ): Promise<ActivityAnalysisResult> {
    const parsed = ActivityAnalysisRequestSchema.parse(request);
    const deadline = AbortSignal.timeout(this.aggregateDeadlineMs);
    const operationSignal = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
    return this.activities.run(parsed.canonicalActivityId, operationSignal, async () => {
      const activity = await awaitWithSignal(
        this.options.activities.getActivity({ id: parsed.canonicalActivityId }),
        operationSignal,
      );
      if (activity === undefined) throw new ActivityAnalysisServiceError("activity-not-found");
      operationSignal.throwIfAborted();
      const resolution = await awaitWithSignal(
        this.options.sources.resolve({ canonicalActivityId: parsed.canonicalActivityId }),
        operationSignal,
      );
      const revision = resolution.kind === "resolved" ? resolution.sourceRevision : activity.id;
      const context = { activity, sourceRevision: revision, source: sourceStatus(resolution) };
      const computed = await Promise.all(parsed.sections.map(async (section) => {
        const state = await this.section(
          { canonicalActivityId: activity.id, sourceRevision: revision, section },
          context,
          parsed.refresh === true,
          operationSignal,
          deadline,
        );
        return [SECTION_RESULT_KEYS[section], state] as const;
      }));
      const sectionStates: Record<string, AnalysisSection<unknown>> = {};
      const activitySummary = summary(activity);
      for (const [key, state] of computed) {
        const candidate = { ...sectionStates, [key]: state };
        const envelope = {
          schemaVersion: ACTIVITY_ANALYSIS_SCHEMA_VERSION,
          activity: activitySummary,
          revision,
          sections: candidate,
        };
        sectionStates[key] = byteLength(envelope) <= MAX_ACTIVITY_ANALYSIS_RESPONSE_BYTES
          ? state
          : { kind: "unavailable", reason: "response-too-large" };
      }
      return ActivityAnalysisResultSchema.parse({
        schemaVersion: ACTIVITY_ANALYSIS_SCHEMA_VERSION,
        activity: activitySummary,
        revision,
        sections: sectionStates,
      }) as ActivityAnalysisResult;
    });
  }

  private async section(
    identity: CacheIdentity,
    context: Omit<ActivityAnalysisSectionInput, "signal">,
    refresh: boolean,
    signal: AbortSignal,
    deadline: AbortSignal,
  ): Promise<AnalysisSection<unknown>> {
    let cached: AnalysisComputed<unknown> | undefined;
    try {
      cached = await this.readCache(identity, signal);
      if (!refresh && cached !== undefined) return persisted(cached);
      return await this.consumeShared(identity, context, signal);
    } catch (error) {
      const code = failureCode(error, deadline, signal);
      if (cached !== undefined) {
        return {
          kind: "stale",
          lastGood: persisted(cached),
          refreshFailure: { code, failedAt: nowInstant(this.now).instant },
        };
      }
      return { kind: "unavailable", reason: refreshFailureReason(code) };
    }
  }

  private consumeShared(
    identity: CacheIdentity,
    context: Omit<ActivityAnalysisSectionInput, "signal">,
    signal: AbortSignal,
  ): Promise<AnalysisSection<unknown>> {
    signal.throwIfAborted();
    const key = cacheKey(identity);
    let shared = this.inFlight.get(key);
    if (shared === undefined) {
      const controller = new AbortController();
      shared = {
        controller,
        consumers: 0,
        settled: false,
        promise: this.sections.run(controller.signal, () =>
          this.computeSection(identity, context, controller.signal)),
      };
      this.inFlight.set(key, shared);
      const selected = shared;
      void shared.promise.finally(() => {
        selected.settled = true;
        if (this.inFlight.get(key) === selected) this.inFlight.delete(key);
      }).catch(() => {});
    }
    shared.consumers += 1;
    return new Promise((resolve, reject) => {
      let claimed = false;
      const claim = (): void => {
        if (claimed) return;
        claimed = true;
        signal.removeEventListener("abort", abort);
        shared!.consumers -= 1;
        if (shared!.consumers === 0 && !shared!.settled) shared!.controller.abort();
      };
      const abort = (): void => {
        claim();
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      void shared.promise.then(
        (value) => {
          claim();
          resolve(value);
        },
        (error) => {
          claim();
          reject(error);
        },
      );
    });
  }

  private async computeSection(
    identity: CacheIdentity,
    context: Omit<ActivityAnalysisSectionInput, "signal">,
    signal: AbortSignal,
  ): Promise<AnalysisSection<unknown>> {
    const resultKey = SECTION_RESULT_KEYS[identity.section];
    const analyzer = this.analyzers[resultKey] as
      | ActivityAnalysisSectionAnalyzer<keyof ActivityAnalysisData>
      | undefined;
    if (analyzer === undefined) return { kind: "unavailable", reason: "unsupported" };
    const output = await analyzer.analyze({ ...context, signal });
    signal.throwIfAborted();
    if (output.kind === "unavailable") {
      return {
        kind: "unavailable",
        reason: AnalysisUnavailableReasonSchema.parse(output.reason),
      };
    }
    const data = ActivityAnalysisDataSchemaMap[resultKey].parse(output.data);
    assertComputedSource(resultKey, data, output.source, context.source);
    const observed = nowInstant(this.now);
    const computed: AnalysisComputed<unknown> = {
      kind: "computed",
      data,
      provenance: {
        source: output.source,
        delivery: "live",
        observedAt: observed.instant,
      },
    };
    const current = await this.options.sources.resolve({
      canonicalActivityId: identity.canonicalActivityId,
    });
    signal.throwIfAborted();
    const currentRevision = current.kind === "resolved" ? current.sourceRevision : identity.canonicalActivityId;
    if (currentRevision !== identity.sourceRevision) {
      throw new ActivityAnalysisComputationError("source-changed");
    }
    await this.writeCache(identity, computed, observed.epochSeconds, signal);
    return computed;
  }

  private async readCache(
    identity: CacheIdentity,
    signal: AbortSignal,
  ): Promise<AnalysisComputed<unknown> | undefined> {
    signal.throwIfAborted();
    const key = cacheKey(identity);
    const memory = this.memory.get(key);
    if (memory !== undefined) {
      this.memory.delete(key);
      this.memory.set(key, memory);
      return memory;
    }
    let stored;
    try {
      const accessed = nowInstant(this.now).epochSeconds;
      stored = await awaitWithSignal(
        this.cacheAccess((cache) => cache.read({
          canonicalActivityId: identity.canonicalActivityId,
          sourceRevision: identity.sourceRevision,
          contractVersion: ACTIVITY_ANALYSIS_PROJECTION_CONTRACT_VERSION,
          section: identity.section,
        }, accessed)),
        signal,
      );
    } catch {
      signal.throwIfAborted();
      return undefined;
    }
    if (stored === undefined) return undefined;
    try {
      const resultKey = SECTION_RESULT_KEYS[identity.section];
      const computed: AnalysisComputed<unknown> = {
        kind: "computed",
        data: ActivityAnalysisDataSchemaMap[resultKey].parse(JSON.parse(stored.dataJson)),
        provenance: {
          source: stored.source,
          delivery: "persisted-cache",
          observedAt: stored.observedAt,
        },
      };
      this.remember(key, computed);
      return computed;
    } catch {
      return undefined;
    }
  }

  private async writeCache(
    identity: CacheIdentity,
    computed: AnalysisComputed<unknown>,
    cachedEpochSeconds: number,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.cacheAccess((cache) => cache.write({
        canonicalActivityId: identity.canonicalActivityId,
        sourceRevision: identity.sourceRevision,
        contractVersion: ACTIVITY_ANALYSIS_PROJECTION_CONTRACT_VERSION,
        section: identity.section,
        source: computed.provenance.source,
        observedAt: computed.provenance.observedAt,
        dataJson: JSON.stringify(computed.data),
      }, cachedEpochSeconds));
      signal.throwIfAborted();
      this.remember(cacheKey(identity), computed);
    } catch {
      signal.throwIfAborted();
      // A cache failure must not hide a freshly validated computation.
    }
  }

  private cacheAccess<T>(
    operation: (cache: ActivityAnalysisProjectionRepository) => Promise<T>,
  ): Promise<T> {
    if (this.options.runCacheWrite === undefined) return operation(this.options.cache);
    return this.options.runCacheWrite(() => operation(this.options.cache));
  }

  private remember(key: string, value: AnalysisComputed<unknown>): void {
    this.memory.delete(key);
    this.memory.set(key, value);
    while (this.memory.size > MAX_MEMORY_CACHE_ENTRIES) {
      const oldest = this.memory.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.memory.delete(oldest);
    }
  }
}

export function createActivityAnalysisService(
  options: ActivityAnalysisServiceOptions,
): ActivityAnalysisService {
  return new ActivityAnalysisServiceImplementation(options);
}

export function createStoredActivityAnalysisService(input: Omit<
  ActivityAnalysisServiceOptions,
  "cache"
> & { readonly store: SqlStore }): ActivityAnalysisService {
  return createActivityAnalysisService({
    ...input,
    cache: createActivityAnalysisProjectionRepository(input.store),
  });
}
