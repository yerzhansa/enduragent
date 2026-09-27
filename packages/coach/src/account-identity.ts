import { createHash } from "node:crypto";
import type { ArchiveManager, ArchiveWriteResult } from "@enduragent/kernel/archive";
import type { PhysicalRequestLedger, SqlStore, SyncBudget } from "@enduragent/kernel/store";
import { openReadonlySqliteStorage } from "@enduragent/kernel-node/sqlite";
import {
  IntervalsHttpError,
  REQUEST_ATTEMPTS,
  SyncBudgetExceededError,
} from "@enduragent/sync-intervals-icu";
import { awaitWithSignal } from "./abortable-operation.js";
import {
  createIntervalsBackfillSource,
  DEFAULT_PER_REQUEST_TIMEOUT_MS,
  DEFAULT_REQUEST_INTERVAL_MS,
  sleepAbortably,
  type BackfillClock,
} from "./intervals-source.js";

export interface StoreOwnerCheckOptions {
  readonly apiKey: string;
  readonly athleteId: string;
  readonly historyNewestDate: string;
  readonly clock: BackfillClock;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly baseFetch?: typeof globalThis.fetch;
  readonly budget?: SyncBudget;
  readonly attemptLedger?: PhysicalRequestLedger;
}

type RuntimeAthleteOwnerLookupOptions = Omit<StoreOwnerCheckOptions, "signal" | "budget">;

export interface RuntimeAthleteOwnerGuardOptions {
  readonly current: RuntimeAthleteOwnerLookupOptions;
  readonly candidate: RuntimeAthleteOwnerLookupOptions;
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
  readonly claimUnownedCandidateWithoutCurrent?: boolean;
}

export interface RuntimeAthleteOwnerClaim {
  claim(): Promise<void>;
}

export type RuntimeAthleteOwnerRefusalReason =
  | "current-credential-missing"
  | "current-unresolved"
  | "candidate-unresolved"
  | "mismatch";

export class RuntimeAthleteOwnerRefusal extends Error {
  readonly reason: RuntimeAthleteOwnerRefusalReason;
  readonly transient: boolean;

  constructor(
    reason: RuntimeAthleteOwnerRefusalReason,
    options?: { transient?: boolean; cause?: unknown },
  ) {
    super(
      reason === "mismatch"
        ? "training account mismatch"
        : reason === "current-credential-missing"
          ? "active training credential is unavailable"
          : "training account owner unresolved",
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "RuntimeAthleteOwnerRefusal";
    this.reason = reason;
    this.transient = options?.transient === true;
  }
}

export type StoreOwnerCheckResult =
  | "unowned"
  | "matched"
  | "mismatch"
  | "unresolved"
  | "store-unavailable";

export type IntervalsCredentialVerificationRefusalReason =
  | "credential-rejected"
  | "malformed-athlete-response"
  | "validation-timeout"
  | "validation-aborted"
  | "validation-unavailable"
  | "training-account-mismatch"
  | "owner-unresolved"
  | "store-unavailable";

export type IntervalsCredentialVerificationResult =
  | Readonly<{ status: "verified" }>
  | Readonly<{
      status: "refused";
      reason: IntervalsCredentialVerificationRefusalReason;
    }>;

export type IntervalsStoreOwnerComparison = Exclude<StoreOwnerCheckResult, "unresolved">;

export type IntervalsStoreOwnerState =
  | Readonly<{ status: "unowned" }>
  | Readonly<{ status: "owned"; fingerprint: string }>;

export interface IntervalsCredentialVerificationEvidence {
  readonly verifiedFingerprint: string;
  readonly ownerState: IntervalsStoreOwnerState;
}

export type IntervalsCredentialVerificationWithEvidenceResult =
  | Readonly<{
      status: "verified";
      evidence: IntervalsCredentialVerificationEvidence;
    }>
  | Readonly<{
      status: "refused";
      reason: IntervalsCredentialVerificationRefusalReason;
    }>;

const lookupArchiveResult: ArchiveWriteResult = Object.freeze({
  address: "0".repeat(64),
  relPath: "1970/01/lookup.json.gz",
  deduped: true,
});

const lookupArchive: ArchiveManager = Object.freeze({
  async writeArtifact() {
    return lookupArchiveResult;
  },
  async writeSnapshot() {
    return lookupArchiveResult;
  },
  async quarantine() {
    return lookupArchiveResult;
  },
  async readArtifact() {
    throw new Error("lookup archive is write-only");
  },
  async readSnapshot() {
    throw new Error("lookup archive is write-only");
  },
  async has() {
    return false;
  },
});

const CLAIM_STORE_OWNER_SQL =
  "INSERT INTO store_owner (singleton, account_fingerprint) VALUES (1, ?)";
const STORE_OWNER_CHECK_BUSY_TIMEOUT_MS = 5_000;
const RUNTIME_ATHLETE_OWNER_TIMEOUT_MS = 20_000;
const RUNTIME_ATHLETE_OWNER_REQUEST_TIMEOUT_MS = 8_000;
export const INTERVALS_CREDENTIAL_VERIFICATION_TIMEOUT_MS = 20_000;
export const INTERVALS_CREDENTIAL_REQUEST_TIMEOUT_MS = 8_000;

class IntervalsCredentialTransportError extends Error {
  constructor(readonly status?: number) {
    super();
  }
}

async function readStoreOwnerFingerprint(
  store: Pick<SqlStore, "get">,
): Promise<string | undefined> {
  const current = await store.get(
    "SELECT account_fingerprint FROM store_owner WHERE singleton = 1",
  );
  if (current === undefined) return undefined;
  if (
    Object.keys(current).join(",") !== "account_fingerprint" ||
    typeof current.account_fingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(current.account_fingerprint)
  ) {
    throw new Error("invalid store owner row");
  }
  return current.account_fingerprint;
}

export async function readIntervalsStoreOwnerState(
  store: Pick<SqlStore, "get">,
): Promise<IntervalsStoreOwnerState> {
  const fingerprint = await readStoreOwnerFingerprint(store);
  return fingerprint === undefined
    ? Object.freeze({ status: "unowned" })
    : Object.freeze({ status: "owned", fingerprint });
}

async function compareStoreOwner(
  store: Pick<SqlStore, "get">,
  accountFingerprint: string,
): Promise<Extract<StoreOwnerCheckResult, "unowned" | "matched" | "mismatch">> {
  if (!/^[0-9a-f]{64}$/.test(accountFingerprint)) {
    throw new TypeError("invalid store owner fingerprint");
  }
  const current = await readStoreOwnerFingerprint(store);
  if (current === undefined) return "unowned";
  return current === accountFingerprint ? "matched" : "mismatch";
}

export async function resolveIntervalsStoreOwnerFingerprint(
  options: StoreOwnerCheckOptions,
): Promise<string | null> {
  const controller = new AbortController();
  const budget = options.budget ?? {
    signal: options.signal ?? controller.signal,
    clock: { monotonicNow: () => options.clock.monotonicNow() },
    deadlineMonotonicMs: options.clock.monotonicNow() + 300_000,
    perRequestTimeoutMs: DEFAULT_PER_REQUEST_TIMEOUT_MS,
    maxRequests: REQUEST_ATTEMPTS,
    maxArtifacts: 1_000,
  };
  const source = createIntervalsBackfillSource({
    apiKey: options.apiKey,
    athleteId: options.athleteId,
    historyNewestDate: options.historyNewestDate,
    minRequestIntervalMs: DEFAULT_REQUEST_INTERVAL_MS,
    archive: lookupArchive,
    clock: options.clock,
    sleep: options.sleep ?? sleepAbortably,
    ...(options.baseFetch === undefined ? {} : { baseFetch: options.baseFetch }),
    ...(options.attemptLedger === undefined ? {} : { attemptLedger: options.attemptLedger }),
  });
  const resolved = new Set<string>();
  for await (const artifact of source.pull(
    { source: "intervals-icu", lane: "settings", value: null },
    budget,
  )) {
    if (artifact.kind !== "snapshot" || artifact.lane !== "settings") continue;
    const payload = artifact.payload;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload))
      throw new TypeError();
    const value = (payload as Record<string, unknown>).athlete_id;
    if (typeof value !== "string" || value.length === 0) throw new TypeError();
    resolved.add(value);
  }
  if (resolved.size !== 1) return null;
  return createHash("sha256")
    .update(JSON.stringify(["store-owner-v1", [...resolved][0]]))
    .digest("hex");
}

export async function assertRuntimeAthleteOwner(
  store: SqlStore,
  options: RuntimeAthleteOwnerGuardOptions,
  resolveFingerprint: (
    options: StoreOwnerCheckOptions,
  ) => Promise<string | null> = resolveIntervalsStoreOwnerFingerprint,
): Promise<RuntimeAthleteOwnerClaim | undefined> {
  const timeoutMs = options.timeoutMs ?? RUNTIME_ATHLETE_OWNER_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("runtime athlete owner timeout is invalid");
  }
  const timeoutController = new AbortController();
  const timeout = setTimeout(
    () => timeoutController.abort(new Error("runtime athlete owner lookup timed out")),
    timeoutMs,
  );
  timeout.unref();
  const signal = AbortSignal.any([options.signal, timeoutController.signal]);
  const budget: SyncBudget = {
    signal,
    clock: { monotonicNow: () => options.current.clock.monotonicNow() },
    deadlineMonotonicMs: options.current.clock.monotonicNow() + timeoutMs,
    perRequestTimeoutMs: Math.min(RUNTIME_ATHLETE_OWNER_REQUEST_TIMEOUT_MS, timeoutMs),
    maxRequests: REQUEST_ATTEMPTS,
    maxArtifacts: 1_000,
  };
  const resolveRequiredFingerprint = async (
    selected: RuntimeAthleteOwnerLookupOptions,
    reason: Extract<
      RuntimeAthleteOwnerRefusalReason,
      "current-unresolved" | "candidate-unresolved"
    >,
  ): Promise<string> => {
    let fingerprint: string | null;
    try {
      signal.throwIfAborted();
      fingerprint = await resolveFingerprint({ ...selected, signal, budget });
      signal.throwIfAborted();
    } catch (error) {
      throw new RuntimeAthleteOwnerRefusal(reason, { transient: true, cause: error });
    }
    if (fingerprint === null) throw new RuntimeAthleteOwnerRefusal(reason);
    return fingerprint;
  };
  const pendingClaim = (
    fingerprint: string,
    reason: Extract<
      RuntimeAthleteOwnerRefusalReason,
      "current-unresolved" | "candidate-unresolved"
    >,
  ): RuntimeAthleteOwnerClaim =>
    Object.freeze({
      async claim() {
        try {
          signal.throwIfAborted();
        } catch (error) {
          throw new RuntimeAthleteOwnerRefusal(reason, { transient: true, cause: error });
        }
        await store.run(CLAIM_STORE_OWNER_SQL, [fingerprint]);
      },
    });

  try {
    if ((await readStoreOwnerFingerprint(store)) === undefined) {
      if (options.claimUnownedCandidateWithoutCurrent === true) {
        const candidateFingerprint = await resolveRequiredFingerprint(
          options.candidate,
          "candidate-unresolved",
        );
        return pendingClaim(candidateFingerprint, "candidate-unresolved");
      }
      if (options.current.apiKey.length === 0) {
        throw new RuntimeAthleteOwnerRefusal("current-credential-missing");
      }
      const currentFingerprint = await resolveRequiredFingerprint(
        options.current,
        "current-unresolved",
      );
      if (
        options.current.apiKey === options.candidate.apiKey &&
        options.current.athleteId === options.candidate.athleteId
      ) {
        return pendingClaim(currentFingerprint, "current-unresolved");
      }
      const candidateFingerprint = await resolveRequiredFingerprint(
        options.candidate,
        "candidate-unresolved",
      );
      if (candidateFingerprint !== currentFingerprint) {
        throw new RuntimeAthleteOwnerRefusal("mismatch");
      }
      return pendingClaim(candidateFingerprint, "candidate-unresolved");
    }

    const candidateFingerprint = await resolveRequiredFingerprint(
      options.candidate,
      "candidate-unresolved",
    );
    const ownership = await compareStoreOwner(store, candidateFingerprint);
    try {
      signal.throwIfAborted();
    } catch (error) {
      throw new RuntimeAthleteOwnerRefusal("candidate-unresolved", {
        transient: true,
        cause: error,
      });
    }
    if (ownership !== "matched") {
      throw new RuntimeAthleteOwnerRefusal("mismatch");
    }
  } finally {
    clearTimeout(timeout);
  }
}

export async function assertRuntimeAthleteOwnerFromEvidence(
  store: SqlStore,
  evidence: IntervalsCredentialVerificationEvidence,
  signal: AbortSignal,
): Promise<RuntimeAthleteOwnerClaim | undefined> {
  if (
    !/^[0-9a-f]{64}$/.test(evidence.verifiedFingerprint) ||
    (evidence.ownerState.status === "owned" &&
      evidence.ownerState.fingerprint !== evidence.verifiedFingerprint)
  ) {
    throw new TypeError("invalid intervals credential verification evidence");
  }
  try {
    signal.throwIfAborted();
  } catch (error) {
    throw new RuntimeAthleteOwnerRefusal("candidate-unresolved", {
      transient: true,
      cause: error,
    });
  }
  const ownership = await compareStoreOwner(store, evidence.verifiedFingerprint);
  try {
    signal.throwIfAborted();
  } catch (error) {
    throw new RuntimeAthleteOwnerRefusal("candidate-unresolved", {
      transient: true,
      cause: error,
    });
  }
  if (ownership === "mismatch") throw new RuntimeAthleteOwnerRefusal("mismatch");
  if (ownership === "matched") return undefined;
  return Object.freeze({
    async claim() {
      try {
        signal.throwIfAborted();
      } catch (error) {
        throw new RuntimeAthleteOwnerRefusal("candidate-unresolved", {
          transient: true,
          cause: error,
        });
      }
      await store.run(CLAIM_STORE_OWNER_SQL, [evidence.verifiedFingerprint]);
    },
  });
}

export async function enforceIntervalsStoreOwner(
  store: SqlStore,
  options: StoreOwnerCheckOptions,
  resolveFingerprint: (
    options: StoreOwnerCheckOptions,
  ) => Promise<string | null> = resolveIntervalsStoreOwnerFingerprint,
): Promise<"adopted" | "matched" | "unresolved"> {
  let fingerprint: string | null;
  try {
    fingerprint = await resolveFingerprint(options);
  } catch {
    return "unresolved";
  }
  if (fingerprint === null) return "unresolved";
  const ownership = await compareStoreOwner(store, fingerprint);
  if (ownership === "mismatch") throw new Error("training account mismatch");
  if (ownership === "matched") return "matched";
  await store.run(CLAIM_STORE_OWNER_SQL, [fingerprint]);
  return "adopted";
}

async function closeReadonlyStore(
  store: { close(): Promise<void> } | undefined,
): Promise<void> {
  if (store === undefined) return;
  try {
    await store.close();
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      (error.code !== "ERR_DIR_CLOSED" && error.code !== "EBADF")
    ) {
      throw error;
    }
  }
}

export async function checkIntervalsStoreOwnerAtPath(
  storePath: string,
  options: StoreOwnerCheckOptions,
): Promise<StoreOwnerCheckResult> {
  let store: ReturnType<typeof openReadonlySqliteStorage> | undefined;
  try {
    store = openReadonlySqliteStorage(storePath);
    const timeout = await store.get(`PRAGMA busy_timeout = ${STORE_OWNER_CHECK_BUSY_TIMEOUT_MS}`);
    if (timeout?.timeout !== STORE_OWNER_CHECK_BUSY_TIMEOUT_MS) {
      throw new Error("store owner check timeout unavailable");
    }
    if ((await readStoreOwnerFingerprint(store)) === undefined) {
      await store.close();
      return "unowned";
    }
  } catch {
    await closeReadonlyStore(store);
    return "store-unavailable";
  }
  let fingerprint: string | null;
  try {
    fingerprint = await resolveIntervalsStoreOwnerFingerprint(options);
  } catch {
    await closeReadonlyStore(store);
    return "unresolved";
  }
  if (fingerprint === null) {
    await closeReadonlyStore(store);
    return "unresolved";
  }
  try {
    const ownership = await compareStoreOwner(store, fingerprint);
    await store.close();
    return ownership;
  } catch {
    await closeReadonlyStore(store);
    return "store-unavailable";
  }
}

async function compareIntervalsStoreOwnerFingerprintAtPath(
  storePath: string,
  fingerprint: string,
): Promise<IntervalsStoreOwnerComparison> {
  let store: ReturnType<typeof openReadonlySqliteStorage> | undefined;
  let comparison: Exclude<IntervalsStoreOwnerComparison, "store-unavailable">;
  try {
    store = openReadonlySqliteStorage(storePath);
    const timeout = await store.get(`PRAGMA busy_timeout = ${STORE_OWNER_CHECK_BUSY_TIMEOUT_MS}`);
    if (timeout?.timeout !== STORE_OWNER_CHECK_BUSY_TIMEOUT_MS) throw new TypeError();
    comparison = await compareStoreOwner(store, fingerprint);
  } catch {
    await closeReadonlyStore(store);
    return "store-unavailable";
  }
  try {
    await store.close();
    return comparison;
  } catch {
    return "store-unavailable";
  }
}

function abortableIntervalsCredentialFetch(
  baseFetch: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    const signal = init?.signal;
    try {
      signal?.throwIfAborted();
      const response =
        signal == null
          ? await baseFetch(input, init)
          : await withIntervalsCredentialAbort(baseFetch(input, init), signal);
      return new Proxy(response, {
        get(target, property) {
          if (property === "arrayBuffer") {
            return async (): Promise<ArrayBuffer> => {
              try {
                const body = target.arrayBuffer();
                return signal == null
                  ? await body
                  : await withIntervalsCredentialAbort(body, signal);
              } catch {
                if (signal?.aborted) throw signal.reason;
                throw new IntervalsCredentialTransportError(target.status);
              }
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    } catch {
      if (signal?.aborted) throw signal.reason;
      throw new IntervalsCredentialTransportError();
    }
  };
}

async function withIntervalsCredentialAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return await awaitWithSignal(operation, signal);
}

function timeoutFailure(error: unknown): boolean {
  return (
    error instanceof SyncBudgetExceededError ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "TimeoutError")
  );
}

export async function verifyIntervalsCredentialAtPathWithEvidence(
  storePath: string,
  options: Omit<StoreOwnerCheckOptions, "signal" | "budget"> & {
    readonly signal: AbortSignal;
    readonly overallTimeoutMs?: number;
    readonly perRequestTimeoutMs?: number;
    readonly compareOwner?: (
      storePath: string,
      fingerprint: string,
    ) => Promise<IntervalsStoreOwnerComparison>;
  },
): Promise<IntervalsCredentialVerificationWithEvidenceResult> {
  const overallTimeoutMs = options.overallTimeoutMs ?? INTERVALS_CREDENTIAL_VERIFICATION_TIMEOUT_MS;
  const perRequestTimeoutMs =
    options.perRequestTimeoutMs ?? INTERVALS_CREDENTIAL_REQUEST_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(overallTimeoutMs) ||
    overallTimeoutMs <= 0 ||
    !Number.isSafeInteger(perRequestTimeoutMs) ||
    perRequestTimeoutMs <= 0
  ) {
    throw new TypeError();
  }
  if (options.signal.aborted) {
    return { status: "refused", reason: "validation-aborted" };
  }
  const overallController = new AbortController();
  const timeout = setTimeout(
    () => overallController.abort(new DOMException("", "TimeoutError")),
    overallTimeoutMs,
  );
  timeout.unref();
  const shutdownSignal = options.signal;
  const signal = AbortSignal.any([shutdownSignal, overallController.signal]);
  const budget: SyncBudget = {
    signal,
    clock: { monotonicNow: () => options.clock.monotonicNow() },
    deadlineMonotonicMs: options.clock.monotonicNow() + overallTimeoutMs,
    perRequestTimeoutMs,
    maxRequests: REQUEST_ATTEMPTS,
    maxArtifacts: 1_000,
  };
  try {
    let fingerprint: string | null;
    try {
      fingerprint = await resolveIntervalsStoreOwnerFingerprint({
        ...options,
        signal,
        budget,
        baseFetch: abortableIntervalsCredentialFetch(options.baseFetch ?? globalThis.fetch),
      });
      signal.throwIfAborted();
    } catch (error) {
      if (shutdownSignal.aborted) {
        return { status: "refused", reason: "validation-aborted" };
      }
      if (overallController.signal.aborted || timeoutFailure(error)) {
        return { status: "refused", reason: "validation-timeout" };
      }
      if (
        error instanceof IntervalsHttpError ||
        error instanceof IntervalsCredentialTransportError
      ) {
        return {
          status: "refused",
          reason:
            error.status === 401 || error.status === 403
              ? "credential-rejected"
              : "validation-unavailable",
        };
      }
      return {
        status: "refused",
        reason: "malformed-athlete-response",
      };
    }
    if (fingerprint === null) return { status: "refused", reason: "owner-unresolved" };
    let comparison: IntervalsStoreOwnerComparison;
    try {
      comparison = await withIntervalsCredentialAbort(
        (options.compareOwner ?? compareIntervalsStoreOwnerFingerprintAtPath)(
          storePath,
          fingerprint,
        ),
        signal,
      );
      signal.throwIfAborted();
    } catch {
      if (shutdownSignal.aborted) {
        return { status: "refused", reason: "validation-aborted" };
      }
      if (overallController.signal.aborted) {
        return { status: "refused", reason: "validation-timeout" };
      }
      comparison = "store-unavailable";
    }
    if (comparison === "matched" || comparison === "unowned") {
      const ownerState: IntervalsStoreOwnerState =
        comparison === "unowned"
          ? Object.freeze({ status: "unowned" })
          : Object.freeze({ status: "owned", fingerprint });
      return {
        status: "verified",
        evidence: Object.freeze({ verifiedFingerprint: fingerprint, ownerState }),
      };
    }
    if (comparison === "mismatch") {
      return { status: "refused", reason: "training-account-mismatch" };
    }
    return { status: "refused", reason: "store-unavailable" };
  } finally {
    clearTimeout(timeout);
  }
}

export async function verifyIntervalsCredentialAtPath(
  storePath: string,
  options: Omit<StoreOwnerCheckOptions, "signal" | "budget"> & {
    readonly signal: AbortSignal;
    readonly overallTimeoutMs?: number;
    readonly perRequestTimeoutMs?: number;
    readonly compareOwner?: (
      storePath: string,
      fingerprint: string,
    ) => Promise<IntervalsStoreOwnerComparison>;
  },
): Promise<IntervalsCredentialVerificationResult> {
  const result = await verifyIntervalsCredentialAtPathWithEvidence(storePath, options);
  return result.status === "verified" ? { status: "verified" } : result;
}
