import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AthleteHomeIdentitySchema, type AthleteHomeIdentity } from "@enduragent/coach-contract";
import type { PowerMonitor } from "electron";
import {
  assertWindowsPrivateDirectoryStable,
  assertWindowsPrivatePathRead,
  bindWindowsPrivateDirectory,
  classifyWindowsPrivatePathDurability,
  type WindowsPrivateDirectoryBinding,
} from "@enduragent/core";
import { durableAtomicReplace, type DurableReplaceOutcome } from "./durable-atomic-replace.js";
import { assertWindowsPrivateFileAtPath, readWindowsPrivateFile } from "./windows-private-file.js";

export const TELEGRAM_POWER_STATE_FILE_NAME = "power-state.json" as const;
export const TELEGRAM_POWER_STATE_DIRECTORY_MODE = 0o700;
export const TELEGRAM_POWER_STATE_FILE_MODE = 0o600;
export const TELEGRAM_POSSIBLE_MESSAGE_LOSS_AFTER_MS = 24 * 60 * 60 * 1_000;

const MAX_STATE_FILE_BYTES = 4_096;

export type TelegramGapWarning =
  | Readonly<{ state: "clear" }>
  | Readonly<{ state: "possible-message-loss"; detectedAt: string }>;

export type TelegramPowerFailure =
  | "clock"
  | "read-state"
  | "write-state"
  | "read-polling-status"
  | "stop-polling"
  | "resume-polling";

export interface TelegramPowerControllerPort {
  stopPolling(): Promise<unknown>;
  resumePolling(): Promise<unknown>;
  status(): Promise<unknown>;
}

export type TelegramPowerMonitorPort = Pick<PowerMonitor, "on" | "off">;

export interface DesktopTelegramPowerLifecycle {
  start(): Promise<TelegramGapWarning>;
  warning(): Promise<TelegramGapWarning>;
  resetForCreate(): Promise<TelegramGapWarning>;
  acknowledgeWarning(): Promise<TelegramGapWarning>;
  close(): Promise<void>;
}

export interface CreateDesktopTelegramPowerLifecycleInput {
  readonly root: string;
  readonly athleteHome: AthleteHomeIdentity;
  readonly powerMonitor: TelegramPowerMonitorPort;
  readonly controller: TelegramPowerControllerPort;
  readonly now?: () => number;
  readonly createId?: () => string;
  readonly renameFile?: typeof rename;
  readonly removeFile?: typeof rm;
  readonly syncDirectory?: (root: string) => Promise<void>;
  readonly syncParentDirectory?: (root: string) => Promise<void>;
  readonly reportFailure?: (failure: TelegramPowerFailure) => void;
  readonly observeWarning?: (warning: TelegramGapWarning) => void;
  readonly platform?: NodeJS.Platform;
  readonly openFile?: typeof open;
}

interface TelegramPowerStateRecord {
  readonly schemaVersion: 2;
  readonly athleteHome: AthleteHomeIdentity;
  readonly gapStartedAt: string | null;
  readonly lastSuccessfulPollAt: string | null;
  readonly suspendedAt: string | null;
  readonly warningDetectedAt: string | null;
}

interface TelegramPollingHealthObservation {
  readonly desiredState: "disabled" | "enabled";
  readonly state: string;
  readonly lastSuccessfulPollAt: string | null;
}

class TelegramPowerStateScopeMismatch extends Error {}

const CLEAR_WARNING: TelegramGapWarning = Object.freeze({ state: "clear" });

function permissions(mode: number): number {
  return mode & 0o777;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function canonicalTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 40) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  const canonical = new Date(parsed).toISOString();
  return canonical === value ? canonical : undefined;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function pollingHealth(value: unknown): TelegramPollingHealthObservation | undefined {
  if (!record(value) || !record(value.channel)) return undefined;
  const channel = value.channel;
  if (
    (channel.desiredState !== "disabled" && channel.desiredState !== "enabled") ||
    typeof channel.state !== "string"
  ) {
    return undefined;
  }
  const lastSuccessfulPollAt =
    channel.lastSuccessfulPollAt === undefined
      ? null
      : (canonicalTimestamp(channel.lastSuccessfulPollAt) ?? null);
  return {
    desiredState: channel.desiredState,
    state: channel.state,
    lastSuccessfulPollAt,
  };
}
function parseState(
  contents: string,
  athleteHome: AthleteHomeIdentity,
): TelegramPowerStateRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const parsedHome = AthleteHomeIdentitySchema.safeParse(record.athleteHome);
  const suspendedAt =
    record.suspendedAt === null ? null : (canonicalTimestamp(record.suspendedAt) ?? undefined);
  const warningDetectedAt =
    record.warningDetectedAt === null
      ? null
      : (canonicalTimestamp(record.warningDetectedAt) ?? undefined);
  if (parsedHome.success && parsedHome.data !== athleteHome) {
    throw new TelegramPowerStateScopeMismatch();
  }
  if (!parsedHome.success || suspendedAt === undefined || warningDetectedAt === undefined) {
    return undefined;
  }
  if (
    record.schemaVersion === 1 &&
    exactKeys(record, ["athleteHome", "schemaVersion", "suspendedAt", "warningDetectedAt"])
  ) {
    return {
      schemaVersion: 2,
      athleteHome,
      gapStartedAt: suspendedAt,
      lastSuccessfulPollAt: null,
      suspendedAt,
      warningDetectedAt,
    };
  }
  if (
    record.schemaVersion !== 2 ||
    !exactKeys(record, [
      "athleteHome",
      "gapStartedAt",
      "lastSuccessfulPollAt",
      "schemaVersion",
      "suspendedAt",
      "warningDetectedAt",
    ])
  ) {
    return undefined;
  }
  const gapStartedAt =
    record.gapStartedAt === null ? null : (canonicalTimestamp(record.gapStartedAt) ?? undefined);
  const lastSuccessfulPollAt =
    record.lastSuccessfulPollAt === null
      ? null
      : (canonicalTimestamp(record.lastSuccessfulPollAt) ?? undefined);
  if (gapStartedAt === undefined || lastSuccessfulPollAt === undefined) return undefined;
  return {
    schemaVersion: 2,
    athleteHome,
    gapStartedAt,
    lastSuccessfulPollAt,
    suspendedAt,
    warningDetectedAt,
  };
}
function assertOwner(metadata: Stats, mode: number): void {
  if (
    metadata.isSymbolicLink() ||
    permissions(metadata.mode) !== mode ||
    (typeof process.getuid === "function" && metadata.uid !== process.getuid())
  ) {
    throw new TypeError("unsafe Telegram power state path");
  }
}
async function assertDirectory(
  root: string,
  create: boolean,
  platform: NodeJS.Platform,
  bindWindowsDirectory: () => WindowsPrivateDirectoryBinding,
): Promise<void> {
  if (create) await mkdir(root, { recursive: true, mode: TELEGRAM_POWER_STATE_DIRECTORY_MODE });
  const metadata = await lstat(root);
  if (platform === "win32") {
    bindWindowsDirectory();
    return;
  }
  if (!metadata.isDirectory()) throw new TypeError("Telegram power state root is not a directory");
  assertOwner(metadata, TELEGRAM_POWER_STATE_DIRECTORY_MODE);
}
function emptyState(athleteHome: AthleteHomeIdentity): TelegramPowerStateRecord {
  return {
    schemaVersion: 2,
    athleteHome,
    gapStartedAt: null,
    lastSuccessfulPollAt: null,
    suspendedAt: null,
    warningDetectedAt: null,
  };
}
function createStateStore(input: {
  readonly root: string;
  readonly athleteHome: AthleteHomeIdentity;
  readonly createId: () => string;
  readonly renameFile?: typeof rename;
  readonly removeFile?: typeof rm;
  readonly syncDirectory?: (root: string) => Promise<void>;
  readonly syncParentDirectory?: (root: string) => Promise<void>;
  readonly platform: NodeJS.Platform;
  readonly openFile?: typeof open;
}) {
  const target = join(input.root, TELEGRAM_POWER_STATE_FILE_NAME);
  let namespaceState: "pending" | "verified" | "uncertain" = "pending";
  let parentDirectoryVerified = false;
  const defaultSynchronizeDirectory = async (root: string): Promise<void> => {
    const directory = await open(root, "r");
    try {
      await directory.sync();
    } catch (error) {
      try {
        await directory.close();
      } catch (closeError) {
        const code = (closeError as NodeJS.ErrnoException).code;
        if (code !== "ERR_DIR_CLOSED" && code !== "EBADF") throw closeError;
      }
      throw error;
    }
    try {
      await directory.close();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ERR_DIR_CLOSED" && code !== "EBADF") throw error;
    }
  };
  const rawSynchronizeDirectory = input.syncDirectory ?? defaultSynchronizeDirectory;
  const rawSynchronizeParentDirectory = input.syncParentDirectory ?? defaultSynchronizeDirectory;
  const synchronizeDirectory = async (root: string): Promise<void> => {
    if (
      input.platform === "win32" &&
      classifyWindowsPrivatePathDurability("directory-sync").kind === "unavailable"
    ) {
      return;
    }
    await rawSynchronizeDirectory(root);
  };
  const synchronizeParentDirectory = async (root: string): Promise<void> => {
    if (
      input.platform === "win32" &&
      classifyWindowsPrivatePathDurability("directory-sync").kind === "unavailable"
    ) {
      return;
    }
    await rawSynchronizeParentDirectory(root);
  };
  let windowsDirectory: WindowsPrivateDirectoryBinding | undefined;
  const bindStateDirectory = (): WindowsPrivateDirectoryBinding => {
    if (windowsDirectory === undefined) {
      windowsDirectory = bindWindowsPrivateDirectory(dirname(input.root), input.root);
    } else {
      assertWindowsPrivateDirectoryStable(windowsDirectory);
    }
    return windowsDirectory;
  };
  const reconcileNamespace = async (): Promise<void> => {
    if (namespaceState === "verified") return;
    if (namespaceState === "uncertain") throw new TypeError("Telegram power state is uncertain");
    try {
      try {
        await assertDirectory(input.root, false, input.platform, bindStateDirectory);
      } catch (error) {
        if (isMissing(error)) {
          namespaceState = "verified";
          return;
        }
        throw error;
      }
      const prefix = `.${TELEGRAM_POWER_STATE_FILE_NAME}.`;
      for (const entry of await readdir(input.root)) {
        if (!entry.startsWith(prefix) || !entry.endsWith(".tmp")) continue;
        const id = entry.slice(prefix.length, -".tmp".length);
        if (/^[A-Za-z0-9-]{1,128}$/.test(id)) {
          await (input.removeFile ?? rm)(join(input.root, entry), { force: true });
        }
      }
      await synchronizeDirectory(input.root);
      namespaceState = "verified";
      } catch (error) {
        namespaceState = "uncertain";
        throw error;
      }
  };
  const read = async (): Promise<TelegramPowerStateRecord> => {
    await reconcileNamespace();
    let rootMetadata;
    try {
      rootMetadata = await lstat(input.root);
    } catch (error) {
      if (isMissing(error)) return emptyState(input.athleteHome);
      throw error;
    }
    if (input.platform === "win32") {
      const snapshot = await readWindowsPrivateFile({
        directory: bindStateDirectory(),
        path: target,
        maximumBytes: MAX_STATE_FILE_BYTES,
        openFile: input.openFile,
      });
      if (snapshot === undefined) return emptyState(input.athleteHome);
      try {
        const state = parseState(snapshot.contents.toString("utf8"), input.athleteHome);
        if (state === undefined) {
          assertWindowsPrivatePathRead({
            bounded: true,
            identityStable: true,
            contentValid: false,
            authenticatedHomeBinding: true,
          });
        }
        return state!;
      } finally {
        snapshot.contents.fill(0);
      }
    }
    if (!rootMetadata.isDirectory()) throw new TypeError("invalid Telegram power state root");
    assertOwner(rootMetadata, TELEGRAM_POWER_STATE_DIRECTORY_MODE);
    let before;
    try {
      before = await lstat(target);
    } catch (error) {
      if (isMissing(error)) return emptyState(input.athleteHome);
      throw error;
    }
    if (!before.isFile() || before.size > MAX_STATE_FILE_BYTES) {
      throw new TypeError("invalid Telegram power state file");
    }
    assertOwner(before, TELEGRAM_POWER_STATE_FILE_MODE);
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
    const handle = await open(target, flags);
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size > MAX_STATE_FILE_BYTES
      ) {
        throw new TypeError("Telegram power state changed while opening");
      }
      assertOwner(opened, TELEGRAM_POWER_STATE_FILE_MODE);
      const contents = await handle.readFile("utf8");
      const state = parseState(contents, input.athleteHome);
      if (state === undefined) throw new TypeError("invalid Telegram power state record");
      return state;
    } finally {
      await handle.close();
    }
  };
  const write = async (state: TelegramPowerStateRecord): Promise<DurableReplaceOutcome> => {
    await reconcileNamespace();
    await assertDirectory(input.root, true, input.platform, bindStateDirectory);
    if (!parentDirectoryVerified) {
      await synchronizeParentDirectory(dirname(input.root));
      parentDirectoryVerified = true;
    }
    try {
      const existing = await lstat(target);
      if (input.platform === "win32") {
        assertWindowsPrivateFileAtPath(
          bindStateDirectory(),
          target,
          existing,
          0,
          MAX_STATE_FILE_BYTES,
        );
      } else {
        if (!existing.isFile()) throw new TypeError("invalid Telegram power state target");
        assertOwner(existing, TELEGRAM_POWER_STATE_FILE_MODE);
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const id = input.createId();
    if (!/^[A-Za-z0-9-]{1,128}$/.test(id)) throw new TypeError("invalid temporary file id");
    const candidate = Buffer.from(`${JSON.stringify(state)}\n`, "utf8");
    try {
      const outcome = await durableAtomicReplace({
        root: input.root,
        fileName: TELEGRAM_POWER_STATE_FILE_NAME,
        contents: candidate,
        mode: TELEGRAM_POWER_STATE_FILE_MODE,
        createId: () => id,
        renameFile: input.renameFile,
        removeFile: input.removeFile,
        syncDirectory: input.platform === "win32" ? synchronizeDirectory : input.syncDirectory,
        platform: input.platform,
      });
      namespaceState = outcome.state === "commit-uncertain" ? "uncertain" : "verified";
      return outcome;
    } finally {
      candidate.fill(0);
    }
  };
  return { read, write };
}
function warningFor(state: TelegramPowerStateRecord): TelegramGapWarning {
  return state.warningDetectedAt === null
    ? CLEAR_WARNING
    : { state: "possible-message-loss", detectedAt: state.warningDetectedAt };
}
function timestamp(now: () => number): string {
  const value = now();
  if (!Number.isFinite(value) || value < 0 || value > 8_640_000_000_000_000) {
    throw new TypeError("invalid clock");
  }
  return new Date(value).toISOString();
}
export function createDesktopTelegramPowerLifecycle(
  input: CreateDesktopTelegramPowerLifecycleInput,
): DesktopTelegramPowerLifecycle {
  const athleteHome = AthleteHomeIdentitySchema.parse(input.athleteHome);
  const now = input.now ?? Date.now;
  const store = createStateStore({
    root: input.root,
    athleteHome,
    createId: input.createId ?? randomUUID,
    renameFile: input.renameFile,
    removeFile: input.removeFile,
    syncDirectory: input.syncDirectory,
    syncParentDirectory: input.syncParentDirectory,
    platform: input.platform ?? process.platform,
    openFile: input.openFile,
  });
  let cached: TelegramGapWarning = CLEAR_WARNING;
  let pending: Promise<void> = Promise.resolve();
  let started = false;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let scopeMismatch = false;
  let transientStopOutstanding = false;
  const report = (failure: TelegramPowerFailure): void => {
    try {
      input.reportFailure?.(failure);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    }
  };
  const publish = (warning: TelegramGapWarning): TelegramGapWarning => {
    cached = warning;
    try {
      input.observeWarning?.(warning);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    }
    return warning;
  };
  const uncertain = (): TelegramGapWarning => {
    if (cached.state === "possible-message-loss") return publish(cached);
    let detectedAt = "1970-01-01T00:00:00.000Z";
    try {
      detectedAt = timestamp(now);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    }
    return publish({ state: "possible-message-loss", detectedAt });
  };
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = pending.then(operation);
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const readState = async (): Promise<TelegramPowerStateRecord | undefined> => {
    try {
      const state = await store.read();
      scopeMismatch = false;
      return state;
    } catch (error) {
      scopeMismatch = error instanceof TelegramPowerStateScopeMismatch;
      report("read-state");
      uncertain();
      return undefined;
    }
  };
  const writeState = async (
    state: TelegramPowerStateRecord,
  ): Promise<DurableReplaceOutcome["state"]> => {
    try {
      const result = await store.write(state);
      if (result.state === "durably-committed") return result.state;
      report("write-state");
      uncertain();
      return result.state;
    } catch {
      report("write-state");
      uncertain();
      return "not-committed";
    }
  };
  const retainedWarning = (state: TelegramPowerStateRecord): string | null =>
    state.warningDetectedAt ??
    (cached.state === "possible-message-loss" ? cached.detectedAt : null);
  const warnForGap = (
    state: TelegramPowerStateRecord,
    startedAt: string | null,
    endedAt: string,
    detectedAt: string,
  ): string | null => {
    const retained = retainedWarning(state);
    if (retained !== null || startedAt === null) return retained;
    const gap = Date.parse(endedAt) - Date.parse(startedAt);
    return gap < 0 || gap >= TELEGRAM_POSSIBLE_MESSAGE_LOSS_AFTER_MS ? detectedAt : null;
  };
  const publishState = async (state: TelegramPowerStateRecord): Promise<TelegramGapWarning> => {
    const result = await writeState(state);
    if (closed || result !== "durably-committed") return cached;
    return publish(warningFor(state));
  };
  const laterTimestamp = (left: string | null, right: string | null): string | null => {
    if (left === null) return right;
    if (right === null) return left;
    return Date.parse(left) >= Date.parse(right) ? left : right;
  };
  const observedAt = (): string | undefined => {
    try {
      return timestamp(now);
    } catch {
      report("clock");
      uncertain();
      return undefined;
    }
  };
  const stopPolling = async (): Promise<void> => {
    if (closed) return;
    transientStopOutstanding = true;
    try {
      const result = await input.controller.stopPolling();
      if (pollingHealth(result)?.state === "failed") report("stop-polling");
    } catch {
      report("stop-polling");
    }
  };
  const resumePolling = async (duringClose = false): Promise<unknown> => {
    if (closed && !duringClose) return undefined;
    try {
      const result = await input.controller.resumePolling();
      if (pollingHealth(result)?.state === "failed") {
        report("resume-polling");
        return result;
      }
      transientStopOutstanding = false;
      return result;
    } catch {
      report("resume-polling");
      return undefined;
    }
  };
  const applyPollingHealth = async (
    value: unknown,
    observationTime: string,
  ): Promise<TelegramGapWarning | undefined> => {
    if (closed) return undefined;
    const health = pollingHealth(value);
    if (health === undefined) return undefined;
    const state = await readState();
    if (closed || state === undefined) return cached;
    const reportedSuccessfulAt =
      health.lastSuccessfulPollAt !== null &&
      Date.parse(health.lastSuccessfulPollAt) <= Date.parse(observationTime)
        ? health.lastSuccessfulPollAt
        : null;
    const lastSuccessfulPollAt = laterTimestamp(state.lastSuccessfulPollAt, reportedSuccessfulAt);
    if (health.desiredState === "disabled") {
      return publishState({
        ...state,
        gapStartedAt: null,
        lastSuccessfulPollAt: null,
        warningDetectedAt: retainedWarning(state),
      });
    }
    if (health.state === "online") {
      const successfulAt = laterTimestamp(
        state.lastSuccessfulPollAt,
        reportedSuccessfulAt ?? observationTime,
      )!;
      return publishState({
        ...state,
        gapStartedAt: null,
        lastSuccessfulPollAt: successfulAt,
        warningDetectedAt: warnForGap(
          state,
          state.gapStartedAt ?? state.suspendedAt,
          successfulAt,
          observationTime,
        ),
      });
    }
    const gapStartedAt = state.gapStartedAt ?? lastSuccessfulPollAt ?? observationTime;
    return publishState({
      ...state,
      gapStartedAt,
      lastSuccessfulPollAt,
      warningDetectedAt: warnForGap(state, gapStartedAt, observationTime, observationTime),
    });
  };
  const refreshOpenGap = async (observationTime: string): Promise<TelegramGapWarning> => {
    if (closed) return cached;
    const state = await readState();
    if (closed || state === undefined) return cached;
    const warningDetectedAt = warnForGap(
      state,
      state.gapStartedAt,
      observationTime,
      observationTime,
    );
    if (warningDetectedAt === state.warningDetectedAt) {
      return publish(warningFor({ ...state, warningDetectedAt }));
    }
    return publishState({ ...state, warningDetectedAt });
  };
  const samplePollingHealth = async (): Promise<TelegramGapWarning> => {
    if (closed) return cached;
    const observationTime = observedAt();
    if (observationTime === undefined) return cached;
    let value: unknown;
    try {
      value = await input.controller.status();
    } catch {
      report("read-polling-status");
      return refreshOpenGap(observationTime);
    }
    if (closed) return cached;
    return (await applyPollingHealth(value, observationTime)) ?? refreshOpenGap(observationTime);
  };
  const finishGap = async (
    endedAt: string,
    detectNewWarning = true,
  ): Promise<TelegramGapWarning> => {
    if (closed) return cached;
    const state = await readState();
    if (closed || state === undefined) return cached;
    if (state.suspendedAt === null) {
      const warningDetectedAt = retainedWarning(state);
      return publish(warningFor({ ...state, warningDetectedAt }));
    }
    const warningDetectedAt = detectNewWarning
      ? warnForGap(state, state.suspendedAt, endedAt, endedAt)
      : retainedWarning(state);
    return publishState({
      ...state,
      gapStartedAt: state.gapStartedAt ?? state.suspendedAt,
      suspendedAt: null,
      warningDetectedAt,
    });
  };
  const recover = async (): Promise<TelegramGapWarning> => {
    if (closed) return cached;
    const state = await readState();
    if (closed || state === undefined) return cached;
    if (state.suspendedAt === null) return samplePollingHealth();
    const recoveredAt = observedAt();
    if (recoveredAt === undefined) return cached;
    await finishGap(recoveredAt, false);
    if (closed) return cached;
    await stopPolling();
    if (closed) return cached;
    const reconciled = await resumePolling();
    if (closed) return cached;
    return (await applyPollingHealth(reconciled, recoveredAt)) ?? refreshOpenGap(recoveredAt);
  };
  const onSuspend = (): void => {
    const suspendedAt = observedAt();
    if (suspendedAt === undefined) return;
    void serialize(async () => {
      if (closed) return;
      const state = await readState();
      if (closed) return;
      let stopIsAnchored = false;
      if (state !== undefined) {
        const next = {
          ...state,
          gapStartedAt: state.gapStartedAt ?? suspendedAt,
          suspendedAt: state.suspendedAt ?? suspendedAt,
          warningDetectedAt: retainedWarning(state),
        };
        const stored = await writeState(next);
        if (closed) return;
        stopIsAnchored = stored !== "not-committed";
        if (stored === "durably-committed") publish(warningFor(next));
      }
      if (stopIsAnchored) await stopPolling();
    });
  };
  const onResume = (): void => {
    const resumedAt = observedAt();
    if (resumedAt === undefined) return;
    void serialize(async () => {
      if (closed) return;
      await finishGap(resumedAt, false);
      if (closed) return;
      await stopPolling();
      if (closed) return;
      const reconciled = await resumePolling();
      if (closed) return;
      if ((await applyPollingHealth(reconciled, resumedAt)) === undefined) {
        if (closed) return;
        await refreshOpenGap(resumedAt);
      }
    });
  };
  return {
    start() {
      if (closed) return Promise.reject(new TypeError("Telegram power lifecycle is closed"));
      if (!started) {
        started = true;
        input.powerMonitor.on("suspend", onSuspend);
        input.powerMonitor.on("resume", onResume);
      }
      return serialize(recover);
    },
    warning() {
      if (closed) return Promise.resolve(cached);
      return serialize(samplePollingHealth);
    },
    resetForCreate() {
      if (closed) return Promise.resolve(cached);
      return serialize(async () => {
        if (closed) return cached;
        const result = await writeState(emptyState(athleteHome));
        if (closed || result !== "durably-committed") return cached;
        scopeMismatch = false;
        return publish(CLEAR_WARNING);
      });
    },
    acknowledgeWarning() {
      if (closed) return Promise.resolve(cached);
      return serialize(async () => {
        if (closed) return cached;
        const state = await readState();
        if (closed) return cached;
        if (state === undefined && scopeMismatch) return cached;
        const acknowledgedAt = observedAt();
        if (acknowledgedAt === undefined) return cached;
        const current = state ?? emptyState(athleteHome);
        const cleared = {
          ...current,
          gapStartedAt: current.gapStartedAt === null ? null : acknowledgedAt,
          suspendedAt: current.suspendedAt === null ? null : acknowledgedAt,
          warningDetectedAt: null,
        };
        const result = await writeState(cleared);
        if (closed || result !== "durably-committed") return cached;
        return publish(CLEAR_WARNING);
      });
    },
    close() {
      if (closePromise !== undefined) return closePromise;
      closed = true;
      if (started) {
        input.powerMonitor.off("suspend", onSuspend);
        input.powerMonitor.off("resume", onResume);
      }
      const queued = pending;
      closePromise = (async () => {
        await queued;
        if (transientStopOutstanding) await resumePolling(true);
      })();
      return closePromise;
    },
  };
}
