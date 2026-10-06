import {
  INTERVALS_CREDENTIAL_VERIFICATION_TIMEOUT_MS,
  verifyIntervalsCredentialAtPath,
  type IntervalsCredentialVerificationRefusalReason,
} from "@enduragent/coach/account-identity";
import { awaitWithSignal } from "@enduragent/coach/abortable-operation";
import type {
  RuntimeConfigSnapshot,
  VerifyIntervalsCredentialRpcResult,
} from "@enduragent/coach-contract";
import type { Clipboard, IpcMain, IpcMainInvokeEvent } from "electron";
import { DESKTOP_INTERVALS_PASTE_CREDENTIAL_CHANNEL } from "./constants.js";
import { intervalsAthleteIdForOwnership } from "./credential-runtime.js";
import type {
  CredentialRuntimeState,
  CredentialState,
  CredentialVault,
} from "./credential-vault.js";

const VERIFICATION_REFUSAL_REASONS = new Set<IntervalsCredentialVerificationRefusalReason>([
  "credential-rejected",
  "malformed-athlete-response",
  "validation-timeout",
  "validation-aborted",
  "validation-unavailable",
  "training-account-mismatch",
  "owner-unresolved",
  "store-unavailable",
]);
const STORAGE_REFUSAL_REASONS = new Set([
  "encryption-unavailable",
  "unsafe-backend",
  "storage-failed",
  "runtime-unavailable",
]);
const INTERVALS_API_KEY_MAX_LENGTH = 256;
const INTERVALS_VERIFICATION_APPROVAL_PATTERN = /^[0-9a-f]{64}$/;

export type DesktopIntervalsCredentialVerificationResult =
  | Readonly<{ status: "verified"; verificationApproval?: string }>
  | Readonly<{
      status: "refused";
      reason: IntervalsCredentialVerificationRefusalReason;
    }>;

export interface DesktopIntervalsCredentialStatus {
  readonly slot: "intervals-icu";
  readonly state: CredentialState;
  readonly runtimeState: CredentialRuntimeState | null;
}

type DesktopIntervalsMutationRefusalReason =
  | "clipboard-unavailable"
  | "clipboard-clear-failed"
  | "invalid-key-format"
  | IntervalsCredentialVerificationRefusalReason
  | "encryption-unavailable"
  | "unsafe-backend"
  | "storage-failed"
  | "runtime-unavailable";

export function createDesktopIntervalsCredentialVerifier(input: {
  readonly storePath: string;
  readonly readRuntimeConfig: (signal?: AbortSignal) => Promise<RuntimeConfigSnapshot>;
  readonly verifyWithDaemon?: (
    apiKey: string,
    signal: AbortSignal,
  ) => Promise<VerifyIntervalsCredentialRpcResult | undefined>;
}): (
  apiKey: string,
  signal: AbortSignal,
) => Promise<DesktopIntervalsCredentialVerificationResult> {
  return async (apiKey, signal) => {
    if (input.verifyWithDaemon !== undefined) {
      let result: unknown;
      try {
        result = await input.verifyWithDaemon(apiKey, signal);
        signal.throwIfAborted();
      } catch {
        signal.throwIfAborted();
        return { status: "refused", reason: "validation-unavailable" };
      }
      if (result !== undefined) {
        if (
          record(result) &&
          typeof result.approval === "string" &&
          INTERVALS_VERIFICATION_APPROVAL_PATTERN.test(result.approval) &&
          exactKeys(result, ["approval"])
        ) {
          return { status: "verified", verificationApproval: result.approval };
        }
        if (
          record(result) &&
          typeof result.reason === "string" &&
          VERIFICATION_REFUSAL_REASONS.has(
            result.reason as IntervalsCredentialVerificationRefusalReason,
          ) &&
          exactKeys(result, ["reason"])
        ) {
          return {
            status: "refused",
            reason: result.reason as IntervalsCredentialVerificationRefusalReason,
          };
        }
        return { status: "refused", reason: "validation-unavailable" };
      }
    }
    let snapshot: RuntimeConfigSnapshot;
    try {
      snapshot = await input.readRuntimeConfig(signal);
    } catch {
      return { status: "refused", reason: "validation-unavailable" };
    }
    return verifyIntervalsCredentialAtPath(input.storePath, {
      apiKey,
      athleteId: intervalsAthleteIdForOwnership(snapshot),
      historyNewestDate: "1970-01-01",
      clock: { now: () => Date.now(), monotonicNow: () => performance.now() },
      signal,
    });
  };
}

type DesktopIntervalsMutationCore =
  | Readonly<{ outcome: "applied" }>
  | Readonly<{ outcome: "refused"; reason: DesktopIntervalsMutationRefusalReason }>
  | Readonly<{
      outcome: "uncertain";
      reason: "storage-uncertain" | "runtime-uncertain";
    }>;

type DesktopIntervalsMutationResult = DesktopIntervalsMutationCore &
  Readonly<{ current: DesktopIntervalsCredentialStatus }>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159)) return true;
  }
  return false;
}

function copyStatus(value: unknown): DesktopIntervalsCredentialStatus | undefined {
  if (
    !record(value) ||
    !exactKeys(value, ["runtimeState", "slot", "state"]) ||
    value.slot !== "intervals-icu" ||
    (value.state !== "missing" && value.state !== "configured" && value.state !== "re-prompt")
  ) {
    return undefined;
  }
  if (value.state === "configured") {
    if (
      value.runtimeState !== "active" &&
      value.runtimeState !== "stored-inactive" &&
      value.runtimeState !== "failed"
    ) {
      return undefined;
    }
    return { slot: "intervals-icu", state: value.state, runtimeState: value.runtimeState };
  }
  if (value.runtimeState !== null) return undefined;
  return { slot: "intervals-icu", state: value.state, runtimeState: null };
}

function closedStatus(): DesktopIntervalsCredentialStatus {
  return { slot: "intervals-icu", state: "re-prompt", runtimeState: null };
}

function copyVerification(value: unknown): DesktopIntervalsCredentialVerificationResult {
  if (!record(value) || typeof value.status !== "string") throw new TypeError();
  if (value.status === "verified" && exactKeys(value, ["status"])) {
    return { status: "verified" };
  }
  if (
    value.status === "verified" &&
    typeof value.verificationApproval === "string" &&
    INTERVALS_VERIFICATION_APPROVAL_PATTERN.test(value.verificationApproval) &&
    exactKeys(value, ["status", "verificationApproval"])
  ) {
    return { status: "verified", verificationApproval: value.verificationApproval };
  }
  if (
    value.status === "refused" &&
    typeof value.reason === "string" &&
    VERIFICATION_REFUSAL_REASONS.has(
      value.reason as IntervalsCredentialVerificationRefusalReason,
    ) &&
    exactKeys(value, ["reason", "status"])
  ) {
    return {
      status: "refused",
      reason: value.reason as IntervalsCredentialVerificationRefusalReason,
    };
  }
  throw new TypeError();
}

function copyMutation(value: unknown): DesktopIntervalsMutationCore {
  if (!record(value) || typeof value.outcome !== "string") throw new TypeError();
  if (value.outcome === "applied" && exactKeys(value, ["outcome"])) {
    return { outcome: "applied" };
  }
  if (
    value.outcome === "refused" &&
    typeof value.reason === "string" &&
    (VERIFICATION_REFUSAL_REASONS.has(
      value.reason as IntervalsCredentialVerificationRefusalReason,
    ) ||
      STORAGE_REFUSAL_REASONS.has(value.reason)) &&
    exactKeys(value, ["outcome", "reason"])
  ) {
    return { outcome: "refused", reason: value.reason as DesktopIntervalsMutationRefusalReason };
  }
  if (
    value.outcome === "uncertain" &&
    (value.reason === "storage-uncertain" || value.reason === "runtime-uncertain") &&
    exactKeys(value, ["outcome", "reason"])
  ) {
    return { outcome: "uncertain", reason: value.reason };
  }
  throw new TypeError();
}

function mutationFromWrite(value: unknown): DesktopIntervalsMutationCore {
  if (!record(value) || value.slot !== "intervals-icu" || typeof value.status !== "string") {
    throw new TypeError();
  }
  if (
    value.status === "configured" &&
    typeof value.runtimeReady === "boolean" &&
    exactKeys(value, ["runtimeReady", "slot", "status"])
  ) {
    return value.runtimeReady
      ? { outcome: "applied" }
      : { outcome: "uncertain", reason: "runtime-uncertain" };
  }
  if (
    value.status === "uncertain" &&
    value.reason === "storage-uncertain" &&
    exactKeys(value, ["reason", "slot", "status"])
  ) {
    return { outcome: "uncertain", reason: "storage-uncertain" };
  }
  if (
    value.status === "refused" &&
    typeof value.reason === "string" &&
    (STORAGE_REFUSAL_REASONS.has(value.reason) ||
      VERIFICATION_REFUSAL_REASONS.has(
        value.reason as IntervalsCredentialVerificationRefusalReason,
      )) &&
    exactKeys(value, ["reason", "slot", "status"])
  ) {
    return { outcome: "refused", reason: value.reason as DesktopIntervalsMutationRefusalReason };
  }
  throw new TypeError();
}

async function captureClipboard(clipboard: Pick<Clipboard, "readText" | "clear">): Promise<
  | { readonly status: "captured"; readonly apiKey: string }
  | {
      readonly status: "refused";
      readonly reason: "clipboard-unavailable" | "clipboard-clear-failed" | "invalid-key-format";
    }
> {
  let value: unknown;
  let cleared = false;
  try {
    value = await clipboard.readText();
  } catch {
  } finally {
    try {
      clipboard.clear();
      cleared = true;
    } catch {}
  }
  if (!cleared) return { status: "refused", reason: "clipboard-clear-failed" };
  if (typeof value !== "string") {
    return { status: "refused", reason: "clipboard-unavailable" };
  }
  const apiKey = value.trim();
  if (
    apiKey.length === 0 ||
    apiKey.length > INTERVALS_API_KEY_MAX_LENGTH ||
    hasControlCharacter(apiKey)
  ) {
    return { status: "refused", reason: "invalid-key-format" };
  }
  return { status: "captured", apiKey };
}

export function installDesktopIntervalsIpc(input: {
  readonly ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  readonly clipboard: Pick<Clipboard, "readText" | "clear">;
  readonly isTrusted: (event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">) => boolean;
  readonly signal: AbortSignal;
  readonly vault: Pick<CredentialVault, "credentialStatuses" | "runExclusiveMutation">;
  readonly verifyCredential: (
    apiKey: string,
    signal: AbortSignal,
  ) => Promise<DesktopIntervalsCredentialVerificationResult>;
}): () => Promise<void> {
  let accepting = true;
  let closePromise: Promise<void> | undefined;
  let operationQueue = Promise.resolve();
  const pendingVerifications = new Set<Promise<DesktopIntervalsCredentialVerificationResult>>();
  const closeController = new AbortController();
  const verificationSignal = AbortSignal.any([input.signal, closeController.signal]);
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = operationQueue.then(operation, operation);
    operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const trustedZeroArgument = (
    event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">,
    args: readonly unknown[],
  ): void => {
    if (!accepting) throw new TypeError();
    if (!input.isTrusted(event)) throw new Error("untrusted desktop Intervals request");
    if (args.length !== 0) throw new TypeError("invalid desktop Intervals request");
  };
  const readStatus = async (): Promise<DesktopIntervalsCredentialStatus> => {
    try {
      const statuses = await input.vault.credentialStatuses();
      const intervals = statuses.find((status) => status.slot === "intervals-icu");
      return copyStatus(intervals) ?? closedStatus();
    } catch {
      return closedStatus();
    }
  };
  const verifyCandidate = async (
    apiKey: string,
  ): Promise<DesktopIntervalsCredentialVerificationResult> => {
    if (verificationSignal.aborted) {
      return { status: "refused", reason: "validation-aborted" };
    }
    const timeoutController = new AbortController();
    const timeout = setTimeout(
      () => timeoutController.abort(new DOMException("", "TimeoutError")),
      INTERVALS_CREDENTIAL_VERIFICATION_TIMEOUT_MS,
    );
    timeout.unref();
    const signal = AbortSignal.any([verificationSignal, timeoutController.signal]);
    try {
      try {
        const operation = input.verifyCredential(apiKey, signal);
        pendingVerifications.add(operation);
        void operation.then(
          () => pendingVerifications.delete(operation),
          () => pendingVerifications.delete(operation),
        );
        signal.throwIfAborted();
        const verification = copyVerification(await awaitWithSignal(operation, signal));
        if (verificationSignal.aborted) {
          return { status: "refused", reason: "validation-aborted" };
        }
        if (timeoutController.signal.aborted) {
          return { status: "refused", reason: "validation-timeout" };
        }
        return verification;
      } catch {
        return {
          status: "refused",
          reason: verificationSignal.aborted
            ? "validation-aborted"
            : timeoutController.signal.aborted
              ? "validation-timeout"
              : "validation-unavailable",
        };
      }
    } finally {
      clearTimeout(timeout);
    }
  };
  const runCapturedCredential = (apiKey: string): Promise<DesktopIntervalsMutationResult> =>
    serialize(async () => {
      try {
        const transaction = await input.vault.runExclusiveMutation(async (mutation) => {
          const verification = await verifyCandidate(apiKey);
          let result: DesktopIntervalsMutationCore;
          if (verification.status === "refused") {
            result = { outcome: "refused", reason: verification.reason };
          } else {
            const behavior = {
              rollbackOnRuntimeRefusal: true,
              ...(verification.verificationApproval === undefined
                ? {}
                : { verificationApproval: verification.verificationApproval }),
            };
            result = mutationFromWrite(
              await mutation.writeCredential(
                {
                  slot: "intervals-icu",
                  value: apiKey,
                },
                behavior,
              ),
            );
          }
          const statuses = await mutation.credentialStatuses();
          return {
            mutation: result,
            current: statuses.find((entry) => entry.slot === "intervals-icu"),
          };
        });
        if (!record(transaction) || !exactKeys(transaction, ["current", "mutation"])) {
          throw new TypeError();
        }
        const current = copyStatus(transaction.current);
        if (current === undefined) throw new TypeError();
        return { ...copyMutation(transaction.mutation), current };
      } catch {
        return {
          outcome: "uncertain",
          reason: "storage-uncertain",
          current: closedStatus(),
        };
      }
    });
  const localRefusal = (
    reason: "clipboard-unavailable" | "clipboard-clear-failed" | "invalid-key-format",
  ): Promise<DesktopIntervalsMutationResult> =>
    serialize(async () => ({ outcome: "refused", reason, current: await readStatus() }));
  const handlers = [
    [
      DESKTOP_INTERVALS_PASTE_CREDENTIAL_CHANNEL,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        trustedZeroArgument(event, args);
        return captureClipboard(input.clipboard).then((captured) => {
          if (captured.status === "refused") return localRefusal(captured.reason);
          return runCapturedCredential(captured.apiKey);
        });
      },
    ],
  ] as const;
  for (const [channel, handler] of handlers) input.ipcMain.handle(channel, handler);
  return () => {
    if (closePromise !== undefined) return closePromise;
    accepting = false;
    for (const [channel] of handlers) input.ipcMain.removeHandler(channel);
    closeController.abort();
    closePromise = Promise.all([
      operationQueue,
      ...[...pendingVerifications].map((operation) =>
        operation.then(
          () => undefined,
          () => undefined,
        ),
      ),
    ]).then(() => undefined);
    return closePromise;
  };
}
