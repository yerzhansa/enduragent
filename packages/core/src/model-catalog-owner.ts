import { mkdirSync, readFileSync } from "node:fs";
import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { uptime } from "node:os";
import { join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { ModelCatalogSnapshotSchema } from "@enduragent/coach-contract/model-catalog";
import { z } from "zod";
import { atomicWriteFileSync } from "./io/atomic-write-file-sync.js";
import {
  InterprocessFileLockTimeoutError,
  withInterprocessFileLock,
  withInterprocessFileLockSync,
} from "./io/interprocess-file-lock-sync.js";
import {
  acceptModelCatalogSnapshot,
  evaluateModelCatalogCandidate,
  type AcceptedModelCatalogRecord,
} from "./model-catalog.js";
import { BUNDLED_MODEL_CATALOG } from "./model-catalog-seed.js";

export const MODEL_CATALOG_ENDPOINT = "https://api.enduragent.icu/models/v1/catalog.json";
export const MODEL_CATALOG_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const MODEL_CATALOG_REQUEST_TIMEOUT_MS = 5_000;
export const MODEL_CATALOG_RESPONSE_LIMIT_BYTES = 512 * 1_024;

const RECORD_FORMAT_VERSION = 1;
const ATTEMPT_STATE_VERSION = 1;
const OWNER_ACQUIRE_TIMEOUT_MS = 50;
const SCHEDULER_RECHECK_LIMIT_MS = MODEL_CATALOG_REFRESH_INTERVAL_MS;
const SCHEDULER_MIN_DELAY_MS = 1_000;
const HIGH_RESOLUTION_CLOCK_RESOLUTION_MS = 1;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;
const SYSTEM_UPTIME_RESOLUTION_MS = 1_000;

const EtagSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) =>
    Array.from(value).every((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && codePoint >= 32 && codePoint !== 127;
    }),
  );
const PersistedCatalogSchema = z
  .object({
    formatVersion: z.literal(RECORD_FORMAT_VERSION),
    etag: EtagSchema.optional(),
    lastSuccessfulRefreshAt: z.string().datetime({ offset: true }).optional(),
    snapshot: ModelCatalogSnapshotSchema,
  })
  .strict();
const InFlightAttemptStateSchema = z
  .object({
    schemaVersion: z.literal(ATTEMPT_STATE_VERSION),
    attemptStatus: z.literal("in-flight"),
    lastAttemptAt: z.string().datetime({ offset: true }),
    systemUptimeMs: z.number().finite().nonnegative(),
  })
  .strict();
const CompletedAttemptStateSchema = z
  .object({
    schemaVersion: z.literal(ATTEMPT_STATE_VERSION),
    attemptStatus: z.literal("completed"),
    lastAttemptAt: z.string().datetime({ offset: true }),
    systemUptimeMs: z.number().finite().nonnegative(),
  })
  .strict();
const AttemptStateSchema = z.discriminatedUnion("attemptStatus", [
  InFlightAttemptStateSchema,
  CompletedAttemptStateSchema,
]);

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

export interface ModelCatalogPaths {
  readonly attemptLock: string;
  readonly attemptState: string;
  readonly installationDirectory: string;
  readonly ownerLock: string;
  readonly ownerSnapshot: string;
  readonly privateDirectory: string;
  readonly privateSnapshot: string;
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

interface AttemptAnchor {
  readonly lastAttemptAt: number;
  readonly serialized: string;
  readonly systemUptimeMs: number;
}

type AttemptRead =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "in-flight"; anchor: AttemptAnchor }>
  | Readonly<{ kind: "completed"; anchor: AttemptAnchor }>;

type DurableAttempt =
  | Readonly<{ kind: "in-flight"; anchor: AttemptAnchor }>
  | Readonly<{ kind: "completed"; anchor: AttemptAnchor }>;

type AttemptClaim =
  | Readonly<{ kind: "claimed"; anchor: AttemptAnchor }>
  | Readonly<{ kind: "not-due"; anchor: AttemptAnchor }>
  | Readonly<{ kind: "repaired"; anchor: AttemptAnchor }>
  | Readonly<{ kind: "failed" }>;

type AttemptTransition =
  | Readonly<{ kind: "transitioned"; anchor: AttemptAnchor }>
  | Readonly<{ kind: "superseded" }>
  | Readonly<{ kind: "failed" }>;

class ResponseLimitError extends Error {}

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

function nodeTlsVerificationEnabled(): boolean {
  return process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0";
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const singleDispatchFetch: typeof globalThis.fetch = async (input, init) => {
  if (input instanceof Request) throw new TypeError("Request objects are not supported");
  if (init?.body !== undefined && init.body !== null) {
    throw new TypeError("Request bodies are not supported");
  }
  const endpoint = new URL(input);
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new TypeError("Unsupported model catalog protocol");
  }
  const method = init?.method ?? "GET";
  if (method.toUpperCase() !== "GET") throw new TypeError("Only GET requests are supported");
  const headers = Object.fromEntries(new Headers(init?.headers));
  const request = endpoint.protocol === "https:" ? requestHttps : requestHttp;
  return await new Promise<Response>((resolve, reject) => {
    const outgoing = request(
      endpoint,
      {
        headers,
        method: "GET",
        rejectUnauthorized: true,
        signal: init?.signal ?? undefined,
      },
      (incoming) => {
        const status = incoming.statusCode;
        if (status === undefined) {
          incoming.destroy();
          reject(new Error("Model catalog response omitted a status"));
          return;
        }
        if (REDIRECT_STATUSES.has(status)) {
          incoming.destroy();
          reject(new Error("Model catalog redirects are not allowed"));
          return;
        }
        try {
          const responseHeaders = new Headers();
          for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
            const name = incoming.rawHeaders[index];
            const value = incoming.rawHeaders[index + 1];
            if (name !== undefined && value !== undefined) responseHeaders.append(name, value);
          }
          let closed = false;
          let receivedBytes = 0;
          const body =
            status === 204 || status === 205 || status === 304
              ? null
              : new ReadableStream<Uint8Array>({
                  start(controller) {
                    const fail = (error: unknown): void => {
                      if (closed) return;
                      closed = true;
                      controller.error(error);
                    };
                    incoming.on("data", (chunk: Buffer) => {
                      if (closed) return;
                      receivedBytes += chunk.byteLength;
                      if (receivedBytes > MODEL_CATALOG_RESPONSE_LIMIT_BYTES) {
                        closed = true;
                        controller.error(new ResponseLimitError());
                        incoming.destroy();
                        return;
                      }
                      controller.enqueue(chunk);
                    });
                    incoming.once("aborted", () => fail(new Error("Response aborted")));
                    incoming.once("error", fail);
                    incoming.once("end", () => {
                      if (closed) return;
                      closed = true;
                      controller.close();
                    });
                  },
                  cancel() {
                    closed = true;
                    incoming.destroy();
                  },
                });
          resolve(
            new Response(body, {
              headers: responseHeaders,
              status,
              statusText: incoming.statusMessage,
            }),
          );
        } catch (error) {
          incoming.destroy();
          reject(error);
        }
      },
    );
    outgoing.once("error", reject);
    outgoing.once("upgrade", (_response, socket) => {
      socket.destroy();
      reject(new Error("Model catalog protocol upgrades are not allowed"));
    });
    outgoing.end();
  });
};

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
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

function readAttempt(path: string): AttemptRead {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return errorCode(error) === "ENOENT" ? { kind: "missing" } : { kind: "invalid" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "invalid" };
  }
  const state = AttemptStateSchema.safeParse(parsed);
  if (!state.success) return { kind: "invalid" };
  const lastAttemptAt = Date.parse(state.data.lastAttemptAt);
  if (!Number.isFinite(lastAttemptAt)) return { kind: "invalid" };
  return {
    kind: state.data.attemptStatus,
    anchor: {
      lastAttemptAt,
      serialized: state.data.lastAttemptAt,
      systemUptimeMs: state.data.systemUptimeMs,
    },
  };
}

function serializedTime(now: number): string | undefined {
  if (!Number.isFinite(now)) return undefined;
  try {
    return new Date(now).toISOString();
  } catch {
    return undefined;
  }
}

function writeJson(path: string, value: unknown): void {
  atomicWriteFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function attemptAnchor(lastAttemptAt: number, systemUptimeMs: number): AttemptAnchor | undefined {
  const serialized = serializedTime(lastAttemptAt);
  if (serialized === undefined || !Number.isFinite(systemUptimeMs) || systemUptimeMs < 0) {
    return undefined;
  }
  return { lastAttemptAt, serialized, systemUptimeMs };
}

function writeAttempt(path: string, attempt: DurableAttempt): void {
  writeJson(path, {
    schemaVersion: ATTEMPT_STATE_VERSION,
    attemptStatus: attempt.kind,
    lastAttemptAt: attempt.anchor.serialized,
    systemUptimeMs: attempt.anchor.systemUptimeMs,
  });
}

function sameAttempt(left: AttemptAnchor, right: AttemptAnchor): boolean {
  return left.serialized === right.serialized && left.systemUptimeMs === right.systemUptimeMs;
}

function claimAttempt(
  paths: ModelCatalogPaths,
  now: number,
  systemUptimeMs: number,
  elapsedWindowMs: number,
): AttemptClaim {
  try {
    mkdirSync(paths.installationDirectory, { recursive: true, mode: 0o700 });
    return withInterprocessFileLockSync(paths.attemptLock, () => {
      const observed = attemptAnchor(now, systemUptimeMs);
      if (observed === undefined) return { kind: "failed" };
      const prior = readAttempt(paths.attemptState);
      if (prior.kind === "in-flight") {
        const repaired = attemptAnchor(Math.max(now, prior.anchor.lastAttemptAt), systemUptimeMs);
        if (repaired === undefined) return { kind: "failed" };
        writeAttempt(paths.attemptState, { kind: "completed", anchor: repaired });
        return { kind: "repaired", anchor: repaired };
      }
      if (prior.kind === "completed") {
        if (systemUptimeMs < prior.anchor.systemUptimeMs) {
          const repaired = attemptAnchor(Math.max(now, prior.anchor.lastAttemptAt), systemUptimeMs);
          if (repaired === undefined) return { kind: "failed" };
          writeAttempt(paths.attemptState, { kind: "completed", anchor: repaired });
          return { kind: "repaired", anchor: repaired };
        }
        const wallElapsed = now - prior.anchor.lastAttemptAt;
        const uptimeElapsed = systemUptimeMs - prior.anchor.systemUptimeMs;
        if (wallElapsed < MODEL_CATALOG_REFRESH_INTERVAL_MS || uptimeElapsed < elapsedWindowMs) {
          return { kind: "not-due", anchor: prior.anchor };
        }
      }
      if (prior.kind === "invalid") {
        const repaired = attemptAnchor(now, systemUptimeMs);
        if (repaired === undefined) return { kind: "failed" };
        writeAttempt(paths.attemptState, { kind: "completed", anchor: repaired });
        return { kind: "repaired", anchor: repaired };
      }
      writeAttempt(paths.attemptState, { kind: "in-flight", anchor: observed });
      return { kind: "claimed", anchor: observed };
    });
  } catch {
    return { kind: "failed" };
  }
}

function transitionAttempt(
  paths: ModelCatalogPaths,
  expected: DurableAttempt,
  next: DurableAttempt,
): AttemptTransition {
  try {
    return withInterprocessFileLockSync(paths.attemptLock, () => {
      const current = readAttempt(paths.attemptState);
      if (current.kind !== expected.kind || !sameAttempt(current.anchor, expected.anchor)) {
        return { kind: "superseded" };
      }
      writeAttempt(paths.attemptState, next);
      return { kind: "transitioned", anchor: next.anchor };
    });
  } catch {
    return { kind: "failed" };
  }
}

function reanchorAttempt(
  paths: ModelCatalogPaths,
  claimed: AttemptAnchor,
  now: number,
  systemUptimeMs: number,
): AttemptTransition {
  const observed = attemptAnchor(now, systemUptimeMs);
  if (observed === undefined) return { kind: "failed" };
  return transitionAttempt(
    paths,
    { kind: "in-flight", anchor: claimed },
    { kind: "in-flight", anchor: observed },
  );
}

function completeAttempt(
  paths: ModelCatalogPaths,
  pending: AttemptAnchor,
  now: number,
  systemUptimeMs: number,
): AttemptTransition {
  const observed = attemptAnchor(now, systemUptimeMs);
  if (observed === undefined) return { kind: "failed" };
  return transitionAttempt(
    paths,
    { kind: "in-flight", anchor: pending },
    { kind: "completed", anchor: observed },
  );
}

async function cancelResponseBody(response: Response, controller: AbortController): Promise<void> {
  controller.abort();
  try {
    await response.body?.cancel();
  } catch {}
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

async function readBoundedBody(response: Response): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > MODEL_CATALOG_RESPONSE_LIMIT_BYTES) {
      throw new ResponseLimitError();
    }
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > MODEL_CATALOG_RESPONSE_LIMIT_BYTES) {
        await reader.cancel();
        throw new ResponseLimitError();
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
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
        return this.retained(this.closed ? "shutdown" : "request-failed");
      }
      if (this.closed) {
        await cancelResponseBody(response, requestController);
        return this.retained("shutdown");
      }
      const successfulAt = serializedTime(this.dependencies.now());
      if (response.status === 304) {
        await cancelResponseBody(response, requestController);
        if (
          requestSnapshot.etag === undefined ||
          response.headers.get("etag") !== requestSnapshot.etag ||
          successfulAt === undefined
        ) {
          return this.retained("invalid-not-modified");
        }
        const unchanged: LocalModelCatalogSnapshot = Object.freeze({
          ...requestSnapshot,
          lastSuccessfulRefreshAt: successfulAt,
          origin: "installation",
        });
        const blocker = await this.publicationBlocker();
        if (blocker !== undefined) return blocker;
        if (!this.persistOwner(unchanged)) return this.retained("persistence-failed");
        this.adopt(unchanged);
        return Object.freeze({ kind: "unchanged", revision: unchanged.revision });
      }
      if (!response.ok) {
        await cancelResponseBody(response, requestController);
        return this.retained("http-error");
      }

      const etagResult = EtagSchema.safeParse(response.headers.get("etag"));
      if (!etagResult.success || successfulAt === undefined) {
        await cancelResponseBody(response, requestController);
        return this.retained("invalid-response");
      }
      let body: string;
      try {
        body = await readBoundedBody(response);
      } catch (error) {
        await cancelResponseBody(response, requestController);
        return this.retained(
          this.closed
            ? "shutdown"
            : error instanceof ResponseLimitError
              ? "response-too-large"
              : "request-failed",
        );
      }
      if (this.closed) return this.retained("shutdown");
      let candidate: unknown;
      try {
        candidate = JSON.parse(body);
      } catch {
        return this.retained("invalid-response");
      }
      const current = this.current();
      const evaluation = evaluateModelCatalogCandidate(candidate, etagResult.data, current);
      if (evaluation.kind === "retained") {
        return this.retained(
          evaluation.reason === "invalid" ? "invalid-response" : "no-usable-choices",
        );
      }
      if (evaluation.record.snapshot.revision <= current.revision) {
        return this.retained("stale-revision");
      }
      const updated: LocalModelCatalogSnapshot = Object.freeze({
        ...evaluation.record,
        lastSuccessfulRefreshAt: successfulAt,
        origin: "installation",
        revision: evaluation.record.snapshot.revision,
      });
      const blocker = await this.publicationBlocker();
      if (blocker !== undefined) return blocker;
      if (!this.persistOwner(updated)) return this.retained("persistence-failed");
      this.adopt(updated);
      return Object.freeze({ kind: "updated", revision: updated.revision });
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

export function openModelCatalog(input: ModelCatalogOpenInput): ModelCatalog {
  return new InstallationModelCatalog(input, defaultDependencies());
}

export function __openModelCatalogForTesting(
  input: ModelCatalogOpenInput,
  dependencies: ModelCatalogTestingDependencies,
): ModelCatalog {
  return new InstallationModelCatalog(input, defaultDependencies(dependencies));
}
