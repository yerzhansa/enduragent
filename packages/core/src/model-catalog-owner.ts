import { mkdirSync, readFileSync } from "node:fs";
import { uptime } from "node:os";
import { join, resolve } from "node:path";
import { ModelCatalogSnapshotSchema } from "@enduragent/coach-contract/model-catalog";
import { z } from "zod";
import {
  InterprocessFileLockTimeoutError,
  withInterprocessFileLock,
} from "./io/interprocess-file-lock-sync.js";
import { acceptModelCatalogSnapshot, type AcceptedModelCatalogRecord } from "./model-catalog.js";
import {
  MODEL_CATALOG_REFRESH_INTERVAL_MS,
  claimAttempt,
  completeAttempt,
  readAttempt,
  reanchorAttempt,
  serializedTime,
  writeJson,
  type ModelCatalogPaths,
} from "./model-catalog-attempt.js";
import {
  MODEL_CATALOG_ENDPOINT,
  MODEL_CATALOG_REQUEST_TIMEOUT_MS,
  MODEL_CATALOG_RESPONSE_LIMIT_BYTES,
  cancelResponseBody,
  nodeTlsVerificationEnabled,
  readBoundedBody,
  singleDispatchFetch,
} from "./model-catalog-http.js";
import { CatalogEtagSchema, createCatalogRefreshSession } from "./model-catalog-refresh.js";
import { BUNDLED_MODEL_CATALOG } from "./model-catalog-seed.js";

export {
  MODEL_CATALOG_ENDPOINT,
  MODEL_CATALOG_REFRESH_INTERVAL_MS,
  MODEL_CATALOG_REQUEST_TIMEOUT_MS,
  MODEL_CATALOG_RESPONSE_LIMIT_BYTES,
};
export type { ModelCatalogPaths };

const RECORD_FORMAT_VERSION = 1;
const OWNER_ACQUIRE_TIMEOUT_MS = 50;
const SCHEDULER_RECHECK_LIMIT_MS = MODEL_CATALOG_REFRESH_INTERVAL_MS;
const SCHEDULER_MIN_DELAY_MS = 1_000;
const HIGH_RESOLUTION_CLOCK_RESOLUTION_MS = 1;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;
const SYSTEM_UPTIME_RESOLUTION_MS = 1_000;

const PersistedCatalogSchema = z
  .object({
    formatVersion: z.literal(RECORD_FORMAT_VERSION),
    etag: CatalogEtagSchema.optional(),
    lastSuccessfulRefreshAt: z.string().datetime({ offset: true }).optional(),
    snapshot: ModelCatalogSnapshotSchema,
  })
  .strict();

type PersistedCatalog = z.infer<typeof PersistedCatalogSchema>;

export type LocalModelCatalogOrigin = "bundled" | "private-cache" | "installation";

export interface LocalModelCatalogSnapshot extends AcceptedModelCatalogRecord {
  readonly origin: LocalModelCatalogOrigin;
  readonly lastSuccessfulRefreshAt?: string;
  readonly revision: number;
}

export type ModelCatalogRefreshRetainedReason =
  | "claim-failed"
  | "http-error"
  | "invalid-not-modified"
  | "invalid-response"
  | "no-usable-choices"
  | "not-due"
  | "not-owner"
  | "persistence-failed"
  | "request-failed"
  | "response-too-large"
  | "shutdown"
  | "stale-revision";

export type ModelCatalogRefreshOutcome =
  | Readonly<{ kind: "updated"; revision: number }>
  | Readonly<{ kind: "unchanged"; revision: number }>
  | Readonly<{
      kind: "retained";
      reason: ModelCatalogRefreshRetainedReason;
      revision: number;
    }>;

export type ModelCatalogLifecycleOutcome =
  | Readonly<{ kind: "owner" }>
  | Readonly<{ kind: "reader"; reason: "owned-elsewhere" | "unavailable" }>
  | Readonly<{ kind: "closed" }>;

export interface ModelCatalogDiagnostics {
  readonly lastAttemptAt?: string;
  readonly lastSuccessfulRefreshAt?: string;
  readonly ownsLifecycle: boolean;
}

export interface ModelCatalogOpenInput {
  readonly cacheDirectory: string;
  readonly installationRoot: string;
}

export interface ModelCatalog {
  current(): LocalModelCatalogSnapshot;
  diagnostics(): ModelCatalogDiagnostics;
  notifyResumed(): void;
  refresh(): Promise<ModelCatalogRefreshOutcome>;
  shutdown(): Promise<void>;
  start(): Promise<ModelCatalogLifecycleOutcome>;
}

interface ModelCatalogDependencies {
  readonly afterAttemptClaim?: () => Promise<void> | void;
  readonly beforePublish?: () => Promise<void> | void;
  readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  readonly elapsedClock: ElapsedClock;
  readonly endpoint: string;
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => number;
  readonly ownerAcquireTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly setTimer: (task: () => void, delay: number) => ReturnType<typeof setTimeout>;
}

export interface ModelCatalogTestingDependencies {
  readonly afterAttemptClaim?: () => Promise<void> | void;
  readonly beforePublish?: () => Promise<void> | void;
  readonly clearTimer?: ModelCatalogDependencies["clearTimer"];
  readonly elapsedNow?: () => number;
  readonly elapsedResolutionMs?: number;
  readonly endpoint?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => number;
  readonly ownerAcquireTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly setTimer?: ModelCatalogDependencies["setTimer"];
}

interface ElapsedClock {
  readonly now: () => number;
  readonly resolutionMs: number;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  if (resolvePromise === undefined) throw new Error("Unable to create deferred value");
  return { promise, resolve: resolvePromise };
}

function defaultDependencies(
  overrides: ModelCatalogTestingDependencies = {},
): ModelCatalogDependencies {
  const systemElapsedClock: ElapsedClock =
    process.platform === "darwin"
      ? {
          now: () => Number(process.hrtime.bigint() / NANOSECONDS_PER_MILLISECOND),
          resolutionMs: HIGH_RESOLUTION_CLOCK_RESOLUTION_MS,
        }
      : {
          now: () => uptime() * 1_000,
          resolutionMs: SYSTEM_UPTIME_RESOLUTION_MS,
        };
  return {
    clearTimer: overrides.clearTimer ?? clearTimeout,
    elapsedClock: {
      now: overrides.elapsedNow ?? systemElapsedClock.now,
      resolutionMs:
        overrides.elapsedResolutionMs ??
        (overrides.elapsedNow === undefined ? systemElapsedClock.resolutionMs : 0),
    },
    endpoint: overrides.endpoint ?? MODEL_CATALOG_ENDPOINT,
    fetch: overrides.fetch ?? singleDispatchFetch,
    now: overrides.now ?? Date.now,
    ownerAcquireTimeoutMs: overrides.ownerAcquireTimeoutMs ?? OWNER_ACQUIRE_TIMEOUT_MS,
    requestTimeoutMs: overrides.requestTimeoutMs ?? MODEL_CATALOG_REQUEST_TIMEOUT_MS,
    setTimer: overrides.setTimer ?? setTimeout,
    ...(overrides.afterAttemptClaim === undefined
      ? {}
      : { afterAttemptClaim: overrides.afterAttemptClaim }),
    ...(overrides.beforePublish === undefined ? {} : { beforePublish: overrides.beforePublish }),
  };
}

export function resolveModelCatalogPaths(input: ModelCatalogOpenInput): ModelCatalogPaths {
  const installationRoot = resolve(input.installationRoot);
  const installationDirectory = join(installationRoot, "config", "model-catalog");
  const privateDirectory = resolve(input.cacheDirectory);
  return Object.freeze({
    attemptLock: join(installationDirectory, ".attempt.lock"),
    attemptState: join(installationDirectory, "last-attempt.json"),
    installationDirectory,
    ownerLock: join(installationDirectory, ".owner.lock"),
    ownerSnapshot: join(installationDirectory, "accepted-snapshot.json"),
    privateDirectory,
    privateSnapshot: join(privateDirectory, "model-catalog.json"),
  });
}

function readPersistedCatalog(path: string): PersistedCatalog | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  const persisted = PersistedCatalogSchema.safeParse(parsed);
  if (!persisted.success) return undefined;
  return acceptModelCatalogSnapshot(persisted.data.snapshot, persisted.data.etag) === undefined
    ? undefined
    : persisted.data;
}

function localSnapshot(
  persisted: PersistedCatalog,
  origin: Exclude<LocalModelCatalogOrigin, "bundled">,
): LocalModelCatalogSnapshot | undefined {
  const accepted = acceptModelCatalogSnapshot(persisted.snapshot, persisted.etag);
  if (accepted === undefined) return undefined;
  return Object.freeze({
    ...accepted,
    origin,
    revision: accepted.snapshot.revision,
    ...(persisted.lastSuccessfulRefreshAt === undefined
      ? {}
      : { lastSuccessfulRefreshAt: persisted.lastSuccessfulRefreshAt }),
  });
}

function bundledSnapshot(): LocalModelCatalogSnapshot {
  const accepted = acceptModelCatalogSnapshot(BUNDLED_MODEL_CATALOG);
  if (accepted === undefined) throw new Error("Bundled model catalog is invalid");
  return Object.freeze({ ...accepted, origin: "bundled", revision: accepted.snapshot.revision });
}

function persistedFrom(snapshot: LocalModelCatalogSnapshot): PersistedCatalog {
  return {
    formatVersion: RECORD_FORMAT_VERSION,
    ...(snapshot.etag === undefined ? {} : { etag: snapshot.etag }),
    ...(snapshot.lastSuccessfulRefreshAt === undefined
      ? {}
      : { lastSuccessfulRefreshAt: snapshot.lastSuccessfulRefreshAt }),
    snapshot: snapshot.snapshot,
  };
}

function originRank(origin: LocalModelCatalogOrigin): number {
  switch (origin) {
    case "bundled":
      return 0;
    case "private-cache":
      return 1;
    case "installation":
      return 2;
  }
}

function successfulRefreshTime(snapshot: LocalModelCatalogSnapshot): number {
  if (snapshot.lastSuccessfulRefreshAt === undefined) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(snapshot.lastSuccessfulRefreshAt);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function newerSnapshot(
  current: LocalModelCatalogSnapshot,
  candidate: LocalModelCatalogSnapshot | undefined,
): LocalModelCatalogSnapshot {
  if (candidate === undefined) return current;
  if (candidate.revision > current.revision) return candidate;
  if (candidate.revision < current.revision) return current;
  const candidateOriginRank = originRank(candidate.origin);
  const currentOriginRank = originRank(current.origin);
  if (candidateOriginRank > currentOriginRank) return candidate;
  if (candidateOriginRank < currentOriginRank) return current;
  return successfulRefreshTime(candidate) > successfulRefreshTime(current) ? candidate : current;
}

class InstallationModelCatalog implements ModelCatalog {
  private readonly dependencies: ModelCatalogDependencies;
  private readonly paths: ModelCatalogPaths;
  private activeRefresh: Promise<ModelCatalogRefreshOutcome> | undefined;
  private automaticCycle: Promise<void> | undefined;
  private closed = false;
  private currentSnapshot: LocalModelCatalogSnapshot;
  private lifecyclePromise: Promise<void> | undefined;
  private lifecycleResult: Promise<ModelCatalogLifecycleOutcome> | undefined;
  private lastAttemptElapsedAt: number | undefined;
  private ownsLifecycle = false;
  private requestController: AbortController | undefined;
  private schedulerTimer: ReturnType<typeof setTimeout> | undefined;
  private stopOwnership: Deferred<void> | undefined;

  constructor(input: ModelCatalogOpenInput, dependencies: ModelCatalogDependencies) {
    this.dependencies = dependencies;
    this.paths = resolveModelCatalogPaths(input);
    const privatePersisted = readPersistedCatalog(this.paths.privateSnapshot);
    const ownerPersisted = readPersistedCatalog(this.paths.ownerSnapshot);
    let selected = bundledSnapshot();
    selected = newerSnapshot(
      selected,
      privatePersisted === undefined ? undefined : localSnapshot(privatePersisted, "private-cache"),
    );
    selected = newerSnapshot(
      selected,
      ownerPersisted === undefined ? undefined : localSnapshot(ownerPersisted, "installation"),
    );
    this.currentSnapshot = selected;
    if (selected.origin === "installation") this.adopt(selected);
  }

  current(): LocalModelCatalogSnapshot {
    const persisted = readPersistedCatalog(this.paths.ownerSnapshot);
    const fromOwner =
      persisted === undefined ? undefined : localSnapshot(persisted, "installation");
    const selected = newerSnapshot(this.currentSnapshot, fromOwner);
    if (selected !== this.currentSnapshot) this.adopt(selected);
    return this.currentSnapshot;
  }

  diagnostics(): ModelCatalogDiagnostics {
    const attempt = readAttempt(this.paths.attemptState);
    const current = this.current();
    return Object.freeze({
      ...(attempt.kind === "in-flight" || attempt.kind === "completed"
        ? { lastAttemptAt: attempt.anchor.serialized }
        : {}),
      ...(current.lastSuccessfulRefreshAt === undefined
        ? {}
        : { lastSuccessfulRefreshAt: current.lastSuccessfulRefreshAt }),
      ownsLifecycle: this.ownsLifecycle,
    });
  }

  notifyResumed(): void {
    if (!this.ownsLifecycle || this.closed) return;
    if (this.automaticCycle !== undefined) return;
    this.clearScheduledTimer();
    this.startAutomaticCycle();
  }

  refresh(): Promise<ModelCatalogRefreshOutcome> {
    if (this.closed) return Promise.resolve(this.retained("shutdown"));
    if (!this.ownsLifecycle) return Promise.resolve(this.retained("not-owner"));
    if (this.activeRefresh !== undefined) return this.activeRefresh;
    const task = this.runRefresh().finally(() => {
      if (this.activeRefresh === task) this.activeRefresh = undefined;
    });
    this.activeRefresh = task;
    return task;
  }

  async shutdown(): Promise<void> {
    if (this.closed) {
      await this.lifecyclePromise;
      return;
    }
    this.closed = true;
    this.clearScheduledTimer();
    this.requestController?.abort();
    await this.activeRefresh;
    await this.automaticCycle;
    this.stopOwnership?.resolve();
    await this.lifecyclePromise;
  }

  start(): Promise<ModelCatalogLifecycleOutcome> {
    if (this.closed) return Promise.resolve({ kind: "closed" });
    if (this.ownsLifecycle) return Promise.resolve({ kind: "owner" });
    if (this.lifecycleResult !== undefined) return this.lifecycleResult;
    try {
      mkdirSync(this.paths.installationDirectory, { recursive: true, mode: 0o700 });
    } catch {
      return Promise.resolve({ kind: "reader", reason: "unavailable" });
    }
    const result = deferred<ModelCatalogLifecycleOutcome>();
    let entered = false;
    const lifecycle = withInterprocessFileLock(
      this.paths.ownerLock,
      async () => {
        entered = true;
        if (this.closed) {
          result.resolve({ kind: "closed" });
          return;
        }
        this.ownsLifecycle = true;
        this.stopOwnership = deferred<void>();
        this.reconcileOwnerSnapshot();
        result.resolve({ kind: "owner" });
        this.startAutomaticCycle();
        await this.stopOwnership.promise;
      },
      { timeoutMs: this.dependencies.ownerAcquireTimeoutMs },
    )
      .catch((error: unknown) => {
        if (!entered) {
          this.lifecyclePromise = undefined;
          this.lifecycleResult = undefined;
          result.resolve(
            error instanceof InterprocessFileLockTimeoutError
              ? { kind: "reader", reason: "owned-elsewhere" }
              : { kind: "reader", reason: "unavailable" },
          );
        }
      })
      .finally(() => {
        this.ownsLifecycle = false;
        this.stopOwnership = undefined;
        this.clearScheduledTimer();
      });
    this.lifecyclePromise = lifecycle;
    this.lifecycleResult = result.promise;
    return result.promise;
  }

  private adopt(snapshot: LocalModelCatalogSnapshot): void {
    this.currentSnapshot = snapshot;
    try {
      mkdirSync(this.paths.privateDirectory, { recursive: true, mode: 0o700 });
      writeJson(this.paths.privateSnapshot, persistedFrom(snapshot));
    } catch {}
  }

  private clearScheduledTimer(): void {
    if (this.schedulerTimer === undefined) return;
    this.dependencies.clearTimer(this.schedulerTimer);
    this.schedulerTimer = undefined;
  }

  private persistOwner(snapshot: LocalModelCatalogSnapshot): boolean {
    try {
      mkdirSync(this.paths.installationDirectory, { recursive: true, mode: 0o700 });
      writeJson(this.paths.ownerSnapshot, persistedFrom(snapshot));
      return true;
    } catch {
      return false;
    }
  }

  private reconcileOwnerSnapshot(): void {
    const current = this.current();
    const owner = readPersistedCatalog(this.paths.ownerSnapshot);
    if (owner !== undefined && owner.snapshot.revision >= current.revision) return;
    if (current.origin !== "bundled") this.persistOwner(current);
  }

  private retained(reason: ModelCatalogRefreshRetainedReason): ModelCatalogRefreshOutcome {
    return Object.freeze({ kind: "retained", reason, revision: this.current().revision });
  }

  private elapsedWindowMs(): number {
    return MODEL_CATALOG_REFRESH_INTERVAL_MS + this.dependencies.elapsedClock.resolutionMs;
  }

  private elapsedNow(): number {
    try {
      return this.dependencies.elapsedClock.now();
    } catch {
      return Number.NaN;
    }
  }

  private elapsedWindowRemaining(now = this.elapsedNow()): number | undefined {
    if (this.lastAttemptElapsedAt === undefined) return undefined;
    const elapsed = now - this.lastAttemptElapsedAt;
    const elapsedWindowMs = this.elapsedWindowMs();
    if (!Number.isFinite(elapsed) || elapsed < 0) return elapsedWindowMs;
    return elapsed < elapsedWindowMs ? elapsedWindowMs - elapsed : undefined;
  }

  private scheduleNext(outcome: ModelCatalogRefreshOutcome): void {
    if (!this.ownsLifecycle || this.closed) return;
    const now = this.dependencies.now();
    const attempt = readAttempt(this.paths.attemptState);
    let delay = MODEL_CATALOG_REFRESH_INTERVAL_MS;
    if (outcome.kind === "retained" && outcome.reason === "not-due") {
      const elapsedRemaining = this.elapsedWindowRemaining();
      const remaining = [
        ...(attempt.kind === "in-flight" || attempt.kind === "completed"
          ? [attempt.anchor.lastAttemptAt + MODEL_CATALOG_REFRESH_INTERVAL_MS - now]
          : []),
        ...(elapsedRemaining === undefined ? [] : [elapsedRemaining]),
      ].filter(Number.isFinite);
      if (remaining.length > 0) delay = Math.max(...remaining);
    }
    if (!Number.isFinite(delay)) delay = MODEL_CATALOG_REFRESH_INTERVAL_MS;
    delay = Math.max(SCHEDULER_MIN_DELAY_MS, Math.min(SCHEDULER_RECHECK_LIMIT_MS, delay));
    this.clearScheduledTimer();
    this.schedulerTimer = this.dependencies.setTimer(() => {
      this.schedulerTimer = undefined;
      this.startAutomaticCycle();
    }, delay);
  }

  private startAutomaticCycle(): void {
    if (this.automaticCycle !== undefined || this.closed || !this.ownsLifecycle) return;
    const cycle = this.refresh()
      .then((outcome) => {
        this.scheduleNext(outcome);
      })
      .finally(() => {
        if (this.automaticCycle === cycle) this.automaticCycle = undefined;
      });
    this.automaticCycle = cycle;
  }

  private ensureRequestSnapshot(): LocalModelCatalogSnapshot | undefined {
    const current = this.current();
    if (current.origin === "bundled") return current;
    const persisted = readPersistedCatalog(this.paths.ownerSnapshot);
    if (
      persisted !== undefined &&
      persisted.snapshot.revision === current.revision &&
      persisted.etag === current.etag
    ) {
      return current;
    }
    return this.persistOwner(current) ? current : undefined;
  }

  private async publicationBlocker(): Promise<ModelCatalogRefreshOutcome | undefined> {
    try {
      await this.dependencies.beforePublish?.();
    } catch {
      return this.retained("request-failed");
    }
    return this.closed ? this.retained("shutdown") : undefined;
  }

  private async publishRefresh(
    snapshot: LocalModelCatalogSnapshot,
    kind: "unchanged" | "updated",
  ): Promise<ModelCatalogRefreshOutcome> {
    const blocker = await this.publicationBlocker();
    if (blocker !== undefined) return blocker;
    if (!this.persistOwner(snapshot)) return this.retained("persistence-failed");
    this.adopt(snapshot);
    return Object.freeze({ kind, revision: snapshot.revision });
  }

  private async runRefresh(): Promise<ModelCatalogRefreshOutcome> {
    const elapsedAt = this.elapsedNow();
    if (this.elapsedWindowRemaining(elapsedAt) !== undefined) return this.retained("not-due");
    const wallNow = this.dependencies.now();
    const claim = claimAttempt(this.paths, wallNow, elapsedAt, this.elapsedWindowMs());
    if (claim.kind === "failed") return this.retained("claim-failed");
    if ((claim.kind === "claimed" || claim.kind === "repaired") && Number.isFinite(elapsedAt)) {
      this.lastAttemptElapsedAt = claim.anchor.systemUptimeMs;
    }
    if (claim.kind === "not-due") {
      this.lastAttemptElapsedAt = claim.anchor.systemUptimeMs;
      return this.retained("not-due");
    }
    if (claim.kind === "repaired") return this.retained("not-due");
    let pendingAnchor = claim.anchor;
    let activeController: AbortController | undefined;
    try {
      try {
        await this.dependencies.afterAttemptClaim?.();
      } catch {
        return this.retained("request-failed");
      }
      if (this.closed) return this.retained("shutdown");
      const requestSnapshot = this.ensureRequestSnapshot();
      if (requestSnapshot === undefined) return this.retained("persistence-failed");
      const reanchor = reanchorAttempt(
        this.paths,
        pendingAnchor,
        this.dependencies.now(),
        this.elapsedNow(),
      );
      if (reanchor.kind === "failed") return this.retained("claim-failed");
      if (reanchor.kind === "superseded") return this.retained("not-due");
      pendingAnchor = reanchor.anchor;
      this.lastAttemptElapsedAt = pendingAnchor.systemUptimeMs;
      if (!nodeTlsVerificationEnabled()) return this.retained("request-failed");
      const requestController = new AbortController();
      activeController = requestController;
      this.requestController = requestController;
      const timeoutSignal = AbortSignal.timeout(this.dependencies.requestTimeoutMs);
      const signal = AbortSignal.any([requestController.signal, timeoutSignal]);
      const session = createCatalogRefreshSession({
        requestEtag: requestSnapshot.etag,
        current: requestSnapshot,
      });
      let response: Response;
      try {
        response = await this.dependencies.fetch(this.dependencies.endpoint, {
          headers:
            requestSnapshot.etag === undefined
              ? undefined
              : { "If-None-Match": requestSnapshot.etag },
          redirect: "error",
          signal,
        });
      } catch {
        return this.retained(session.networkFailure(this.closed));
      }
      if (this.closed) {
        await cancelResponseBody(response, requestController);
        return this.retained("shutdown");
      }
      const headerDecision = session.fromHeaders({
        status: response.status,
        responseEtag: response.headers.get("etag"),
        successfulAt: serializedTime(this.dependencies.now()),
      });
      if (headerDecision.kind === "retain") {
        await cancelResponseBody(response, requestController);
        return this.retained(headerDecision.reason);
      }
      if (headerDecision.kind === "not-modified") {
        await cancelResponseBody(response, requestController);
        const unchanged: LocalModelCatalogSnapshot = Object.freeze({
          ...requestSnapshot,
          lastSuccessfulRefreshAt: headerDecision.successfulAt,
          origin: "installation",
        });
        return await this.publishRefresh(unchanged, "unchanged");
      }
      let body: string;
      try {
        body = await readBoundedBody(response);
      } catch (error) {
        await cancelResponseBody(response, requestController);
        return this.retained(session.bodyFailure(this.closed, error));
      }
      const bodyDecision = session.fromBody({
        closed: this.closed,
        body,
        etag: headerDecision.etag,
      });
      if (bodyDecision.kind === "retain") return this.retained(bodyDecision.reason);
      const updated: LocalModelCatalogSnapshot = Object.freeze({
        ...bodyDecision.record,
        lastSuccessfulRefreshAt: headerDecision.successfulAt,
        origin: "installation",
        revision: bodyDecision.record.snapshot.revision,
      });
      return await this.publishRefresh(updated, "updated");
    } finally {
      const completion = completeAttempt(
        this.paths,
        pendingAnchor,
        this.dependencies.now(),
        this.elapsedNow(),
      );
      if (completion.kind === "transitioned") {
        this.lastAttemptElapsedAt = completion.anchor.systemUptimeMs;
      }
      if (activeController !== undefined && this.requestController === activeController) {
        this.requestController = undefined;
      }
    }
  }
}

export function readAcceptedInstallationCatalog(
  installationRoot: string,
): AcceptedModelCatalogRecord | undefined {
  const persisted = readPersistedCatalog(
    join(resolve(installationRoot), "config", "model-catalog", "accepted-snapshot.json"),
  );
  if (persisted === undefined) return undefined;
  return acceptModelCatalogSnapshot(persisted.snapshot, persisted.etag);
}

export function openModelCatalog(input: ModelCatalogOpenInput): ModelCatalog {
  return new InstallationModelCatalog(input, defaultDependencies());
}

export function __openModelCatalogForTesting(
  input: ModelCatalogOpenInput,
  dependencies: ModelCatalogTestingDependencies,
): ModelCatalog {
  return new InstallationModelCatalog(input, defaultDependencies(dependencies));
}
