import {
  TelegramAllowedSendersMutationResultSchema,
  TelegramAllowedSendersResultSchema,
  TelegramControlMutationResultSchema,
  TelegramControlSnapshotSchema,
  TelegramCredentialInspectionSchema,
  type AthleteHomeIdentity,
  type TelegramAllowedSenderRpcParams,
  type TelegramAllowedSendersMutationResult,
  type TelegramAllowedSendersResult,
  type TelegramBotState,
  type TelegramChannelStatus,
  type TelegramControlMutationResult,
  type TelegramControlSnapshot,
  type TelegramCredentialInspection,
  type TelegramPairingState,
} from "@enduragent/coach-contract";
import type {
  TelegramCredentialVault,
  TelegramDesiredState,
  TelegramProfileRecord,
  TelegramProfileRePromptReason,
  TelegramProfileStatus,
} from "./telegram-credential-vault.js";
import type { SerializeCredentialMutation } from "./credential-envelope-lock.js";
import {
  emitTelegramSecureStorageFailure,
  type TelegramSecureStorageObserver,
  type TelegramSecureStorageReason,
} from "./telegram-secure-storage-diagnostics.js";

type EmptyRpcParams = Readonly<Record<string, never>>;

export const DESKTOP_TELEGRAM_CONTROL_ERROR_CODES = [
  "telegram-credential-storage-failed",
  "telegram-credential-encryption-unavailable",
  "telegram-credential-unsafe-backend",
  "telegram-credential-unavailable",
  "telegram-settings-storage-uncertain",
  "telegram-daemon-unavailable",
  "telegram-home-mismatch",
  "telegram-stale-operation",
  "telegram-control-failed",
  "telegram-drain-required",
] as const;

export type DesktopTelegramControlErrorCode = (typeof DESKTOP_TELEGRAM_CONTROL_ERROR_CODES)[number];

export type DesktopTelegramChannelStatus =
  | TelegramChannelStatus
  | Readonly<{ desiredState: "enabled"; state: "transfer-required" }>
  | Readonly<{
      desiredState: "disabled" | "enabled";
      state: "failed";
      errorCode: DesktopTelegramControlErrorCode;
    }>;

export interface DesktopTelegramSnapshot {
  readonly channel: DesktopTelegramChannelStatus;
  readonly bot: TelegramBotState;
  readonly pairing: TelegramPairingState;
  readonly credentialConfigured: boolean;
}

export type DesktopTelegramMutationRefusalReason =
  | "invalid-token"
  | "validation-unavailable"
  | "webhook-removal-required"
  | "encryption-unavailable"
  | "unsafe-backend"
  | "storage-failed"
  | "stale-operation"
  | "transfer-required"
  | "polling-conflict"
  | "control-unavailable"
  | "invalid-state";

export type DesktopTelegramMutationUncertaintyReason = "storage-uncertain" | "control-uncertain";

type DesktopTelegramSecureStorageRefusalReason = Extract<
  DesktopTelegramMutationRefusalReason,
  "encryption-unavailable" | "unsafe-backend"
>;

function isSecureStorageRefusal(
  reason: unknown,
): reason is DesktopTelegramSecureStorageRefusalReason {
  return reason === "encryption-unavailable" || reason === "unsafe-backend";
}

export type DesktopTelegramMutationResult =
  | Readonly<{ outcome: "applied"; current: DesktopTelegramSnapshot }>
  | Readonly<{
      outcome: "refused";
      reason: DesktopTelegramMutationRefusalReason;
      current: DesktopTelegramSnapshot;
    }>
  | Readonly<{
      outcome: "uncertain";
      reason: DesktopTelegramMutationUncertaintyReason;
      current: DesktopTelegramSnapshot;
    }>;

export interface TelegramDaemonBinding {
  readonly generation: number;
  readonly athleteHome: AthleteHomeIdentity;
  readonly supervision: "app-supervised" | "attached";
  configureTelegram(input: { readonly token: string }): Promise<unknown>;
  enableTelegram(input: EmptyRpcParams): Promise<unknown>;
  disableTelegram(input: EmptyRpcParams): Promise<unknown>;
  suspendTelegramPolling(input: EmptyRpcParams): Promise<unknown>;
  resumeTelegramPolling(input: EmptyRpcParams): Promise<unknown>;
  drainTelegram(input: EmptyRpcParams): Promise<unknown>;
  replaceTelegram(input: { readonly token: string }): Promise<unknown>;
  getTelegramStatus(input: EmptyRpcParams): Promise<unknown>;
  reconcileTelegram(input: EmptyRpcParams): Promise<unknown>;
  resetTelegramAccess(input: EmptyRpcParams): Promise<unknown>;
  inspectTelegramCredential(input: { readonly token: string }): Promise<unknown>;
  deleteTelegramWebhook(input: { readonly token: string }): Promise<unknown>;
  forgetTelegramCredential(input: EmptyRpcParams): Promise<unknown>;
  beginTelegramPairing(input: EmptyRpcParams): Promise<unknown>;
  cancelTelegramPairing(input: EmptyRpcParams): Promise<unknown>;
  listTelegramAllowedSenders(input: EmptyRpcParams): Promise<unknown>;
  addTelegramAllowedSender(input: TelegramAllowedSenderRpcParams): Promise<unknown>;
  removeTelegramAllowedSender(input: TelegramAllowedSenderRpcParams): Promise<unknown>;
}

export interface TelegramDaemonAuthorityPort {
  current(): TelegramDaemonBinding | undefined;
}

export interface TelegramControlCoordinator {
  configure(token: string): Promise<DesktopTelegramMutationResult>;
  replace(token: string): Promise<DesktopTelegramMutationResult>;
  enable(): Promise<DesktopTelegramMutationResult>;
  disable(): Promise<DesktopTelegramMutationResult>;
  stopPolling(): Promise<DesktopTelegramSnapshot>;
  resumePolling(): Promise<DesktopTelegramSnapshot>;
  remove(): Promise<DesktopTelegramMutationResult>;
  resetRuntimeForCredentialReset(): Promise<boolean>;
  removeWebhook(): Promise<DesktopTelegramMutationResult>;
  status(): Promise<DesktopTelegramSnapshot>;
  reconcile(): Promise<DesktopTelegramMutationResult>;
  beginPairing(): Promise<DesktopTelegramMutationResult>;
  cancelPairing(): Promise<DesktopTelegramMutationResult>;
  listAllowedSenders(): Promise<TelegramAllowedSendersResult>;
  addAllowedSender(
    input: TelegramAllowedSenderRpcParams,
  ): Promise<TelegramAllowedSendersMutationResult>;
  removeAllowedSender(
    input: TelegramAllowedSenderRpcParams,
  ): Promise<TelegramAllowedSendersMutationResult>;
  close(): Promise<void>;
}

export interface CreateTelegramControlCoordinatorInput {
  readonly selectedAthleteHome: () => AthleteHomeIdentity;
  readonly vault: Pick<
    TelegramCredentialVault,
    | "profileStatus"
    | "replaceProfile"
    | "applyStoredProfile"
    | "deleteProfile"
    | "desiredState"
    | "setDesiredState"
  >;
  readonly daemon: TelegramDaemonAuthorityPort;
  readonly observeSecureStorageFailure?: TelegramSecureStorageObserver;
  readonly serializeCredentialMutation?: SerializeCredentialMutation;
  readonly pairingLease?: {
    readonly now: () => number;
    readonly schedule: (callback: () => void, delayMs: number) => unknown;
    readonly cancel: (handle: unknown) => void;
  };
}

interface DesktopTelegramPairingLease {
  readonly binding: TelegramDaemonBinding;
  readonly generation: number;
  readonly athleteHome: AthleteHomeIdentity;
  readonly code: string;
  readonly expiresAt: string;
  handle: unknown;
}

const DISABLED_CHANNEL = Object.freeze({ desiredState: "disabled", state: "disabled" } as const);
const UNCONFIGURED_BOT = Object.freeze({ state: "unconfigured" } as const);
const UNPAIRED = Object.freeze({ state: "unpaired" } as const);
const emptySenders = (): TelegramAllowedSendersResult => ({ senders: [] });

type DesiredStateResolution =
  | Readonly<{ state: "known"; desiredState: "disabled" | "enabled" }>
  | Readonly<{
      state: "repair-required";
      desiredState: "disabled" | "enabled";
      errorCode: DesktopTelegramControlErrorCode;
    }>;

function resolveDesiredRecord(
  value: TelegramDesiredState,
  daemonSnapshot?: TelegramControlSnapshot,
): DesiredStateResolution {
  if (value.state === "configured") {
    return { state: "known", desiredState: value.enabled ? "enabled" : "disabled" };
  }
  if (value.state === "missing") return { state: "known", desiredState: "disabled" };
  const desiredState = daemonSnapshot?.channel.desiredState ?? "enabled";
  return {
    state: "repair-required",
    desiredState,
    errorCode:
      value.state === "wrong-home"
        ? "telegram-home-mismatch"
        : "telegram-settings-storage-uncertain",
  };
}

function failure(
  desiredState: "disabled" | "enabled",
  errorCode: DesktopTelegramControlErrorCode,
  credentialConfigured = false,
  bot: TelegramBotState = UNCONFIGURED_BOT,
  pairing: TelegramPairingState = UNPAIRED,
): DesktopTelegramSnapshot {
  return {
    channel: { desiredState, state: "failed", errorCode },
    bot,
    pairing,
    credentialConfigured,
  };
}

function parseSnapshot(value: unknown): TelegramControlSnapshot | undefined {
  const parsed = TelegramControlSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function parseMutation(value: unknown): TelegramControlMutationResult | undefined {
  const parsed = TelegramControlMutationResultSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function parseSenderMutation(value: unknown): TelegramAllowedSendersMutationResult | undefined {
  const parsed = TelegramAllowedSendersMutationResultSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function parseInspection(value: unknown): TelegramCredentialInspection | undefined {
  const parsed = TelegramCredentialInspectionSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function profileBot(
  profile: Extract<TelegramProfileStatus, { state: "configured" }>,
  daemonBot?: TelegramBotState,
): TelegramBotState {
  if (daemonBot?.state === "webhook-removal-required") {
    return { state: "webhook-removal-required", username: profile.bot.username };
  }
  return { state: "ready", username: profile.bot.username };
}

function profileStatusErrorCode(
  reason: TelegramProfileRePromptReason,
): DesktopTelegramControlErrorCode {
  if (reason === "encryption-unavailable") {
    return "telegram-credential-encryption-unavailable";
  }
  if (reason === "unsafe-backend") return "telegram-credential-unsafe-backend";
  return "telegram-credential-unavailable";
}

function configuredSnapshot(
  profile: Extract<TelegramProfileStatus, { state: "configured" }>,
  daemonSnapshot: TelegramControlSnapshot,
  desiredState: "disabled" | "enabled",
): DesktopTelegramSnapshot {
  return {
    channel: desiredState === "disabled" ? DISABLED_CHANNEL : daemonSnapshot.channel,
    bot: profileBot(profile, daemonSnapshot.bot),
    pairing: daemonSnapshot.pairing,
    credentialConfigured: true,
  };
}

function isPollingCapable(snapshot: TelegramControlSnapshot): boolean {
  return (
    snapshot.channel.desiredState === "enabled" &&
    (snapshot.channel.state === "starting" ||
      snapshot.channel.state === "online" ||
      snapshot.channel.state === "offline-retrying")
  );
}

function isEnabledRuntimeCoherent(snapshot: TelegramControlSnapshot): boolean {
  return isPollingCapable(snapshot) || snapshot.channel.state === "suspended";
}

function isReadyForProfile(
  snapshot: TelegramControlSnapshot,
  profile: Pick<TelegramProfileRecord, "bot">,
): boolean {
  return (
    snapshot.bot.state === "ready" &&
    snapshot.bot.username === profile.bot.username &&
    !(snapshot.channel.desiredState === "disabled" && snapshot.channel.state !== "disabled")
  );
}

function matchesDesired(snapshot: TelegramControlSnapshot, enabled: boolean): boolean {
  return (snapshot.channel.desiredState === "enabled") === enabled;
}

function reconciliationFailureSnapshot(
  result: Exclude<DesktopTelegramMutationResult, { readonly outcome: "applied" }>,
): DesktopTelegramSnapshot {
  const current = result.current;
  if (
    current.channel.state === "failed" ||
    current.channel.state === "conflict" ||
    current.channel.state === "invalid-token" ||
    current.channel.state === "transfer-required" ||
    (result.outcome === "refused" &&
      result.reason === "invalid-state" &&
      current.channel.state === "waiting-for-credential")
  ) {
    return current;
  }
  const errorCode =
    result.outcome === "refused" && isSecureStorageRefusal(result.reason)
      ? profileStatusErrorCode(result.reason)
      : result.outcome === "uncertain" && result.reason === "storage-uncertain"
        ? "telegram-settings-storage-uncertain"
        : "telegram-control-failed";
  return failure(
    current.channel.desiredState,
    errorCode,
    current.credentialConfigured,
    current.bot,
    current.pairing,
  );
}

export function createTelegramControlCoordinator(
  input: CreateTelegramControlCoordinatorInput,
): TelegramControlCoordinator {
  const serializeCredentialMutation: SerializeCredentialMutation =
    input.serializeCredentialMutation ?? ((operation) => operation());
  let pending: Promise<void> = Promise.resolve();
  let accepting = true;
  let closePromise: Promise<void> | undefined;
  let transientSuspension: TelegramDaemonBinding | undefined;
  let reconciliationFailure:
    | {
        readonly binding: TelegramDaemonBinding | undefined;
        readonly current: DesktopTelegramSnapshot;
      }
    | undefined;
  const leaseClock =
    input.pairingLease ??
    ({
      now: () => Date.now(),
      schedule: (callback, delayMs) => {
        const handle = setTimeout(callback, delayMs);
        handle.unref();
        return handle;
      },
      cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    } as const);
  let pairingLease: DesktopTelegramPairingLease | undefined;

  const observeDaemonApplyFailure = (reason: TelegramSecureStorageReason): void => {
    emitTelegramSecureStorageFailure(input.observeSecureStorageFailure, {
      stage: "daemon-apply",
      reason,
    });
  };

  const profileStatusRefusal = (
    profileStatus: TelegramProfileStatus,
  ): TelegramProfileRePromptReason | undefined => {
    if (profileStatus.state !== "re-prompt") return undefined;
    return profileStatus.reason;
  };

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    if (!accepting) return Promise.reject(new TypeError());
    const result = pending.then(operation, operation);
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const binding = (): TelegramDaemonBinding | undefined => {
    const selectedHome = input.selectedAthleteHome();
    const current = input.daemon.current();
    return current?.athleteHome === selectedHome ? current : undefined;
  };

  const isCurrent = (expected: TelegramDaemonBinding): boolean => {
    const current = input.daemon.current();
    return (
      current === expected &&
      current.generation === expected.generation &&
      current.athleteHome === input.selectedAthleteHome()
    );
  };

  const resolveDesired = async (
    daemonSnapshot?: TelegramControlSnapshot,
  ): Promise<DesiredStateResolution> =>
    resolveDesiredRecord(await input.vault.desiredState(), daemonSnapshot);

  const readDesired = async (): Promise<"disabled" | "enabled"> => {
    const resolved = await resolveDesired();
    if (resolved.state === "repair-required") throw new TypeError();
    return resolved.desiredState;
  };

  const failureForDesired = async (
    fallbackError: DesktopTelegramControlErrorCode,
    daemonSnapshot?: TelegramControlSnapshot,
  ): Promise<DesktopTelegramSnapshot> => {
    const resolved = await resolveDesired(daemonSnapshot);
    return failure(
      resolved.desiredState,
      resolved.state === "repair-required" ? resolved.errorCode : fallbackError,
    );
  };

  const project = async (
    daemonSnapshot?: TelegramControlSnapshot,
    expectedBinding?: TelegramDaemonBinding,
    resolvedDesired?: DesiredStateResolution,
  ): Promise<DesktopTelegramSnapshot> => {
    const [desired, profile] = await Promise.all([
      resolvedDesired === undefined ? resolveDesired(daemonSnapshot) : resolvedDesired,
      input.vault.profileStatus(),
    ]);
    if (expectedBinding !== undefined && !isCurrent(expectedBinding)) {
      throw new TypeError("stale Telegram daemon projection");
    }
    const desiredState = desired.desiredState;
    if (desired.state === "repair-required") {
      const configured = profile.state === "configured";
      return failure(
        desiredState,
        desired.errorCode,
        configured,
        configured ? profileBot(profile, daemonSnapshot?.bot) : UNCONFIGURED_BOT,
        daemonSnapshot?.pairing ?? UNPAIRED,
      );
    }
    if (profile.state === "wrong-home") return failure(desiredState, "telegram-home-mismatch");
    if (profile.state === "re-prompt") {
      return failure(
        desiredState,
        profileStatusErrorCode(profile.reason),
        true,
        daemonSnapshot?.bot ?? UNCONFIGURED_BOT,
        daemonSnapshot?.pairing ?? UNPAIRED,
      );
    }
    if (profile.state === "uncertain") {
      return failure(desiredState, "telegram-credential-unavailable");
    }
    if (profile.state !== "configured") {
      return {
        channel:
          desiredState === "enabled"
            ? { desiredState: "enabled", state: "waiting-for-credential" }
            : DISABLED_CHANNEL,
        bot: UNCONFIGURED_BOT,
        pairing: UNPAIRED,
        credentialConfigured: false,
      };
    }
    const bot = profileBot(profile, daemonSnapshot?.bot);
    const pairing = daemonSnapshot?.pairing ?? UNPAIRED;
    const active = expectedBinding ?? binding();
    if (active === undefined) {
      return failure(desiredState, "telegram-daemon-unavailable", true, bot, pairing);
    }
    if (desiredState === "enabled" && active.supervision === "attached") {
      return {
        channel: { desiredState: "enabled", state: "transfer-required" },
        bot,
        pairing,
        credentialConfigured: true,
      };
    }
    return {
      channel:
        desiredState === "disabled"
          ? DISABLED_CHANNEL
          : (daemonSnapshot?.channel ?? {
              desiredState: "enabled",
              state: "failed",
              errorCode: "telegram-control-failed",
            }),
      bot,
      pairing,
      credentialConfigured: true,
    };
  };

  const currentSnapshot = async (): Promise<DesktopTelegramSnapshot> => {
    const active = binding();
    if (active === undefined) return project();
    if (!isCurrent(active)) return failureForDesired("telegram-stale-operation");
    const response = await active.getTelegramStatus({});
    if (!isCurrent(active)) return failureForDesired("telegram-stale-operation");
    const parsed = parseSnapshot(response);
    return parsed === undefined
      ? failureForDesired("telegram-control-failed")
      : project(parsed, active);
  };

  const safeCurrent = async (): Promise<DesktopTelegramSnapshot> => {
    try {
      return await currentSnapshot();
    } catch {
      try {
        return await project();
      } catch {
        return failure("enabled", "telegram-control-failed");
      }
    }
  };

  const runSnapshot = (
    operation: () => Promise<DesktopTelegramSnapshot>,
  ): Promise<DesktopTelegramSnapshot> =>
    serialize(async () => {
      try {
        return await operation();
      } catch {
        return safeCurrent();
      }
    });

  const refused = async (
    reason: DesktopTelegramMutationRefusalReason,
    current?: DesktopTelegramSnapshot,
  ): Promise<DesktopTelegramMutationResult> => ({
    outcome: "refused",
    reason,
    current: current ?? (await safeCurrent()),
  });

  const uncertain = async (
    reason: DesktopTelegramMutationUncertaintyReason = "storage-uncertain",
  ): Promise<DesktopTelegramMutationResult> => ({
    outcome: "uncertain",
    reason,
    current: await safeCurrent(),
  });

  const applied = async (
    current?: DesktopTelegramSnapshot,
  ): Promise<DesktopTelegramMutationResult> => ({
    outcome: "applied",
    current: current ?? (await safeCurrent()),
  });

  const runMutation = (
    operation: () => Promise<DesktopTelegramMutationResult>,
  ): Promise<DesktopTelegramMutationResult> =>
    serializeCredentialMutation(() =>
      serialize(async () => {
        try {
          const result = await operation();
          if (result.outcome === "applied") reconciliationFailure = undefined;
          return result;
        } catch {
          return uncertain("control-uncertain");
        }
      }),
    );

  const rememberReconciliation = (
    result: DesktopTelegramMutationResult,
  ): DesktopTelegramMutationResult => {
    if (result.outcome === "applied") {
      reconciliationFailure = undefined;
      return result;
    }
    const current = reconciliationFailureSnapshot(result);
    reconciliationFailure = { binding: binding(), current };
    return { ...result, current };
  };

  const reconcileMutation = (
    operation: () => Promise<DesktopTelegramMutationResult>,
  ): Promise<DesktopTelegramMutationResult> => runMutation(operation).then(rememberReconciliation);

  const checkedBinding = async (): Promise<
    | { readonly active: TelegramDaemonBinding; readonly desiredState: "disabled" | "enabled" }
    | { readonly result: DesktopTelegramMutationResult }
  > => {
    const desired = await resolveDesired();
    if (desired.state === "repair-required") return { result: await uncertain() };
    const desiredState = desired.desiredState;
    const active = binding();
    return active === undefined
      ? { result: await refused("control-unavailable") }
      : { active, desiredState };
  };

  const guardedSnapshotCall = async (
    active: TelegramDaemonBinding,
    invoke: () => Promise<unknown>,
  ): Promise<TelegramControlSnapshot | undefined> => {
    if (!isCurrent(active)) return undefined;
    let response: unknown;
    try {
      response = await invoke();
    } catch {
      return undefined;
    }
    if (!isCurrent(active)) return undefined;
    return parseSnapshot(response);
  };

  const resumeSuspensionLease = async (
    active: TelegramDaemonBinding,
  ): Promise<TelegramControlSnapshot | undefined> => {
    const resumed = await guardedSnapshotCall(active, () => active.resumeTelegramPolling({}));
    return resumed?.channel.state === "suspended" ? undefined : resumed;
  };

  const inspect = async (
    active: TelegramDaemonBinding,
    token: string,
  ): Promise<TelegramCredentialInspection | "stale" | "unavailable"> => {
    if (!isCurrent(active)) return "stale";
    let response: unknown;
    try {
      response = await active.inspectTelegramCredential({ token });
    } catch {
      return "unavailable";
    }
    if (!isCurrent(active)) return "stale";
    return parseInspection(response) ?? "unavailable";
  };

  const inspectionRefusal = async (
    inspection: TelegramCredentialInspection | "stale" | "unavailable",
  ): Promise<DesktopTelegramMutationResult | undefined> => {
    if (inspection === "stale") return refused("stale-operation");
    if (inspection === "unavailable" || inspection.status === "unavailable") {
      return refused("validation-unavailable");
    }
    if (inspection.status === "invalid-token") return refused("invalid-token");
    return undefined;
  };

  const captureProfile = async (
    active: TelegramDaemonBinding,
  ): Promise<
    | { readonly state: "configured"; readonly profile: TelegramProfileRecord }
    | { readonly state: "missing" | "uncertain" }
    | {
        readonly state: "refused";
        readonly reason: "encryption-unavailable" | "unsafe-backend" | "storage-failed";
      }
  > => {
    let captured: TelegramProfileRecord | undefined;
    const result = await input.vault.applyStoredProfile(active.athleteHome, async (profile) => {
      captured = profile;
    });
    if (result.outcome === "uncertain") return { state: "uncertain" };
    if (result.outcome === "refused") {
      if (result.reason === "missing") return { state: "missing" };
      const reason = isSecureStorageRefusal(result.reason) ? result.reason : "storage-failed";
      return {
        state: "refused",
        reason,
      };
    }
    if (captured !== undefined) return { state: "configured", profile: captured };
    return { state: "refused", reason: "storage-failed" };
  };

  const replaceProfile = async (
    active: TelegramDaemonBinding,
    token: string,
    bot: TelegramProfileRecord["bot"],
  ): Promise<
    "applied" | "encryption-unavailable" | "unsafe-backend" | "storage-failed" | "uncertain"
  > => {
    try {
      const result = await input.vault.replaceProfile({
        token,
        bot,
        authenticatedAthleteHome: active.athleteHome,
      });
      if (result.outcome !== "refused") return result.outcome;
      const reason = isSecureStorageRefusal(result.reason) ? result.reason : "storage-failed";
      return reason;
    } catch {
      return "uncertain";
    }
  };

  const restoreProfile = async (
    active: TelegramDaemonBinding,
    prior: TelegramProfileRecord | undefined,
  ): Promise<"restored" | "uncertain"> => {
    try {
      if (prior === undefined) {
        const deleted = await input.vault.deleteProfile();
        return deleted.outcome === "applied" ||
          (deleted.outcome === "refused" && deleted.reason === "not-found")
          ? "restored"
          : "uncertain";
      }
      const restored = await input.vault.replaceProfile({
        token: prior.token,
        bot: prior.bot,
        authenticatedAthleteHome: active.athleteHome,
      });
      return restored.outcome === "applied" ? "restored" : "uncertain";
    } catch {
      return "uncertain";
    }
  };

  const restoreDesired = async (enabled: boolean): Promise<"restored" | "uncertain"> => {
    try {
      const restored = await input.vault.setDesiredState(enabled);
      return restored.status === "stored" ? "restored" : "uncertain";
    } catch {
      return "uncertain";
    }
  };

  const compensate = async (
    active: TelegramDaemonBinding,
    priorProfile: TelegramProfileRecord | undefined,
    priorDesired: boolean,
    restoreDesiredState: boolean,
  ): Promise<"restored" | "uncertain"> => {
    const desiredResult = restoreDesiredState ? await restoreDesired(priorDesired) : "restored";
    const profileResult = await restoreProfile(active, priorProfile);
    return desiredResult === "restored" && profileResult === "restored" ? "restored" : "uncertain";
  };

  const mapDaemonRefusal = (
    reason: Extract<TelegramControlMutationResult, { outcome: "refused" }>["reason"],
  ): DesktopTelegramMutationRefusalReason =>
    reason === "release-refused" ? "control-unavailable" : reason;

  const persistDesired = async (enabled: boolean): Promise<"applied" | "refused" | "uncertain"> => {
    try {
      const result = await input.vault.setDesiredState(enabled);
      return result.status === "stored"
        ? "applied"
        : result.status === "uncertain"
          ? "uncertain"
          : "refused";
    } catch {
      return "uncertain";
    }
  };

  const persistPairingDesired = async (
    active: TelegramDaemonBinding,
    enabled: boolean,
  ): Promise<"applied" | "refused" | "stale" | "uncertain"> => {
    if (!isCurrent(active)) return "stale";
    let priorDesired: boolean;
    try {
      priorDesired = (await readDesired()) === "enabled";
    } catch {
      return "uncertain";
    }
    if (!isCurrent(active)) return "stale";
    const stored = await persistDesired(enabled);
    if (isCurrent(active)) return stored;
    if (stored !== "refused" && (await restoreDesired(priorDesired)) !== "restored") {
      return "uncertain";
    }
    return "stale";
  };

  const restoreDaemonProfile = async (
    active: TelegramDaemonBinding,
    token: string,
  ): Promise<TelegramControlSnapshot | undefined> => {
    if (!isCurrent(active)) return undefined;
    try {
      const restored = parseMutation(await active.replaceTelegram({ token }));
      return isCurrent(active) && restored?.outcome === "applied" ? restored.current : undefined;
    } catch {
      return undefined;
    }
  };

  const clearInitialDaemonProfile = async (
    active: TelegramDaemonBinding,
  ): Promise<TelegramControlSnapshot | undefined> => {
    const forgotten = await guardedSnapshotCall(active, () => active.forgetTelegramCredential({}));
    return forgotten?.bot.state === "unconfigured" ? forgotten : undefined;
  };

  const configureCandidate = (
    token: string,
    replacement: boolean,
  ): Promise<DesktopTelegramMutationResult> =>
    runMutation(async () => {
      const checked = await checkedBinding();
      if ("result" in checked) return checked.result;
      const profileStatus = await input.vault.profileStatus();
      const profileRefusal = profileStatusRefusal(profileStatus);
      if (profileRefusal !== undefined) return refused(profileRefusal);
      if (profileStatus.state === "uncertain") return uncertain();
      if (profileStatus.state === "wrong-home") return refused("storage-failed");
      if (replacement && profileStatus.state !== "configured") return refused("invalid-state");
      if (!replacement && profileStatus.state === "configured") return refused("invalid-state");
      const prior = replacement ? await captureProfile(checked.active) : undefined;
      if (replacement && prior?.state === "uncertain") return uncertain();
      if (replacement && prior?.state === "refused") return refused(prior.reason);
      if (replacement && prior?.state !== "configured") return refused("storage-failed");
      const priorProfile = prior?.state === "configured" ? prior.profile : undefined;
      const inspection = await inspect(checked.active, token);
      const preflightRefusal = await inspectionRefusal(inspection);
      if (preflightRefusal !== undefined) return preflightRefusal;
      if (typeof inspection === "string") return refused("validation-unavailable");
      if (replacement && inspection.status === "webhook-removal-required") {
        return refused("webhook-removal-required");
      }

      if (inspection.status !== "ready" && inspection.status !== "webhook-removal-required") {
        return refused("validation-unavailable");
      }
      const priorDesired = checked.desiredState === "enabled";
      const differentBot = priorProfile !== undefined && priorProfile.bot.id !== inspection.bot.id;

      if (inspection.status === "webhook-removal-required") {
        const stored = await replaceProfile(checked.active, token, inspection.bot);
        if (stored === "uncertain") return uncertain();
        if (stored !== "applied") return refused(stored);
        const desiredWrite = await persistDesired(false);
        if (desiredWrite !== "applied") {
          const restored = await compensate(
            checked.active,
            priorProfile,
            priorDesired,
            desiredWrite === "uncertain",
          );
          return restored === "uncertain" ? uncertain() : refused("storage-failed");
        }
        return refused("webhook-removal-required", {
          channel: DISABLED_CHANNEL,
          bot: { state: "webhook-removal-required", username: inspection.bot.username },
          pairing: UNPAIRED,
          credentialConfigured: true,
        });
      }
      if (replacement && checked.active.supervision === "attached") {
        return refused("transfer-required");
      }
      if (replacement) {
        if (profileStatus.state !== "configured") return refused("invalid-state");
        const before = await guardedSnapshotCall(checked.active, () =>
          checked.active.getTelegramStatus({}),
        );
        if (before === undefined) return refused("stale-operation");
        const preMutationCurrent = configuredSnapshot(profileStatus, before, checked.desiredState);
        const wasSuspended =
          before.channel.state === "suspended" || transientSuspension === checked.active;
        let rawSuspended: unknown;
        try {
          rawSuspended = await checked.active.suspendTelegramPolling({});
        } catch {
          const restored = wasSuspended ? before : await resumeSuspensionLease(checked.active);
          return restored === undefined
            ? uncertain("control-uncertain")
            : refused("control-unavailable");
        }
        if (!isCurrent(checked.active)) return uncertain("control-uncertain");
        const suspended = parseSnapshot(rawSuspended);
        if (suspended === undefined) {
          const restored = wasSuspended ? before : await resumeSuspensionLease(checked.active);
          return restored === undefined
            ? uncertain("control-uncertain")
            : refused("control-unavailable");
        }
        const suspensionLease = {
          owned: !wasSuspended,
          release: (): Promise<TelegramControlSnapshot | undefined> =>
            wasSuspended
              ? guardedSnapshotCall(checked.active, () => checked.active.getTelegramStatus({}))
              : resumeSuspensionLease(checked.active),
        } as const;
        const drained = await guardedSnapshotCall(checked.active, () =>
          checked.active.drainTelegram({}),
        );
        if (drained === undefined) {
          const restored = await suspensionLease.release();
          return restored === undefined
            ? uncertain("control-uncertain")
            : refused("control-unavailable");
        }

        let desiredChanged = false;
        if (differentBot) {
          const desiredWrite = await persistDesired(false);
          if (desiredWrite !== "applied") {
            const restored =
              desiredWrite === "uncertain" ? await restoreDesired(priorDesired) : "restored";
            const resumed = await suspensionLease.release();
            if (restored === "uncertain") return uncertain();
            return resumed === undefined
              ? uncertain("control-uncertain")
              : refused("storage-failed");
          }
          desiredChanged = true;
        }

        if (!isCurrent(checked.active)) {
          if (desiredChanged) await restoreDesired(priorDesired);
          await suspensionLease.release();
          return uncertain("control-uncertain");
        }

        const stored = await replaceProfile(checked.active, token, inspection.bot);
        if (stored !== "applied") {
          const desiredRestored = desiredChanged ? await restoreDesired(priorDesired) : "restored";
          const resumed = await suspensionLease.release();
          if (stored === "uncertain" || desiredRestored === "uncertain") return uncertain();
          return resumed === undefined
            ? uncertain("control-uncertain")
            : refused(stored, preMutationCurrent);
        }
        if (!isCurrent(checked.active)) {
          await compensate(checked.active, priorProfile, priorDesired, desiredChanged);
          await suspensionLease.release();
          return uncertain("control-uncertain");
        }

        let rawMutation: unknown;
        try {
          rawMutation = await checked.active.replaceTelegram({ token });
        } catch {
          observeDaemonApplyFailure("control-uncertain");
          const daemonRestored = await restoreDaemonProfile(checked.active, priorProfile!.token);
          const restored = await compensate(
            checked.active,
            priorProfile,
            priorDesired,
            desiredChanged,
          );
          const resumed = await suspensionLease.release();
          return !differentBot &&
            daemonRestored !== undefined &&
            restored === "restored" &&
            resumed !== undefined
            ? refused("control-unavailable")
            : uncertain("control-uncertain");
        }
        if (!isCurrent(checked.active)) {
          observeDaemonApplyFailure("control-uncertain");
          await compensate(checked.active, priorProfile, priorDesired, desiredChanged);
          return uncertain("control-uncertain");
        }
        const mutation = parseMutation(rawMutation);
        if (mutation === undefined) {
          observeDaemonApplyFailure("control-uncertain");
          const daemonRestored = await restoreDaemonProfile(checked.active, priorProfile!.token);
          const restored = await compensate(
            checked.active,
            priorProfile,
            priorDesired,
            desiredChanged,
          );
          const resumed = await suspensionLease.release();
          return !differentBot &&
            daemonRestored !== undefined &&
            restored === "restored" &&
            resumed !== undefined
            ? refused("control-unavailable")
            : uncertain("control-uncertain");
        }
        if (mutation.outcome === "refused") {
          observeDaemonApplyFailure("control-unavailable");
          const restored = await compensate(
            checked.active,
            priorProfile,
            priorDesired,
            desiredChanged,
          );
          const resumed = await suspensionLease.release();
          if (restored === "uncertain") return uncertain();
          if (resumed === undefined) return uncertain("control-uncertain");
          return refused(
            mapDaemonRefusal(mutation.reason),
            await project(mutation.current, checked.active),
          );
        }
        if (!isReadyForProfile(mutation.current, { bot: inspection.bot })) {
          observeDaemonApplyFailure("control-uncertain");
          const daemonRestored = await restoreDaemonProfile(checked.active, priorProfile!.token);
          const restored = await compensate(
            checked.active,
            priorProfile,
            priorDesired,
            desiredChanged,
          );
          const resumed = await suspensionLease.release();
          return !differentBot &&
            daemonRestored !== undefined &&
            restored === "restored" &&
            resumed !== undefined
            ? refused("invalid-state")
            : uncertain("control-uncertain");
        }

        let final: TelegramControlSnapshot | undefined;
        if (differentBot) {
          const disabled = await guardedSnapshotCall(checked.active, () =>
            checked.active.disableTelegram({}),
          );
          const released = suspensionLease.owned ? await suspensionLease.release() : disabled;
          final = disabled === undefined || released === undefined ? undefined : released;
        } else {
          final = await suspensionLease.release();
        }
        if (
          final === undefined ||
          !isReadyForProfile(final, { bot: inspection.bot }) ||
          !matchesDesired(final, differentBot ? false : priorDesired)
        ) {
          observeDaemonApplyFailure("control-uncertain");
          return uncertain("control-uncertain");
        }
        return applied(await project(final, checked.active));
      }
      const stored = await replaceProfile(checked.active, token, inspection.bot);
      if (stored === "uncertain") return uncertain();
      if (stored !== "applied") return refused(stored);
      const desiredWrite = await persistDesired(false);
      if (desiredWrite !== "applied") {
        const restored = await compensate(
          checked.active,
          undefined,
          priorDesired,
          desiredWrite === "uncertain",
        );
        return restored === "uncertain" ? uncertain() : refused("storage-failed");
      }
      if (!isCurrent(checked.active)) {
        await compensate(checked.active, undefined, priorDesired, true);
        return uncertain("control-uncertain");
      }
      let rawMutation: unknown;
      try {
        rawMutation = await checked.active.configureTelegram({ token });
      } catch {
        observeDaemonApplyFailure("control-uncertain");
        const daemonCleared = await clearInitialDaemonProfile(checked.active);
        const restored = await compensate(checked.active, undefined, priorDesired, true);
        return daemonCleared !== undefined && restored === "restored"
          ? refused("control-unavailable")
          : uncertain("control-uncertain");
      }
      if (!isCurrent(checked.active)) {
        observeDaemonApplyFailure("control-uncertain");
        await compensate(checked.active, undefined, priorDesired, true);
        return uncertain("control-uncertain");
      }
      const mutation = parseMutation(rawMutation);
      if (mutation === undefined) {
        observeDaemonApplyFailure("control-uncertain");
        const daemonCleared = await clearInitialDaemonProfile(checked.active);
        const restored = await compensate(checked.active, undefined, priorDesired, true);
        return daemonCleared !== undefined && restored === "restored"
          ? refused("control-unavailable")
          : uncertain("control-uncertain");
      }
      if (mutation.outcome === "refused") {
        observeDaemonApplyFailure("control-unavailable");
        const restored = await compensate(checked.active, undefined, priorDesired, true);
        return restored === "restored"
          ? refused(
              mapDaemonRefusal(mutation.reason),
              await project(mutation.current, checked.active),
            )
          : uncertain();
      }
      if (
        !isReadyForProfile(mutation.current, { bot: inspection.bot }) ||
        !matchesDesired(mutation.current, false)
      ) {
        observeDaemonApplyFailure("control-uncertain");
        const daemonCleared = await clearInitialDaemonProfile(checked.active);
        const restored = await compensate(checked.active, undefined, priorDesired, true);
        return daemonCleared !== undefined && restored === "restored"
          ? refused("invalid-state")
          : uncertain("control-uncertain");
      }
      return applied(await project(mutation.current, checked.active));
    });

  const mutateDesired = (
    next: boolean,
    invoke: (active: TelegramDaemonBinding) => Promise<unknown>,
  ): Promise<DesktopTelegramMutationResult> =>
    runMutation(async () => {
      const checked = await checkedBinding();
      if ("result" in checked) return checked.result;
      const profileStatus = await input.vault.profileStatus();
      if (next && profileStatus.state !== "configured") {
        const profileRefusal = profileStatusRefusal(profileStatus);
        if (profileRefusal !== undefined) return refused(profileRefusal);
        return profileStatus.state === "uncertain" ? uncertain() : refused("invalid-state");
      }
      if (checked.active.supervision === "attached" && next) {
        return refused("transfer-required", await project());
      }
      const previous = checked.desiredState === "enabled";
      const stored = await persistDesired(next);
      if (stored === "uncertain") {
        return (await restoreDesired(previous)) === "restored"
          ? refused("storage-failed")
          : uncertain();
      }
      if (stored === "refused") return refused("storage-failed");
      const response = await guardedSnapshotCall(checked.active, () => invoke(checked.active));
      if (response === undefined) {
        observeDaemonApplyFailure("control-uncertain");
        await restoreDesired(previous);
        return uncertain("control-uncertain");
      }
      const responseDesired = response.channel.desiredState === "enabled";
      if (responseDesired !== next) {
        observeDaemonApplyFailure("control-uncertain");
        const desiredRestored = await restoreDesired(previous);
        if (desiredRestored === "uncertain" || previous === next) {
          return uncertain("control-uncertain");
        }
        return refused("invalid-state");
      }
      if (next && response.channel.state === "conflict") {
        observeDaemonApplyFailure("control-unavailable");
        if (previous) {
          return refused("polling-conflict", await project(response, checked.active));
        }
        const desiredRestored = await restoreDesired(false);
        const disabled = await guardedSnapshotCall(checked.active, () =>
          checked.active.disableTelegram({}),
        );
        if (desiredRestored === "uncertain") return uncertain();
        if (disabled?.channel.state !== "disabled") return uncertain("control-uncertain");
        return refused("polling-conflict", await project(disabled, checked.active));
      }
      if (!next && response.channel.state === "disabled") clearPairingLease();
      return applied(await project(response, checked.active));
    });

  const loadStoredProfile = async (
    active: TelegramDaemonBinding,
    daemonSnapshot: TelegramControlSnapshot,
  ): Promise<
    | { readonly outcome: "applied"; readonly current: TelegramControlSnapshot }
    | { readonly outcome: "refused"; readonly reason: DesktopTelegramMutationRefusalReason }
    | {
        readonly outcome: "uncertain";
        readonly reason: DesktopTelegramMutationUncertaintyReason;
      }
  > => {
    let mutation: TelegramControlMutationResult | undefined;
    let expectedProfile: TelegramProfileRecord | undefined;
    const loaded = await input.vault.applyStoredProfile(active.athleteHome, async (profile) => {
      expectedProfile = profile;
      if (!isCurrent(active)) throw new TypeError();
      const response =
        daemonSnapshot.bot.state === "unconfigured"
          ? await active.configureTelegram({ token: profile.token })
          : await active.replaceTelegram({ token: profile.token });
      mutation = parseMutation(response);
      if (mutation === undefined || !isCurrent(active)) throw new TypeError();
    });
    if (loaded.outcome === "uncertain") {
      return { outcome: "uncertain", reason: "storage-uncertain" };
    }
    if (loaded.outcome === "refused") {
      if (loaded.reason === "runtime-unavailable") {
        observeDaemonApplyFailure("control-uncertain");
        return { outcome: "uncertain", reason: "control-uncertain" };
      }
      if (isSecureStorageRefusal(loaded.reason)) {
        return { outcome: "refused", reason: loaded.reason };
      }
      return {
        outcome: "refused",
        reason:
          loaded.reason === "missing"
            ? "invalid-state"
            : loaded.reason === "re-prompt"
              ? "storage-failed"
              : "control-unavailable",
      };
    }
    if (mutation === undefined) {
      observeDaemonApplyFailure("control-unavailable");
      return { outcome: "refused", reason: "control-unavailable" };
    }
    if (mutation.outcome === "refused") {
      observeDaemonApplyFailure("control-unavailable");
      return { outcome: "refused", reason: mapDaemonRefusal(mutation.reason) };
    }
    if (expectedProfile === undefined || !isReadyForProfile(mutation.current, expectedProfile)) {
      observeDaemonApplyFailure("control-uncertain");
      return { outcome: "uncertain", reason: "control-uncertain" };
    }
    return { outcome: "applied", current: mutation.current };
  };

  const powerProjection = (
    desiredState: "disabled" | "enabled",
    daemonSnapshot: TelegramControlSnapshot,
  ): DesktopTelegramSnapshot => ({
    channel: desiredState === "disabled" ? DISABLED_CHANNEL : daemonSnapshot.channel,
    bot: daemonSnapshot.bot,
    pairing: daemonSnapshot.pairing,
    credentialConfigured: daemonSnapshot.bot.state !== "unconfigured",
  });

  const transientPolling = (
    operation: "suspend" | "resume",
    invoke: (active: TelegramDaemonBinding) => Promise<unknown>,
  ): Promise<DesktopTelegramSnapshot> =>
    serialize(async () => {
      let desired: DesiredStateResolution;
      try {
        desired = await resolveDesired();
      } catch {
        return failure("enabled", "telegram-control-failed");
      }
      if (desired.state === "repair-required") {
        return failure(desired.desiredState, desired.errorCode);
      }
      const desiredState = desired.desiredState;
      const current = input.daemon.current();
      if (current === undefined) return failure(desiredState, "telegram-daemon-unavailable");
      if (current.athleteHome !== input.selectedAthleteHome()) {
        return failure(desiredState, "telegram-stale-operation");
      }
      const active = current;
      if (!isCurrent(active)) return failure(desiredState, "telegram-stale-operation");
      if (operation === "suspend") transientSuspension = active;
      let response: unknown;
      try {
        response = await invoke(active);
      } catch {
        return failure(desiredState, "telegram-control-failed");
      }
      if (!isCurrent(active)) return failure(desiredState, "telegram-stale-operation");
      const parsed = parseSnapshot(response);
      if (parsed !== undefined && parsed.channel.state !== "suspended" && operation === "resume") {
        transientSuspension = undefined;
      }
      return parsed === undefined
        ? failure(desiredState, "telegram-control-failed")
        : powerProjection(desiredState, parsed);
    });

  const restoreDaemonDesired = async (
    active: TelegramDaemonBinding,
    enabled: boolean,
  ): Promise<TelegramControlSnapshot | undefined> => {
    const restored = await guardedSnapshotCall(active, () =>
      enabled ? active.enableTelegram({}) : active.disableTelegram({}),
    );
    if (restored === undefined) return undefined;
    return (restored.channel.desiredState === "enabled") === enabled ? restored : undefined;
  };

  const clearPairingLease = (): void => {
    if (pairingLease === undefined) return;
    if (pairingLease.handle !== undefined) leaseClock.cancel(pairingLease.handle);
    pairingLease = undefined;
  };

  const hasPrimarySender = async (active: TelegramDaemonBinding): Promise<boolean | undefined> => {
    if (!isCurrent(active)) return undefined;
    let response: unknown;
    try {
      response = await active.listTelegramAllowedSenders({});
    } catch {
      return undefined;
    }
    if (!isCurrent(active)) return undefined;
    const parsed = TelegramAllowedSendersResultSchema.safeParse(response);
    return parsed.success
      ? parsed.data.senders.some((sender) => sender.role === "primary")
      : undefined;
  };

  const cleanupUnpaired = async (
    active: TelegramDaemonBinding,
  ): Promise<"clean" | "paired" | "primary" | "uncertain"> => {
    const cancelled = await guardedSnapshotCall(active, () => active.cancelTelegramPairing({}));
    if (cancelled === undefined) return "uncertain";
    if (cancelled.pairing.state === "paired") return "paired";
    if (cancelled.pairing.state !== "unpaired") return "uncertain";
    const primary = await hasPrimarySender(active);
    if (primary === undefined) return "uncertain";
    if (primary) return "primary";
    const disabled = await guardedSnapshotCall(active, () => active.disableTelegram({}));
    if (disabled?.channel.state !== "disabled" || disabled.pairing.state !== "unpaired") {
      return "uncertain";
    }
    const drained = await guardedSnapshotCall(active, () => active.drainTelegram({}));
    return drained?.channel.state === "disabled" && drained.pairing.state === "unpaired"
      ? "clean"
      : "uncertain";
  };

  const preservePaired = async (
    active: TelegramDaemonBinding,
    daemonSnapshot: TelegramControlSnapshot,
  ): Promise<TelegramControlSnapshot | undefined> => {
    if (!isCurrent(active) || daemonSnapshot.pairing.state !== "paired") return undefined;
    const profileStatus = await input.vault.profileStatus();
    if (!isCurrent(active) || profileStatus.state !== "configured") return undefined;
    const loaded = isReadyForProfile(daemonSnapshot, profileStatus)
      ? ({ outcome: "applied", current: daemonSnapshot } as const)
      : await loadStoredProfile(active, daemonSnapshot);
    if (loaded.outcome !== "applied" || loaded.current.pairing.state !== "paired") {
      return undefined;
    }
    const coherent = loaded.current;
    const desired = await resolveDesired(coherent);
    if (desired.state === "repair-required" || !isCurrent(active)) return undefined;
    if (desired.desiredState === "disabled") {
      clearPairingLease();
      if (coherent.channel.desiredState === "disabled" && coherent.channel.state === "disabled") {
        return coherent;
      }
      const disabled = await restoreDaemonDesired(active, false);
      return disabled?.pairing.state === "paired" && disabled.channel.state === "disabled"
        ? disabled
        : undefined;
    }
    if (isEnabledRuntimeCoherent(coherent)) {
      if (!isCurrent(active)) return undefined;
      clearPairingLease();
      return coherent;
    }
    const enabled = await restoreDaemonDesired(active, true);
    if (enabled?.pairing.state !== "paired" || !isEnabledRuntimeCoherent(enabled)) return undefined;
    clearPairingLease();
    return enabled;
  };

  const settleFailedPairingStart = async (
    active: TelegramDaemonBinding,
  ): Promise<
    | { readonly state: "closed"; readonly current: TelegramControlSnapshot }
    | { readonly state: "paired"; readonly current: TelegramControlSnapshot }
    | { readonly state: "uncertain" }
  > => {
    const cleanup = await cleanupUnpaired(active);
    if (!isCurrent(active)) return { state: "uncertain" };
    if (cleanup === "paired" || cleanup === "primary") {
      if ((await persistPairingDesired(active, true)) !== "applied") {
        return { state: "uncertain" };
      }
      const terminal = await guardedSnapshotCall(active, () =>
        cleanup === "paired" ? active.getTelegramStatus({}) : active.reconcileTelegram({}),
      );
      const preserved = terminal === undefined ? undefined : await preservePaired(active, terminal);
      return preserved === undefined
        ? { state: "uncertain" }
        : { state: "paired", current: preserved };
    }
    if (cleanup !== "clean" || !isCurrent(active)) return { state: "uncertain" };
    const stored = await persistPairingDesired(active, false);
    if (stored !== "applied" || !isCurrent(active)) return { state: "uncertain" };
    clearPairingLease();
    const terminal = await guardedSnapshotCall(active, () => active.getTelegramStatus({}));
    return terminal?.channel.state === "disabled" && terminal.pairing.state === "unpaired"
      ? { state: "closed", current: terminal }
      : { state: "uncertain" };
  };

  const pairingLeaseIsLive = (expected: DesktopTelegramPairingLease): boolean => {
    try {
      return accepting && pairingLease === expected && isCurrent(expected.binding);
    } catch {
      return false;
    }
  };

  const failPairingLeaseClosed = async (expected: DesktopTelegramPairingLease): Promise<void> => {
    if (!pairingLeaseIsLive(expected)) return;
    const current = await guardedSnapshotCall(expected.binding, () =>
      expected.binding.getTelegramStatus({}),
    );
    if (!pairingLeaseIsLive(expected)) return;
    if (current?.pairing.state === "paired") {
      await preservePaired(expected.binding, current);
      return;
    }
    await guardedSnapshotCall(expected.binding, () => expected.binding.cancelTelegramPairing({}));
    await guardedSnapshotCall(expected.binding, () => expected.binding.disableTelegram({}));
    await guardedSnapshotCall(expected.binding, () => expected.binding.drainTelegram({}));
    await persistPairingDesired(expected.binding, false);
    if (pairingLease === expected) clearPairingLease();
  };

  const schedulePairingLeaseExpiry = (
    expected: DesktopTelegramPairingLease,
    delayMs: number,
  ): void => {
    if (!pairingLeaseIsLive(expected)) return;
    try {
      expected.handle = leaseClock.schedule(() => dispatchPairingLeaseExpiry(expected), delayMs);
    } catch {
      expected.handle = undefined;
      void serialize(() => failPairingLeaseClosed(expected)).catch(() => undefined);
    }
  };

  const dispatchPairingLeaseExpiry = (expected: DesktopTelegramPairingLease): void => {
    if (!pairingLeaseIsLive(expected)) return;
    void serialize(() => expirePairingLease(expected)).catch(() => {
      if (pairingLeaseIsLive(expected)) schedulePairingLeaseExpiry(expected, 1_000);
    });
  };

  const retryPairingLeaseExpiry = (expected: DesktopTelegramPairingLease): void => {
    schedulePairingLeaseExpiry(expected, 1_000);
  };

  async function expirePairingLease(expected: DesktopTelegramPairingLease): Promise<void> {
    if (pairingLease !== expected || !isCurrent(expected.binding)) return;
    const current = await guardedSnapshotCall(expected.binding, () =>
      expected.binding.getTelegramStatus({}),
    );
    if (pairingLease !== expected) return;
    if (current === undefined) {
      retryPairingLeaseExpiry(expected);
      return;
    }
    if (current.pairing.state === "paired") {
      const preserved = await preservePaired(expected.binding, current);
      if (preserved === undefined && pairingLease === expected) {
        retryPairingLeaseExpiry(expected);
      }
      return;
    }
    if (current.pairing.state === "awaiting-code") {
      const same =
        current.pairing.code === expected.code && current.pairing.expiresAt === expected.expiresAt;
      if (!same) {
        armPairingLease(expected.binding, current.pairing);
        return;
      }
      const remaining = Date.parse(current.pairing.expiresAt) - leaseClock.now();
      if (remaining > 0) {
        armPairingLease(expected.binding, current.pairing);
        return;
      }
    }
    const cleanup = await cleanupUnpaired(expected.binding);
    if (pairingLease !== expected || !isCurrent(expected.binding)) return;
    if (cleanup === "primary") {
      const reconciled = await guardedSnapshotCall(expected.binding, () =>
        expected.binding.reconcileTelegram({}),
      );
      if (reconciled?.pairing.state === "paired") {
        await preservePaired(expected.binding, reconciled);
      } else if (pairingLease === expected) {
        retryPairingLeaseExpiry(expected);
      }
      return;
    }
    if (cleanup === "paired") {
      const terminal = await guardedSnapshotCall(expected.binding, () =>
        expected.binding.getTelegramStatus({}),
      );
      const preserved =
        terminal === undefined ? undefined : await preservePaired(expected.binding, terminal);
      if (preserved === undefined && pairingLease === expected) {
        retryPairingLeaseExpiry(expected);
      }
      return;
    }
    if (cleanup === "clean") {
      if (!isCurrent(expected.binding)) return;
      const stored = await persistPairingDesired(expected.binding, false);
      if (!isCurrent(expected.binding) || pairingLease !== expected) return;
      if (stored === "applied") clearPairingLease();
      else if (pairingLease === expected) {
        retryPairingLeaseExpiry(expected);
      }
      return;
    }
    retryPairingLeaseExpiry(expected);
  }

  const armPairingLease = (
    active: TelegramDaemonBinding,
    pairing: Extract<TelegramPairingState, { state: "awaiting-code" }>,
  ): void => {
    clearPairingLease();
    if (!accepting) return;
    const lease = {
      binding: active,
      generation: active.generation,
      athleteHome: active.athleteHome,
      code: pairing.code,
      expiresAt: pairing.expiresAt,
      handle: undefined as unknown,
    };
    pairingLease = lease;
    const delay = Math.max(0, Date.parse(pairing.expiresAt) - leaseClock.now());
    schedulePairingLeaseExpiry(lease, delay);
  };

  const settleUncertainPairingClaim = async (
    active: TelegramDaemonBinding,
    daemonSnapshot: TelegramControlSnapshot,
  ): Promise<TelegramControlSnapshot | undefined> => {
    if (
      daemonSnapshot.pairing.state !== "failed" ||
      daemonSnapshot.pairing.errorCode !== "telegram-pairing-storage-uncertain"
    ) {
      return undefined;
    }
    clearPairingLease();
    if ((await persistPairingDesired(active, false)) !== "applied") return undefined;
    const disabled = await guardedSnapshotCall(active, () => active.disableTelegram({}));
    if (
      disabled?.channel.state !== "disabled" ||
      disabled.pairing.state !== "failed" ||
      disabled.pairing.errorCode !== "telegram-pairing-storage-uncertain"
    ) {
      return undefined;
    }
    const drained = await guardedSnapshotCall(active, () => active.drainTelegram({}));
    return drained?.channel.state === "disabled" &&
      drained.pairing.state === "failed" &&
      drained.pairing.errorCode === "telegram-pairing-storage-uncertain"
      ? drained
      : undefined;
  };

  const repairPairingTruth = async (
    active: TelegramDaemonBinding,
    daemonSnapshot: TelegramControlSnapshot,
    desiredState: "disabled" | "enabled",
  ): Promise<TelegramControlSnapshot | undefined> => {
    if (desiredState === "disabled") {
      clearPairingLease();
      if (
        daemonSnapshot.channel.desiredState === "disabled" &&
        daemonSnapshot.channel.state === "disabled"
      ) {
        return daemonSnapshot;
      }
      const disabled = await guardedSnapshotCall(active, () => active.disableTelegram({}));
      return disabled?.channel.desiredState === "disabled" && disabled.channel.state === "disabled"
        ? disabled
        : undefined;
    }
    if (
      daemonSnapshot.pairing.state === "failed" &&
      daemonSnapshot.pairing.errorCode === "telegram-pairing-storage-uncertain"
    ) {
      return settleUncertainPairingClaim(active, daemonSnapshot);
    }
    if (daemonSnapshot.pairing.state === "paired") {
      return preservePaired(active, daemonSnapshot);
    }
    if (daemonSnapshot.pairing.state === "awaiting-code") {
      const desired = await persistPairingDesired(active, true);
      if (desired !== "applied") return undefined;
      const pairingRuntimeCoherent =
        isPollingCapable(daemonSnapshot) ||
        (daemonSnapshot.channel.state === "suspended" && transientSuspension === active);
      const live = pairingRuntimeCoherent
        ? daemonSnapshot
        : await restoreDaemonDesired(active, true);
      if (live === undefined) return undefined;
      if (live.pairing.state === "paired") return preservePaired(active, live);
      if (
        live.pairing.state !== "awaiting-code" ||
        (!isPollingCapable(live) &&
          !(live.channel.state === "suspended" && transientSuspension === active))
      ) {
        return undefined;
      }
      armPairingLease(active, live.pairing);
      return live;
    }
    const primary = await hasPrimarySender(active);
    if (primary === undefined) return undefined;
    if (primary) {
      const desired = await persistPairingDesired(active, true);
      if (desired !== "applied") return undefined;
      const reconciled = await guardedSnapshotCall(active, () => active.reconcileTelegram({}));
      return reconciled?.pairing.state === "paired"
        ? preservePaired(active, reconciled)
        : undefined;
    }
    const cleaned = await cleanupUnpaired(active);
    if (cleaned === "paired") {
      const current = await guardedSnapshotCall(active, () => active.getTelegramStatus({}));
      return current === undefined ? undefined : preservePaired(active, current);
    }
    if (cleaned === "primary") return undefined;
    if (cleaned !== "clean" || !isCurrent(active)) return undefined;
    const stored = await persistPairingDesired(active, false);
    if (stored !== "applied" || !isCurrent(active)) return undefined;
    clearPairingLease();
    return guardedSnapshotCall(active, () => active.getTelegramStatus({}));
  };

  return {
    configure: (token) => configureCandidate(token, false),
    replace: (token) => configureCandidate(token, true),

    enable: () => mutateDesired(true, (active) => active.enableTelegram({})),
    disable: () => mutateDesired(false, (active) => active.disableTelegram({})),

    stopPolling: () => transientPolling("suspend", (active) => active.suspendTelegramPolling({})),
    resumePolling: () => transientPolling("resume", (active) => active.resumeTelegramPolling({})),

    remove() {
      return runMutation(async () => {
        const checked = await checkedBinding();
        if ("result" in checked) return checked.result;
        const prior = await captureProfile(checked.active);
        if (prior.state === "uncertain") return uncertain();
        if (prior.state === "refused") return refused(prior.reason);
        if (prior.state !== "configured") return refused("invalid-state");
        const previousDesired = checked.desiredState === "enabled";
        const disabled = await guardedSnapshotCall(checked.active, () =>
          checked.active.disableTelegram({}),
        );
        const reset =
          disabled?.channel.state !== "disabled"
            ? undefined
            : await guardedSnapshotCall(checked.active, () =>
                checked.active.resetTelegramAccess({}),
              );
        if (reset?.channel.state === "disabled" && reset.pairing.state === "unpaired") {
          clearPairingLease();
        }
        const forgotten =
          reset?.channel.state !== "disabled" || reset.pairing.state !== "unpaired"
            ? undefined
            : await guardedSnapshotCall(checked.active, () =>
                checked.active.forgetTelegramCredential({}),
              );
        if (forgotten?.channel.state !== "disabled" || forgotten.bot.state !== "unconfigured") {
          return uncertain("control-uncertain");
        }
        const desiredWrite = await persistDesired(false);
        if (desiredWrite !== "applied") {
          if (desiredWrite === "uncertain") await restoreDesired(previousDesired);
          return uncertain();
        }
        const deleted = await input.vault.deleteProfile();
        if (deleted.outcome !== "applied") {
          await restoreDesired(previousDesired);
          return uncertain();
        }
        return applied(await project(forgotten, checked.active));
      });
    },

    resetRuntimeForCredentialReset() {
      return serialize(async () => {
        const active = binding();
        if (active !== undefined) {
          const disabled = await guardedSnapshotCall(active, () => active.disableTelegram({}));
          if (disabled?.channel.state !== "disabled") return false;
          const reset = await guardedSnapshotCall(active, () => active.resetTelegramAccess({}));
          if (reset?.channel.state !== "disabled" || reset.pairing.state !== "unpaired") {
            return false;
          }
          const forgotten = await guardedSnapshotCall(active, () =>
            active.forgetTelegramCredential({}),
          );
          if (forgotten?.channel.state !== "disabled" || forgotten.bot.state !== "unconfigured") {
            return false;
          }
        }
        if ((await persistDesired(false)) !== "applied") return false;
        clearPairingLease();
        return true;
      }).catch(() => false);
    },

    removeWebhook() {
      return runMutation(async () => {
        const checked = await checkedBinding();
        if ("result" in checked) return checked.result;
        const prior = await captureProfile(checked.active);
        if (prior.state === "uncertain") return uncertain();
        if (prior.state === "refused") return refused(prior.reason);
        if (prior.state !== "configured") return refused("invalid-state");
        let ready: Extract<TelegramCredentialInspection, { status: "ready" }> | undefined;
        const appliedProfile = await input.vault.applyStoredProfile(
          checked.active.athleteHome,
          async (stored) => {
            if (!isCurrent(checked.active)) throw new TypeError();
            const deleted = parseInspection(
              await checked.active.deleteTelegramWebhook({ token: stored.token }),
            );
            if (deleted?.status !== "ready" || !isCurrent(checked.active)) throw new TypeError();
            ready = deleted;
          },
        );
        if (ready === undefined) {
          if (appliedProfile.outcome === "uncertain") return uncertain();
          if (
            appliedProfile.outcome === "refused" &&
            isSecureStorageRefusal(appliedProfile.reason)
          ) {
            return refused(appliedProfile.reason);
          }
          return appliedProfile.outcome === "refused" &&
            appliedProfile.reason !== "runtime-unavailable"
            ? refused("control-unavailable")
            : uncertain("control-uncertain");
        }
        if (appliedProfile.outcome === "uncertain") return uncertain();
        if (appliedProfile.outcome === "refused") {
          return uncertain(
            appliedProfile.reason === "runtime-unavailable"
              ? "control-uncertain"
              : "storage-uncertain",
          );
        }
        if (ready.bot.id !== prior.profile.bot.id) return uncertain("control-uncertain");
        const stored = await replaceProfile(checked.active, prior.profile.token, ready.bot);
        if (stored !== "applied") return uncertain();
        if (checked.active.supervision === "attached") {
          return applied({
            channel:
              checked.desiredState === "enabled"
                ? { desiredState: "enabled", state: "transfer-required" }
                : DISABLED_CHANNEL,
            bot: { state: "ready", username: ready.bot.username },
            pairing: UNPAIRED,
            credentialConfigured: true,
          });
        }
        const daemonStatus = await guardedSnapshotCall(checked.active, () =>
          checked.active.getTelegramStatus({}),
        );
        if (daemonStatus === undefined) return uncertain("control-uncertain");
        const loaded = await loadStoredProfile(checked.active, daemonStatus);
        if (loaded.outcome === "uncertain") return uncertain(loaded.reason);
        if (loaded.outcome === "refused") return uncertain("control-uncertain");
        return applied(await project(loaded.current, checked.active));
      });
    },

    status: () =>
      runSnapshot(async () => {
        const active = binding();
        if (reconciliationFailure !== undefined) {
          if (reconciliationFailure.binding === active) return reconciliationFailure.current;
          reconciliationFailure = undefined;
        }
        if (active === undefined) return project();
        const daemonStatus = await guardedSnapshotCall(active, () => active.getTelegramStatus({}));
        if (daemonStatus === undefined) {
          return failureForDesired("telegram-control-failed");
        }
        const desired = await resolveDesired(daemonStatus);
        if (desired.state === "repair-required") {
          return project(daemonStatus, active, desired);
        }
        if (active.supervision === "attached") return project(daemonStatus, active, desired);
        const profileStatus = await input.vault.profileStatus();
        if (!isCurrent(active)) throw new TypeError("stale Telegram daemon status");
        if (profileStatus.state !== "configured") return project(daemonStatus, active);
        const loaded = isReadyForProfile(daemonStatus, profileStatus)
          ? ({ outcome: "applied", current: daemonStatus } as const)
          : await loadStoredProfile(active, daemonStatus);
        if (loaded.outcome !== "applied") {
          const errorCode =
            loaded.outcome === "refused" && isSecureStorageRefusal(loaded.reason)
              ? profileStatusErrorCode(loaded.reason)
              : loaded.outcome === "uncertain"
                ? "telegram-control-failed"
                : "telegram-credential-unavailable";
          return failure(
            await readDesired(),
            errorCode,
            true,
            profileBot(profileStatus),
            daemonStatus.pairing,
          );
        }
        const repaired = await repairPairingTruth(active, loaded.current, desired.desiredState);
        if (!isCurrent(active)) throw new TypeError("stale Telegram daemon status");
        return repaired === undefined
          ? failure(
              await readDesired(),
              "telegram-control-failed",
              true,
              profileBot(profileStatus),
              loaded.current.pairing,
            )
          : project(repaired, active);
      }),

    reconcile() {
      return reconcileMutation(async () => {
        const checked = await checkedBinding();
        if ("result" in checked) return checked.result;
        const daemonStatus = await guardedSnapshotCall(checked.active, () =>
          checked.active.getTelegramStatus({}),
        );
        if (daemonStatus === undefined) return refused("stale-operation");
        if (checked.active.supervision === "attached") {
          const current = await project(daemonStatus, checked.active);
          return checked.desiredState === "enabled"
            ? refused("transfer-required", current)
            : applied(current);
        }
        const profileStatus = await input.vault.profileStatus();
        if (profileStatus.state === "uncertain") return uncertain();
        const profileRefusal = profileStatusRefusal(profileStatus);
        if (profileRefusal !== undefined) return refused(profileRefusal);
        if (profileStatus.state !== "configured") {
          if (checked.desiredState === "enabled") return refused("invalid-state");
          const disabled = await guardedSnapshotCall(checked.active, () =>
            checked.active.disableTelegram({}),
          );
          return disabled === undefined
            ? uncertain("control-uncertain")
            : applied(await project(disabled, checked.active));
        }
        const loaded = await loadStoredProfile(checked.active, daemonStatus);
        if (loaded.outcome === "uncertain") return uncertain(loaded.reason);
        if (loaded.outcome === "refused") return refused(loaded.reason);
        const repaired = await repairPairingTruth(
          checked.active,
          loaded.current,
          checked.desiredState,
        );
        if (repaired === undefined) return uncertain("control-uncertain");
        const desiredAfterRepair = await readDesired();
        const final =
          repaired.pairing.state === "awaiting-code" || repaired.pairing.state === "paired"
            ? repaired
            : await guardedSnapshotCall(checked.active, () =>
                desiredAfterRepair === "enabled"
                  ? checked.active.enableTelegram({})
                  : checked.active.disableTelegram({}),
              );
        if (final === undefined) return uncertain("control-uncertain");
        if (final.channel.state === "conflict") {
          return refused("polling-conflict", await project(final, checked.active));
        }
        return applied(await project(final, checked.active));
      });
    },

    beginPairing() {
      return runMutation(async () => {
        const checked = await checkedBinding();
        if ("result" in checked) return checked.result;
        if (checked.active.supervision === "attached") return refused("transfer-required");
        const profileStatus = await input.vault.profileStatus();
        if (profileStatus.state === "uncertain") return uncertain();
        const profileRefusal = profileStatusRefusal(profileStatus);
        if (profileRefusal !== undefined) return refused(profileRefusal);
        if (profileStatus.state !== "configured") return refused("invalid-state");
        const daemonStatus = await guardedSnapshotCall(checked.active, () =>
          checked.active.getTelegramStatus({}),
        );
        if (daemonStatus === undefined) return refused("stale-operation");
        if (daemonStatus.pairing.state === "paired") {
          const coherent = await preservePaired(checked.active, daemonStatus);
          if (coherent === undefined) return uncertain("control-uncertain");
          const desiredWrite = await persistPairingDesired(checked.active, true);
          if (desiredWrite !== "applied") {
            return uncertain(
              desiredWrite === "uncertain" ? "storage-uncertain" : "control-uncertain",
            );
          }
          const preserved = await preservePaired(checked.active, coherent);
          return preserved === undefined
            ? uncertain("control-uncertain")
            : applied(await project(preserved, checked.active));
        }
        const desiredWrite = await persistPairingDesired(checked.active, true);
        if (desiredWrite !== "applied") {
          const settled = await settleFailedPairingStart(checked.active);
          if (settled.state === "paired") {
            return applied(await project(settled.current, checked.active));
          }
          return settled.state === "closed"
            ? refused("storage-failed", await project(settled.current, checked.active))
            : uncertain(desiredWrite === "uncertain" ? "storage-uncertain" : "control-uncertain");
        }
        const loaded = await loadStoredProfile(checked.active, daemonStatus);
        if (loaded.outcome !== "applied") {
          const settled = await settleFailedPairingStart(checked.active);
          if (settled.state === "paired") {
            return applied(await project(settled.current, checked.active));
          }
          if (settled.state === "uncertain" || loaded.outcome === "uncertain") {
            return uncertain(loaded.outcome === "uncertain" ? loaded.reason : "control-uncertain");
          }
          return refused(loaded.reason, await project(settled.current, checked.active));
        }
        if (!isCurrent(checked.active)) {
          return uncertain("control-uncertain");
        }
        if (loaded.current.pairing.state === "paired") {
          const preserved = await preservePaired(checked.active, loaded.current);
          return preserved === undefined
            ? uncertain("control-uncertain")
            : applied(await project(preserved, checked.active));
        }
        const pairing = await guardedSnapshotCall(checked.active, () =>
          checked.active.beginTelegramPairing({}),
        );
        if (
          pairing?.pairing.state === "awaiting-code" &&
          isPollingCapable(pairing) &&
          isReadyForProfile(pairing, profileStatus)
        ) {
          armPairingLease(checked.active, pairing.pairing);
          return applied(await project(pairing, checked.active));
        }
        if (pairing?.pairing.state === "paired") {
          const preserved = await preservePaired(checked.active, pairing);
          return preserved === undefined
            ? uncertain("control-uncertain")
            : applied(await project(preserved, checked.active));
        }
        if (
          pairing?.pairing.state === "failed" &&
          pairing.pairing.errorCode === "telegram-pairing-storage-uncertain"
        ) {
          const settled = await settleUncertainPairingClaim(checked.active, pairing);
          return settled === undefined
            ? uncertain("control-uncertain")
            : {
                outcome: "uncertain",
                reason: "storage-uncertain",
                current: await project(settled, checked.active),
              };
        }
        const settled = await settleFailedPairingStart(checked.active);
        if (settled.state === "paired") {
          return applied(await project(settled.current, checked.active));
        }
        return settled.state === "closed"
          ? refused(
              pairing === undefined ? "control-unavailable" : "invalid-state",
              await project(settled.current, checked.active),
            )
          : uncertain("control-uncertain");
      });
    },

    cancelPairing() {
      return runMutation(async () => {
        const checked = await checkedBinding();
        if ("result" in checked) return checked.result;
        if (checked.active.supervision === "attached") return refused("transfer-required");
        const priorDesired = checked.desiredState === "enabled";
        const cancelled = await guardedSnapshotCall(checked.active, () =>
          checked.active.cancelTelegramPairing({}),
        );
        if (cancelled === undefined) {
          return uncertain("control-uncertain");
        }
        if (cancelled.pairing.state === "paired") {
          const preserved = await preservePaired(checked.active, cancelled);
          return preserved === undefined
            ? uncertain("control-uncertain")
            : applied(await project(preserved, checked.active));
        }
        if (cancelled.pairing.state === "awaiting-code") {
          if (!priorDesired) {
            clearPairingLease();
            const disabled = await restoreDaemonDesired(checked.active, false);
            if (disabled === undefined) return uncertain("control-uncertain");
            if (disabled.pairing.state === "paired") {
              return applied(await project(disabled, checked.active));
            }
            return refused("invalid-state", await project(disabled, checked.active));
          }
          if (!isCurrent(checked.active)) return uncertain("control-uncertain");
          armPairingLease(checked.active, cancelled.pairing);
          return refused("invalid-state", await project(cancelled, checked.active));
        }
        if (cancelled.pairing.state !== "unpaired") return uncertain("control-uncertain");
        const primary = await hasPrimarySender(checked.active);
        if (primary === undefined) return uncertain("control-uncertain");
        if (primary) {
          if (!isCurrent(checked.active)) return uncertain("control-uncertain");
          const reconciled = await guardedSnapshotCall(checked.active, () =>
            checked.active.reconcileTelegram({}),
          );
          const preserved =
            reconciled?.pairing.state === "paired"
              ? await preservePaired(checked.active, reconciled)
              : undefined;
          return preserved === undefined
            ? uncertain("control-uncertain")
            : applied(await project(preserved, checked.active));
        }
        const disabled = await restoreDaemonDesired(checked.active, false);
        if (disabled?.pairing.state !== "unpaired") return uncertain("control-uncertain");
        const drained = await guardedSnapshotCall(checked.active, () =>
          checked.active.drainTelegram({}),
        );
        if (drained?.channel.state !== "disabled" || drained.pairing.state !== "unpaired") {
          return uncertain("control-uncertain");
        }
        if (!isCurrent(checked.active)) return uncertain("control-uncertain");
        const desiredWrite = await persistPairingDesired(checked.active, false);
        if (desiredWrite !== "applied" || !isCurrent(checked.active)) return uncertain();
        clearPairingLease();
        return applied(await project(drained, checked.active));
      });
    },

    listAllowedSenders() {
      return serialize(async () => {
        try {
          const active = binding();
          if (active === undefined || !isCurrent(active)) throw new TypeError();
          const response = await active.listTelegramAllowedSenders({});
          if (!isCurrent(active)) throw new TypeError();
          const parsed = TelegramAllowedSendersResultSchema.safeParse(response);
          if (!parsed.success) throw new TypeError();
          return parsed.data.senders.length === 0 ? emptySenders() : parsed.data;
        } catch {
          throw new TypeError();
        }
      });
    },

    addAllowedSender(sender) {
      return serialize(async () => {
        let active: TelegramDaemonBinding | undefined;
        try {
          const desired = await resolveDesired();
          if (desired.state === "repair-required") {
            return { outcome: "uncertain", reason: "storage-uncertain" };
          }
          active = binding();
          if (active === undefined || !isCurrent(active)) {
            return { outcome: "refused", reason: "control-unavailable" };
          }
        } catch {
          return { outcome: "refused", reason: "control-unavailable" };
        }
        try {
          const response = await active.addTelegramAllowedSender(sender);
          if (!isCurrent(active)) {
            return { outcome: "uncertain", reason: "control-uncertain" };
          }
          return (
            parseSenderMutation(response) ?? {
              outcome: "uncertain",
              reason: "control-uncertain",
            }
          );
        } catch {
          return { outcome: "uncertain", reason: "control-uncertain" };
        }
      });
    },

    removeAllowedSender(sender) {
      return serialize(async () => {
        let active: TelegramDaemonBinding | undefined;
        try {
          const desired = await resolveDesired();
          if (desired.state === "repair-required") {
            return { outcome: "uncertain", reason: "storage-uncertain" };
          }
          active = binding();
          if (active === undefined || !isCurrent(active)) {
            return { outcome: "refused", reason: "control-unavailable" };
          }
        } catch {
          return { outcome: "refused", reason: "control-unavailable" };
        }
        try {
          const response = await active.removeTelegramAllowedSender(sender);
          if (!isCurrent(active)) {
            return { outcome: "uncertain", reason: "control-uncertain" };
          }
          return (
            parseSenderMutation(response) ?? {
              outcome: "uncertain",
              reason: "control-uncertain",
            }
          );
        } catch {
          return { outcome: "uncertain", reason: "control-uncertain" };
        }
      });
    },

    close() {
      if (closePromise !== undefined) return closePromise;
      accepting = false;
      clearPairingLease();
      closePromise = pending;
      return closePromise;
    },
  };
}
