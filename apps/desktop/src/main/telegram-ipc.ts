import {
  TelegramAllowedSenderRpcParamsSchema,
  TelegramAllowedSendersMutationResultSchema,
  TelegramAllowedSendersResultSchema,
  TelegramBotStateSchema,
  TelegramChannelStatusSchema,
  TelegramClipboardCredentialSchema,
  TelegramPairingStateSchema,
  type TelegramAllowedSendersMutationResult,
  type TelegramAllowedSendersResult,
} from "@enduragent/coach-contract";
import type { Clipboard, IpcMain, IpcMainInvokeEvent } from "electron";
import {
  DESKTOP_TELEGRAM_ADD_ALLOWED_SENDER_CHANNEL,
  DESKTOP_TELEGRAM_ACKNOWLEDGE_GAP_WARNING_CHANNEL,
  DESKTOP_TELEGRAM_BEGIN_PAIRING_CHANNEL,
  DESKTOP_TELEGRAM_CANCEL_PAIRING_CHANNEL,
  DESKTOP_TELEGRAM_DISABLE_CHANNEL,
  DESKTOP_TELEGRAM_ENABLE_CHANNEL,
  DESKTOP_TELEGRAM_LIST_ALLOWED_SENDERS_CHANNEL,
  DESKTOP_TELEGRAM_PASTE_CREDENTIAL_CHANNEL,
  DESKTOP_TELEGRAM_RECONCILE_CHANNEL,
  DESKTOP_TELEGRAM_REMOVE_ALLOWED_SENDER_CHANNEL,
  DESKTOP_TELEGRAM_REMOVE_CHANNEL,
  DESKTOP_TELEGRAM_REMOVE_WEBHOOK_CHANNEL,
  DESKTOP_TELEGRAM_STATUS_CHANNEL,
} from "./constants.js";
import {
  DESKTOP_TELEGRAM_CONTROL_ERROR_CODES,
  type DesktopTelegramChannelStatus,
  type DesktopTelegramControlErrorCode,
  type DesktopTelegramMutationResult as CoordinatorTelegramMutationResult,
  type DesktopTelegramSnapshot,
  type TelegramControlCoordinator,
} from "./telegram-control.js";
import type { TelegramCredentialVault } from "./telegram-credential-vault.js";
import type { DesktopTelegramPowerLifecycle, TelegramGapWarning } from "./telegram-power.js";

const DESKTOP_ERRORS = new Set<string>(DESKTOP_TELEGRAM_CONTROL_ERROR_CODES);
const COORDINATOR_REFUSAL_REASONS = new Set([
  "invalid-token",
  "validation-unavailable",
  "webhook-removal-required",
  "encryption-unavailable",
  "unsafe-backend",
  "storage-failed",
  "stale-operation",
  "transfer-required",
  "polling-conflict",
  "control-unavailable",
  "invalid-state",
]);

export interface DesktopTelegramStatus extends DesktopTelegramSnapshot {
  readonly gapWarning: TelegramGapWarning;
}

export type DesktopTelegramMutationRefusalReason =
  | "clipboard-unavailable"
  | "clipboard-clear-failed"
  | "invalid-token-format"
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

export type DesktopTelegramMutationResult =
  | Readonly<{ outcome: "applied"; current: DesktopTelegramStatus }>
  | Readonly<{
      outcome: "refused";
      reason: DesktopTelegramMutationRefusalReason;
      current: DesktopTelegramStatus;
    }>
  | Readonly<{
      outcome: "uncertain";
      reason: "storage-uncertain" | "control-uncertain";
      current: DesktopTelegramStatus;
    }>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function copyChannel(value: unknown): DesktopTelegramChannelStatus | undefined {
  const daemon = TelegramChannelStatusSchema.safeParse(value);
  if (daemon.success) return daemon.data;
  if (!record(value)) return undefined;
  if (
    exactKeys(value, ["desiredState", "state"]) &&
    value.desiredState === "enabled" &&
    value.state === "transfer-required"
  ) {
    return { desiredState: "enabled", state: "transfer-required" };
  }
  if (
    exactKeys(value, ["desiredState", "errorCode", "state"]) &&
    (value.desiredState === "disabled" || value.desiredState === "enabled") &&
    value.state === "failed" &&
    typeof value.errorCode === "string" &&
    DESKTOP_ERRORS.has(value.errorCode)
  ) {
    return {
      desiredState: value.desiredState,
      state: "failed",
      errorCode: value.errorCode as DesktopTelegramControlErrorCode,
    };
  }
  return undefined;
}

function parseSnapshot(value: unknown): DesktopTelegramSnapshot | undefined {
  if (record(value) && exactKeys(value, ["bot", "channel", "credentialConfigured", "pairing"])) {
    const channel = copyChannel(value.channel);
    const bot = TelegramBotStateSchema.safeParse(value.bot);
    const pairing = TelegramPairingStateSchema.safeParse(value.pairing);
    if (
      channel !== undefined &&
      bot.success &&
      pairing.success &&
      typeof value.credentialConfigured === "boolean"
    ) {
      return {
        channel,
        bot: bot.data,
        pairing: pairing.data,
        credentialConfigured: value.credentialConfigured,
      };
    }
  }
  return undefined;
}

function closedSnapshot(): DesktopTelegramSnapshot {
  return {
    channel: {
      desiredState: "disabled",
      state: "failed",
      errorCode: "telegram-control-failed",
    },
    bot: { state: "unconfigured" },
    pairing: { state: "unpaired" },
    credentialConfigured: false,
  };
}

function copyMutation(value: unknown): CoordinatorTelegramMutationResult {
  if (!record(value) || typeof value.outcome !== "string") throw new TypeError();
  const current = parseSnapshot(value.current);
  if (current === undefined) throw new TypeError();
  if (value.outcome === "applied" && exactKeys(value, ["current", "outcome"])) {
    return { outcome: "applied", current };
  }
  if (
    value.outcome === "refused" &&
    typeof value.reason === "string" &&
    COORDINATOR_REFUSAL_REASONS.has(value.reason) &&
    exactKeys(value, ["current", "outcome", "reason"])
  ) {
    return {
      outcome: "refused",
      reason: value.reason as Extract<
        CoordinatorTelegramMutationResult,
        { readonly outcome: "refused" }
      >["reason"],
      current,
    };
  }
  if (
    value.outcome === "uncertain" &&
    (value.reason === "storage-uncertain" || value.reason === "control-uncertain") &&
    exactKeys(value, ["current", "outcome", "reason"])
  ) {
    return { outcome: "uncertain", reason: value.reason, current };
  }
  throw new TypeError();
}

function copySenders(value: unknown): TelegramAllowedSendersResult {
  const parsed = TelegramAllowedSendersResultSchema.safeParse(value);
  if (!parsed.success) throw new TypeError();
  return parsed.data;
}

function copySenderMutation(value: unknown): TelegramAllowedSendersMutationResult {
  const parsed = TelegramAllowedSendersMutationResultSchema.safeParse(value);
  if (!parsed.success) throw new TypeError();
  return parsed.data;
}

function parseGapWarning(value: unknown): TelegramGapWarning | undefined {
  if (record(value) && exactKeys(value, ["state"]) && value.state === "clear") {
    return { state: "clear" };
  }
  if (
    record(value) &&
    exactKeys(value, ["detectedAt", "state"]) &&
    value.state === "possible-message-loss" &&
    typeof value.detectedAt === "string"
  ) {
    try {
      if (new Date(value.detectedAt).toISOString() === value.detectedAt) {
        return { state: "possible-message-loss", detectedAt: value.detectedAt };
      }
    } catch {}
  }
  return undefined;
}

async function captureClipboard(clipboard: Pick<Clipboard, "readText" | "clear">): Promise<
  | { readonly status: "captured"; readonly token: string }
  | {
      readonly status: "refused";
      readonly reason: "clipboard-unavailable" | "clipboard-clear-failed" | "invalid-token-format";
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
  const parsed = TelegramClipboardCredentialSchema.safeParse(value.trim());
  return parsed.success
    ? { status: "captured", token: parsed.data }
    : { status: "refused", reason: "invalid-token-format" };
}

export function installDesktopTelegramIpc(input: {
  readonly ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  readonly clipboard: Pick<Clipboard, "readText" | "clear">;
  readonly isTrusted: (event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">) => boolean;
  readonly coordinator: TelegramControlCoordinator;
  readonly vault: Pick<TelegramCredentialVault, "profileStatus">;
  readonly power: Pick<
    DesktopTelegramPowerLifecycle,
    "warning" | "resetForCreate" | "acknowledgeWarning"
  >;
}): () => Promise<void> {
  let accepting = true;
  let closePromise: Promise<void> | undefined;
  let operationQueue = Promise.resolve();
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
    if (!input.isTrusted(event)) throw new Error("untrusted desktop Telegram request");
    if (args.length !== 0) throw new TypeError("invalid desktop Telegram request");
  };
  const trustedSenderArgument = (
    event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">,
    args: readonly unknown[],
  ) => {
    if (!accepting) throw new TypeError();
    if (!input.isTrusted(event)) throw new Error("untrusted desktop Telegram request");
    if (args.length !== 1) throw new TypeError("invalid desktop Telegram request");
    const parsed = TelegramAllowedSenderRpcParamsSchema.safeParse(args[0]);
    if (!parsed.success) throw new TypeError();
    return parsed.data;
  };
  const readGapWarning = async (): Promise<TelegramGapWarning> => {
    try {
      return parseGapWarning(await input.power.warning()) ?? { state: "clear" };
    } catch {
      return { state: "clear" };
    }
  };
  const withGapWarning = async (
    snapshot: DesktopTelegramSnapshot,
  ): Promise<DesktopTelegramStatus> => ({
    ...snapshot,
    gapWarning: await readGapWarning(),
  });
  const runSnapshot = (operation: () => Promise<unknown>): Promise<DesktopTelegramStatus> =>
    serialize(async () => {
      try {
        return withGapWarning(parseSnapshot(await operation()) ?? closedSnapshot());
      } catch {
        return { ...closedSnapshot(), gapWarning: { state: "clear" } };
      }
    });
  const runMutation = (operation: () => Promise<unknown>): Promise<DesktopTelegramMutationResult> =>
    serialize(async () => {
      try {
        const result = copyMutation(await operation());
        return { ...result, current: await withGapWarning(result.current) };
      } catch {
        let current = closedSnapshot();
        try {
          current = parseSnapshot(await input.coordinator.status()) ?? current;
        } catch {}
        return {
          outcome: "uncertain",
          reason: "control-uncertain",
          current: await withGapWarning(current),
        };
      }
    });
  const localRefusal = (
    reason: "clipboard-unavailable" | "clipboard-clear-failed" | "invalid-token-format",
  ): Promise<DesktopTelegramMutationResult> =>
    serialize(async () => {
      let snapshot = closedSnapshot();
      try {
        snapshot = parseSnapshot(await input.coordinator.status()) ?? snapshot;
      } catch {}
      return { outcome: "refused", reason, current: await withGapWarning(snapshot) };
    });
  const readSenders = (operation: () => Promise<unknown>): Promise<TelegramAllowedSendersResult> =>
    serialize(async () => {
      try {
        return copySenders(await operation());
      } catch {
        throw new TypeError();
      }
    });
  const mutateSenders = (
    operation: () => Promise<unknown>,
  ): Promise<TelegramAllowedSendersMutationResult> =>
    serialize(async () => {
      try {
        return copySenderMutation(await operation());
      } catch {
        return { outcome: "uncertain", reason: "control-uncertain" };
      }
    });
  const handlers = [
    [
      DESKTOP_TELEGRAM_STATUS_CHANNEL,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        trustedZeroArgument(event, args);
        return runSnapshot(() => input.coordinator.status());
      },
    ],
    [
      DESKTOP_TELEGRAM_PASTE_CREDENTIAL_CHANNEL,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        trustedZeroArgument(event, args);
        return captureClipboard(input.clipboard).then((captured) => {
          if (captured.status === "refused") return localRefusal(captured.reason);
          return runMutation(async () => {
            let profile: Awaited<ReturnType<typeof input.vault.profileStatus>>;
            try {
              profile = await input.vault.profileStatus();
            } catch {
              return {
                outcome: "uncertain",
                reason: "storage-uncertain",
                current: closedSnapshot(),
              } as const;
            }
            if (profile.state === "configured") {
              return input.coordinator.replace(captured.token);
            }
            const result = await input.coordinator.configure(captured.token);
            if (
              result.outcome === "applied" ||
              (result.outcome === "refused" &&
                result.reason === "webhook-removal-required" &&
                result.current.credentialConfigured)
            ) {
              await input.power.resetForCreate();
            }
            return result;
          });
        });
      },
    ],
    [
      DESKTOP_TELEGRAM_ENABLE_CHANNEL,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        trustedZeroArgument(event, args);
        return runMutation(() => input.coordinator.enable());
      },
    ],
    [
      DESKTOP_TELEGRAM_DISABLE_CHANNEL,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        trustedZeroArgument(event, args);
        return runMutation(() => input.coordinator.disable());
      },
    ],
    [
      DESKTOP_TELEGRAM_REMOVE_CHANNEL,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        trustedZeroArgument(event, args);
        return runMutation(() => input.coordinator.remove());
      },
    ],
    [
      DESKTOP_TELEGRAM_RECONCILE_CHANNEL,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        trustedZeroArgument(event, args);
        return runMutation(() => input.coordinator.reconcile());
      },
    ],
    [
      DESKTOP_TELEGRAM_REMOVE_WEBHOOK_CHANNEL,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        trustedZeroArgument(event, args);
        return runMutation(() => input.coordinator.removeWebhook());
      },
    ],
    [
      DESKTOP_TELEGRAM_BEGIN_PAIRING_CHANNEL,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        trustedZeroArgument(event, args);
        return runMutation(() => input.coordinator.beginPairing());
      },
    ],
    [
      DESKTOP_TELEGRAM_CANCEL_PAIRING_CHANNEL,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        trustedZeroArgument(event, args);
        return runMutation(() => input.coordinator.cancelPairing());
      },
    ],
    [
      DESKTOP_TELEGRAM_LIST_ALLOWED_SENDERS_CHANNEL,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        trustedZeroArgument(event, args);
        return readSenders(() => input.coordinator.listAllowedSenders());
      },
    ],
    [
      DESKTOP_TELEGRAM_ADD_ALLOWED_SENDER_CHANNEL,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        const sender = trustedSenderArgument(event, args);
        return mutateSenders(() => input.coordinator.addAllowedSender(sender));
      },
    ],
    [
      DESKTOP_TELEGRAM_REMOVE_ALLOWED_SENDER_CHANNEL,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        const sender = trustedSenderArgument(event, args);
        return mutateSenders(() => input.coordinator.removeAllowedSender(sender));
      },
    ],
    [
      DESKTOP_TELEGRAM_ACKNOWLEDGE_GAP_WARNING_CHANNEL,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        trustedZeroArgument(event, args);
        return serialize(async (): Promise<DesktopTelegramMutationResult> => {
          let warning: TelegramGapWarning | undefined;
          try {
            warning = parseGapWarning(await input.power.acknowledgeWarning());
          } catch {}
          if (warning === undefined) {
            let current = closedSnapshot();
            try {
              current = parseSnapshot(await input.coordinator.status()) ?? current;
            } catch {}
            return {
              outcome: "uncertain",
              reason: "storage-uncertain",
              current: await withGapWarning(current),
            };
          }
          let current: DesktopTelegramSnapshot;
          try {
            const parsed = parseSnapshot(await input.coordinator.status());
            if (parsed === undefined) {
              return {
                outcome: "uncertain",
                reason: "control-uncertain",
                current: { ...closedSnapshot(), gapWarning: warning },
              };
            }
            current = parsed;
          } catch {
            return {
              outcome: "uncertain",
              reason: "control-uncertain",
              current: { ...closedSnapshot(), gapWarning: warning },
            };
          }
          const status = { ...current, gapWarning: warning };
          return warning.state === "clear"
            ? { outcome: "applied", current: status }
            : { outcome: "uncertain", reason: "storage-uncertain", current: status };
        });
      },
    ],
  ] as const;
  for (const [channel, handler] of handlers) input.ipcMain.handle(channel, handler);
  return () => {
    if (closePromise !== undefined) return closePromise;
    accepting = false;
    for (const [channel] of handlers) input.ipcMain.removeHandler(channel);
    closePromise = operationQueue;
    return closePromise;
  };
}
