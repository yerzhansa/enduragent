import { join } from "node:path";
import type { ZodTypeAny } from "zod";
import {
  MUTEX_ACQUIRE_TIMEOUT_MS,
  MUTEX_HOT_WARN_MS,
  SCHEDULED_SYNC_INTERVAL_MS,
  SYNC_OPERATION_TIMEOUT_MS,
} from "../freshness.js";
import { atomicWriteJson } from "../../io/atomic-write-json.js";
import { safeReadJson } from "../../io/safe-read-json.js";
import {
  LATEST_SCHEMA_VERSION,
  LatestJsonSchema,
  type DerivedMetricsMeta,
} from "../schemas/latest.js";
import { HISTORY_SCHEMA_VERSION, HistoryJsonSchema } from "../schemas/history.js";
import { INTERVALS_SCHEMA_VERSION, IntervalsJsonSchema } from "../schemas/intervals.js";
import { ROUTES_SCHEMA_VERSION, RoutesJsonSchema } from "../schemas/routes.js";
import { FTP_HISTORY_SCHEMA_VERSION, FtpHistoryJsonSchema } from "../schemas/ftp-history.js";
import { SCHEDULER_SCHEMA_VERSION } from "../schemas/scheduler.js";
import { ErrorStateSchema } from "../schemas/error-state.js";
import type { ErrorPhase, ErrorCaller, ErrorState } from "../schemas/error-state.js";
import { gateLatestJson } from "../validation/sync-gate.js";
import { writeErrorState, clearErrorState } from "./error-state-writer.js";
import {
  createSyncHistoryWriter,
  SYNC_HISTORY_SCHEMA_VERSION,
  type SyncOutcomeLine,
} from "./sync-history.js";
import type { AsyncMutex } from "../../concurrency/mutex.js";
import type { Cooldown } from "../../concurrency/cooldown.js";
import type { Clock } from "../../concurrency/clock.js";
import type { LatestSourceProvenance } from "../source-provenance.js";
import { EMPTY_DROPPED_ACTIVITIES, type DroppedActivities } from "@enduragent/coach-contract";

export type SyncCaller = ErrorCaller;

export interface RunSyncOpts {
  readonly forceFresh?: boolean;
  readonly extendRetentionUntil?: string;
  readonly caller?: SyncCaller;
  readonly signal?: AbortSignal;
  readonly chatId?: string;
}

export type CacheFile = "latest" | "history" | "intervals" | "routes" | "ftp_history";

export interface SyncFailure {
  readonly file: string;
  readonly reason: string;
}

export type SyncResult =
  | {
      readonly kind: "ran";
      readonly lastSyncAt: string;
      readonly refreshed: readonly CacheFile[];
      readonly droppedActivities: DroppedActivities;
    }
  | {
      readonly kind: "skipped";
      readonly reason: "cooldown" | "mutex_held";
      readonly retryAfterMs?: number;
    }
  | {
      readonly kind: "failed";
      readonly reason: "outer_timeout" | "gate_rejected" | "fetch_failed";
      readonly failures: readonly SyncFailure[];
      readonly retryAfterMs?: number;
    };

export class ReferenceRateLimitedError extends Error {
  readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = "ReferenceRateLimitedError";
    this.retryAfterMs = retryAfterMs;
  }
}

export interface FetchedReference {
  readonly latest: {
    readonly athlete_profile: unknown;
    readonly current_status: unknown;
    readonly derived_metrics: unknown;
    readonly derived_metrics_meta?: DerivedMetricsMeta;
    readonly recent_activities: readonly unknown[];
    readonly planned_workouts: readonly unknown[];
    readonly wellness_data: unknown;
    readonly source_provenance?: LatestSourceProvenance;
  };
  readonly history: {
    readonly daily: readonly unknown[];
    readonly weekly: readonly unknown[];
    readonly monthly: readonly unknown[];
  };
  readonly intervals: {
    readonly by_activity: Readonly<Record<string, readonly unknown[]>>;
  };
  readonly routes: { readonly routes: readonly unknown[] };
  readonly ftp_history: { readonly entries: readonly unknown[] };
  readonly fetch_errors?: readonly { readonly endpoint: string; readonly detail: string }[];
  readonly dropped_activities?: DroppedActivities;
}

export interface RunSyncDeps {
  readonly dataDir: string;
  readonly mutex: AsyncMutex;
  readonly cooldown: Cooldown;
  readonly cooldownWindowMs: number;
  readonly fetchReferenceData: (signal: AbortSignal) => Promise<FetchedReference>;
  readonly now?: () => Date;
  readonly clock?: Partial<Clock>;
  readonly timing?: {
    readonly acquireTimeoutMs?: number;
    readonly hotWarnMs?: number;
    readonly outerTimeoutMs?: number;
    readonly scheduledIntervalMs?: number;
  };
  readonly gate?: typeof gateLatestJson;
  readonly atomicWrite?: (
    path: string,
    value: unknown,
    opts?: { signal?: AbortSignal },
  ) => Promise<void>;
  readonly clearError?: (dataDir: string, opts?: { signal?: AbortSignal }) => Promise<void>;
  readonly syncHistory?: (line: SyncOutcomeLine) => void;
}

type BodyOutcome =
  | { readonly ok: true; readonly result: SyncResult }
  | { readonly ok: false; readonly error: unknown };

interface CacheWriteSpec {
  readonly file: CacheFile;
  readonly version: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly extras?: Readonly<Record<string, unknown>>;
}

export const BODY_AFTER_TIMEOUT_LOG_PREFIX = "Reference: body threw after outer timeout";
const BODY_AFTER_ABORT_LOG_PREFIX = "Reference: body threw after external abort";

const CACHE_SCHEMAS: Readonly<Record<CacheFile, ZodTypeAny>> = {
  latest: LatestJsonSchema,
  history: HistoryJsonSchema,
  intervals: IntervalsJsonSchema,
  routes: RoutesJsonSchema,
  ftp_history: FtpHistoryJsonSchema,
};

function readPriorCache(path: string, file: CacheFile): Record<string, unknown> | null {
  return safeReadJson<Record<string, unknown>>(path, CACHE_SCHEMAS[file]);
}

function priorBlockCoaching(dataDir: string): { mitigation: "block_coaching" } | undefined {
  const prior = safeReadJson<ErrorState>(join(dataDir, "error_state.json"), ErrorStateSchema);
  return prior?.mitigation === "block_coaching" ? { mitigation: prior.mitigation } : undefined;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function priorPayloadEquals(
  prior: Record<string, unknown>,
  payload: Readonly<Record<string, unknown>>,
): boolean {
  const { metadata: _metadata, ...priorPayload } = prior;
  return JSON.stringify(canonicalize(priorPayload)) === JSON.stringify(canonicalize(payload));
}

export function createRunSync(deps: RunSyncDeps): (opts?: RunSyncOpts) => Promise<SyncResult> {
  const now = deps.clock?.now ?? deps.now ?? (() => new Date());
  const setTimeoutFn: (fn: () => void, ms: number) => unknown =
    deps.clock?.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutFn: (handle: unknown) => void =
    deps.clock?.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const acquireTimeoutMs = deps.timing?.acquireTimeoutMs ?? MUTEX_ACQUIRE_TIMEOUT_MS;
  const hotWarnMs = deps.timing?.hotWarnMs ?? MUTEX_HOT_WARN_MS;
  const outerTimeoutMs = deps.timing?.outerTimeoutMs ?? SYNC_OPERATION_TIMEOUT_MS;
  const scheduledIntervalMs = deps.timing?.scheduledIntervalMs ?? SCHEDULED_SYNC_INTERVAL_MS;
  const gate = deps.gate ?? gateLatestJson;
  const writeJson = deps.atomicWrite ?? atomicWriteJson;
  const clearError = deps.clearError ?? clearErrorState;
  const syncHistory = deps.syncHistory ?? createSyncHistoryWriter(deps.dataDir);

  return async (opts = {}) => {
    opts.signal?.throwIfAborted();
    const startedAt = now();
    const emit = (kind: SyncResult["kind"], reason: string | undefined): void => {
      try {
        syncHistory({
          schema_version: SYNC_HISTORY_SCHEMA_VERSION,
          ts: now().toISOString(),
          caller: opts.caller ?? "scheduled",
          kind,
          reason,
          duration_ms: Math.max(0, now().getTime() - startedAt.getTime()),
        });
      } catch (error) {
        console.warn(
          `Reference: sync history write failed (${error instanceof Error ? error.message : String(error)}).`,
        );
      }
    };
    const emitOutcome = (result: SyncResult): SyncResult => {
      emit(result.kind, "reason" in result ? result.reason : undefined);
      return result;
    };

    if (opts.caller === "/sync" && opts.chatId !== undefined) {
      const c = deps.cooldown.check(opts.chatId, deps.cooldownWindowMs);
      if (!c.ok) {
        opts.signal?.throwIfAborted();
        return emitOutcome({
          kind: "skipped",
          reason: "cooldown",
          retryAfterMs: c.retryAfterMs,
        });
      }
    }

    if (opts.caller === "/sync" && deps.mutex.isHeld()) {
      opts.signal?.throwIfAborted();
      return emitOutcome({ kind: "skipped", reason: "mutex_held" });
    }

    let mutexResult;
    try {
      mutexResult = await deps.mutex.runExclusive(
        async (lease): Promise<SyncResult> => {
          opts.signal?.throwIfAborted();
          const controller = new AbortController();
          const externalAbort = new Promise<"external_abort">((resolve) => {
            const abort = (): void => {
              controller.abort(lease.reason);
              resolve("external_abort");
            };
            if (lease.aborted) {
              abort();
              return;
            }
            lease.addEventListener("abort", abort, { once: true });
          });
          let phase: ErrorPhase = "fetching";
          let cycleBlockCoaching = false;

          const abortedResult = (): SyncResult => ({
            kind: "failed",
            reason: "outer_timeout",
            failures: [],
          });

          const body = async (): Promise<SyncResult> => {
            let fetched: FetchedReference;
            try {
              fetched = await deps.fetchReferenceData(controller.signal);
            } catch (err) {
              if (controller.signal.aborted) return abortedResult();
              const detail = err instanceof Error ? err.message : String(err);
              await writeErrorState(
                deps.dataDir,
                {
                  step: "fetch_failed",
                  phase,
                  detail,
                  ...priorBlockCoaching(deps.dataDir),
                },
                { write: writeJson, signal: controller.signal },
              );
              return {
                kind: "failed",
                reason: "fetch_failed",
                failures: [{ file: "latest", reason: detail }],
                ...(err instanceof ReferenceRateLimitedError
                  ? { retryAfterMs: err.retryAfterMs }
                  : {}),
              };
            }
            if (controller.signal.aborted) return abortedResult();

            phase = "gating";
            const gateResult = gate(fetched, null, now());
            if (!gateResult.ok) {
              cycleBlockCoaching = true;
              await writeErrorState(
                deps.dataDir,
                {
                  step: "gate_rejected",
                  detail: gateResult.failures.map((f) => `${f.step}: ${f.detail}`).join("; "),
                  mitigation: "block_coaching",
                },
                { write: writeJson, signal: controller.signal },
              );
              return {
                kind: "failed",
                reason: "gate_rejected",
                failures: gateResult.failures.map((f) => ({
                  file: "latest",
                  reason: `${f.step}: ${f.detail}`,
                })),
              };
            }
            if (controller.signal.aborted) return abortedResult();

            const lastUpdated = now().toISOString();
            phase = "writing_cache";

            const cacheWrites: readonly CacheWriteSpec[] = [
              {
                file: "latest",
                version: LATEST_SCHEMA_VERSION,
                payload: fetched.latest,
                extras: { freshness: gateResult.freshness ?? "fresh" },
              },
              { file: "history", version: HISTORY_SCHEMA_VERSION, payload: fetched.history },
              { file: "intervals", version: INTERVALS_SCHEMA_VERSION, payload: fetched.intervals },
              { file: "routes", version: ROUTES_SCHEMA_VERSION, payload: fetched.routes },
              {
                file: "ftp_history",
                version: FTP_HISTORY_SCHEMA_VERSION,
                payload: fetched.ftp_history,
              },
            ];
            const refreshed = (
              await Promise.all(
                cacheWrites.map(async ({ file, version, payload, extras }) => {
                  const path = join(deps.dataDir, `${file}.json`);
                  const prior = readPriorCache(path, file);
                  if (prior !== null && priorPayloadEquals(prior, payload)) {
                    return null;
                  }
                  await writeJson(
                    path,
                    {
                      metadata: { schema_version: version, last_updated: lastUpdated, ...extras },
                      ...payload,
                    },
                    { signal: controller.signal },
                  );
                  return file;
                }),
              )
            ).filter((f): f is CacheFile => f !== null);
            if (controller.signal.aborted) return abortedResult();

            phase = "writing_scheduler";
            await writeJson(
              join(deps.dataDir, ".scheduler.json"),
              {
                schema_version: SCHEDULER_SCHEMA_VERSION,
                last_sync_at: lastUpdated,
                next_sync_at: new Date(now().getTime() + scheduledIntervalMs).toISOString(),
              },
              { signal: controller.signal },
            );

            if (gateResult.warnings.length > 0) {
              await writeErrorState(
                deps.dataDir,
                {
                  step: "gate_warnings",
                  detail: gateResult.warnings.map((w) => `${w.step}: ${w.detail}`).join("; "),
                  mitigation: "warn_only",
                },
                { write: writeJson, signal: controller.signal },
              );
            } else {
              await clearError(deps.dataDir, { signal: controller.signal });
            }

            return {
              kind: "ran",
              lastSyncAt: lastUpdated,
              refreshed,
              droppedActivities: fetched.dropped_activities ?? EMPTY_DROPPED_ACTIVITIES,
            };
          };

          const bodySettled: Promise<BodyOutcome> = body().then(
            (result) => ({ ok: true, result }),
            (error: unknown) => ({ ok: false, error }),
          );
          const warnIfBodyThrew = (prefix: string): void => {
            void bodySettled.then((outcome) => {
              if (!outcome.ok) {
                console.warn(
                  `${prefix} — ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`,
                );
              }
            });
          };

          let timerHandle: unknown;
          const timerFired = new Promise<true>((resolve) => {
            timerHandle = setTimeoutFn(() => resolve(true), outerTimeoutMs);
          });

          const winner = await Promise.race([
            bodySettled.then(() => "body" as const),
            timerFired.then(() => "timeout" as const),
            externalAbort,
          ]);

          if (timerHandle !== undefined) clearTimeoutFn(timerHandle);

          if (winner === "external_abort") {
            warnIfBodyThrew(BODY_AFTER_ABORT_LOG_PREFIX);
            opts.signal?.throwIfAborted();
            throw new Error("Reference sync aborted.");
          }

          if (winner === "timeout") {
            controller.abort();
            warnIfBodyThrew(BODY_AFTER_TIMEOUT_LOG_PREFIX);
            await writeErrorState(
              deps.dataDir,
              {
                step: "outer_timeout",
                phase,
                detail: `runSync exceeded ${outerTimeoutMs}ms during ${phase} phase`,
                ...(cycleBlockCoaching
                  ? ({ mitigation: "block_coaching" } as const)
                  : priorBlockCoaching(deps.dataDir)),
              },
              { write: writeJson },
            );
            return { kind: "failed", reason: "outer_timeout", failures: [] };
          }

          const outcome = await bodySettled;
          if (!outcome.ok) throw outcome.error;
          return outcome.result;
        },
        {
          acquireTimeoutMs,
          hotWarnMs,
          caller: opts.caller ?? "scheduled",
          signal: opts.signal,
        },
      );
    } catch (err) {
      if (opts.signal?.aborted === true) throw err;
      emit("failed", "unexpected_error");
      throw err;
    }

    if (mutexResult.kind === "timeout") {
      opts.signal?.throwIfAborted();
      return emitOutcome({ kind: "skipped", reason: "mutex_held" });
    }

    const result = mutexResult.value;
    opts.signal?.throwIfAborted();
    if (result.kind === "ran" && opts.caller === "/sync" && opts.chatId !== undefined) {
      deps.cooldown.record(opts.chatId);
    }
    return emitOutcome(result);
  };
}
