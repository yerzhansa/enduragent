import { homedir } from "node:os";
import { extname, isAbsolute } from "node:path";
import type {
  ConfigureRuntimeRpcParams,
  LlmProvider,
  RuntimeConfigSnapshot,
} from "@enduragent/coach-contract";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, OpenDialogOptions } from "electron";
import {
  CHATGPT_ACTIVATION_TIMEOUT_MS,
  CHATGPT_PROFILE_NAME,
  type ChatGptAuthController,
  type ChatGptCancelLoginResult,
  type ChatGptLoginProgressPhase,
  type ChatGptLoginResult,
  type ChatGptStatus,
} from "./chatgpt-auth.js";
import { isDesktopRendererUrl } from "./renderer-navigation.js";
import {
  DESKTOP_CREDENTIAL_SLOTS,
  type CredentialSlotStatus,
  type CredentialDeleteResult,
  type CredentialVault,
  type CredentialWriteResult,
  type DesktopCredentialSlot,
} from "./credential-vault.js";
import {
  parseChatGptLlmSelection,
  parseClaudeCliLlmSelection,
  parseOnboardingLlmSelection,
  publicLlmProviderConfiguration,
  runtimeConfigurationForSelection,
  type OnboardingLlmConfiguration,
  type OnboardingLlmSelection,
  type OnboardingLlmSelectionResult,
} from "./llm-selection.js";
import type { ClaudeCliStatus, ClaudeCliStatusController } from "./claude-cli-status.js";

export const DESKTOP_CREDENTIAL_STATUS_CHANNEL = "enduragent:onboarding:credential-status" as const;
export const DESKTOP_CREDENTIAL_RETRY_CHANNEL = "enduragent:onboarding:credential-retry" as const;
export const DESKTOP_CREDENTIAL_WRITE_CHANNEL = "enduragent:onboarding:credential-write" as const;
export const DESKTOP_CREDENTIAL_DELETE_CHANNEL = "enduragent:settings:credential-delete" as const;
export const DESKTOP_CREDENTIAL_RECOVERY_STATUS_CHANNEL =
  "enduragent:settings:credential-recovery-status" as const;
export const DESKTOP_CREDENTIAL_RECOVERY_RETRY_CHANNEL =
  "enduragent:settings:credential-recovery-retry" as const;
export const DESKTOP_CREDENTIAL_RESET_CHANNEL = "enduragent:settings:credential-reset" as const;
export const DESKTOP_LLM_CONFIGURATION_CHANNEL = "enduragent:onboarding:llm-configuration" as const;
export const DESKTOP_LLM_SELECTION_APPLY_CHANNEL =
  "enduragent:onboarding:llm-selection-apply" as const;
export const DESKTOP_CHATGPT_STATUS_CHANNEL = "enduragent:onboarding:chatgpt-status" as const;
export const DESKTOP_CHATGPT_LOGIN_CHANNEL = "enduragent:onboarding:chatgpt-login" as const;
export const DESKTOP_CHATGPT_LOGIN_CANCEL_CHANNEL =
  "enduragent:onboarding:chatgpt-login-cancel" as const;
export const DESKTOP_CHATGPT_LOGIN_PROGRESS_CHANNEL =
  "enduragent:onboarding:chatgpt-login-progress" as const;
export const DESKTOP_CLAUDE_CLI_STATUS_CHANNEL = "enduragent:onboarding:claude-cli-status" as const;
export const DESKTOP_CLAUDE_CLI_RECHECK_CHANNEL =
  "enduragent:onboarding:claude-cli-recheck" as const;
export const DESKTOP_CHOOSE_IMPORT_FILES_CHANNEL =
  "enduragent:onboarding:choose-import-files" as const;

export interface OnboardingDialogPort {
  showOpenDialog(
    window: BrowserWindow,
    options: OpenDialogOptions,
  ): Promise<{ readonly canceled: boolean; readonly filePaths: readonly string[] }>;
}

interface RegisterOnboardingIpcOptions {
  readonly ipcMain: IpcMain;
  readonly dialog: OnboardingDialogPort;
  readonly window: BrowserWindow;
  readonly vault: CredentialVault;
  readonly chatGptAuth: ChatGptAuthController;
  readonly claudeCli: ClaudeCliStatusController;
  readonly getRuntimeConfig: () => Promise<RuntimeConfigSnapshot>;
  readonly applyExistingLlmSelection: (
    selection: OnboardingLlmSelection,
    signal?: AbortSignal,
  ) => Promise<boolean>;
  readonly chatGptActivationTimeoutMs?: number;
  readonly isTrusted: (event: IpcMainInvokeEvent) => boolean;
  readonly checkIntervalsCredentialOwner: (
    value: string,
  ) => Promise<"unowned" | "matched" | "mismatch" | "unresolved" | "store-unavailable">;
  readonly credentialRecoveryStatus: () => Promise<DesktopCredentialRecoveryStatus>;
  readonly retryCredentialRecovery: () => Promise<DesktopCredentialRecoveryStatus>;
  readonly resetAllCredentials: () => Promise<DesktopCredentialResetResult>;
}

export type DesktopCredentialRecoveryStatus =
  | Readonly<{ state: "ready"; unverifiedEnvelopes: number }>
  | Readonly<{ state: "locked" | "missing" | "unavailable" }>;

export type DesktopCredentialResetResult =
  | Readonly<{ status: "reset"; keyCleanupPending: boolean }>
  | Readonly<{ status: "refused"; reason: "runtime-unavailable" | "storage-failed" }>;

const SUPPORTED_EXTENSIONS = new Set([".fit", ".tcx", ".gpx"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function runtimeConfigurationForCredential(
  slot: DesktopCredentialSlot,
  value: string,
  selection?: OnboardingLlmSelection,
): ConfigureRuntimeRpcParams {
  if (slot === "intervals-icu") {
    if (selection !== undefined) throw new TypeError();
    return { intervals: { api_key: value } };
  }
  if (selection !== undefined) {
    const parsed = parseOnboardingLlmSelection(selection);
    if (parsed.provider !== slot) throw new TypeError();
    return runtimeConfigurationForSelection(parsed, value);
  }
  return {
    llm: {
      provider: slot satisfies LlmProvider,
      api_key: value,
    },
  };
}

function isSlot(value: unknown): value is DesktopCredentialSlot {
  return (
    typeof value === "string" && (DESKTOP_CREDENTIAL_SLOTS as readonly string[]).includes(value)
  );
}

function parseWriteInput(value: unknown): {
  readonly slot: DesktopCredentialSlot;
  readonly value: string;
  readonly selection?: OnboardingLlmSelection;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError();
  const input = value as Record<string, unknown>;
  const hasSelection = Object.hasOwn(input, "selection");
  if (
    Object.keys(input).length !== (hasSelection ? 3 : 2) ||
    !Object.hasOwn(input, "slot") ||
    !Object.hasOwn(input, "value") ||
    !isSlot(input.slot) ||
    typeof input.value !== "string"
  ) {
    throw new TypeError();
  }
  if (!hasSelection) return { slot: input.slot, value: input.value };
  if (input.slot === "intervals-icu") throw new TypeError();
  const selection = parseOnboardingLlmSelection(input.selection);
  if (selection.provider !== input.slot) throw new TypeError();
  return { slot: input.slot, value: input.value, selection };
}

function minimizeStatuses(value: readonly CredentialSlotStatus[]): readonly CredentialSlotStatus[] {
  return value.map((entry) => ({
    slot: entry.slot,
    state: entry.state,
    runtimeState: entry.runtimeState,
  }));
}

function minimizeWrite(value: CredentialWriteResult): CredentialWriteResult {
  if (value.status === "configured") {
    return { slot: value.slot, status: "configured", runtimeReady: value.runtimeReady };
  }
  if (value.status === "uncertain") {
    return { slot: value.slot, status: "uncertain", reason: "storage-uncertain" };
  }
  return { slot: value.slot, status: "refused", reason: value.reason };
}

export type DesktopCredentialId = DesktopCredentialSlot | typeof CHATGPT_PROFILE_NAME;

export type DesktopCredentialDeleteResult =
  | {
      readonly credential: DesktopCredentialId;
      readonly status: "deleted";
      readonly cleanupPending: boolean;
    }
  | {
      readonly credential: DesktopCredentialId;
      readonly status: "refused";
      readonly reason:
        | "not-found"
        | "managed-by-environment"
        | "storage-failed"
        | "runtime-unavailable"
        | "runtime-state-diverged";
    }
  | {
      readonly slot: DesktopCredentialSlot;
      readonly status: "uncertain";
      readonly reason: "storage-uncertain";
    };

function parseDeleteInput(value: unknown): DesktopCredentialId {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, "credential")
  ) {
    throw new TypeError();
  }
  const credential = (value as Record<string, unknown>).credential;
  if (credential === CHATGPT_PROFILE_NAME || isSlot(credential)) return credential;
  throw new TypeError();
}

function minimizeDelete(
  credential: DesktopCredentialId,
  value: CredentialDeleteResult | Awaited<ReturnType<ChatGptAuthController["deleteCredential"]>>,
): DesktopCredentialDeleteResult {
  if (value.status === "deleted") {
    return { credential, status: "deleted", cleanupPending: value.cleanupPending };
  }
  if (value.status === "uncertain") {
    return { slot: value.slot, status: "uncertain", reason: "storage-uncertain" };
  }
  return { credential, status: "refused", reason: value.reason };
}

function minimizeSelection(value: OnboardingLlmSelectionResult): OnboardingLlmSelectionResult {
  if (value.status === "configured") return { status: "configured", runtimeReady: true };
  return { status: "refused", reason: value.reason };
}

function minimizeChatGptStatus(value: ChatGptStatus): ChatGptStatus {
  return { state: value.state, runtimeReady: value.runtimeReady };
}

function minimizeClaudeCliStatus(value: ClaudeCliStatus): ClaudeCliStatus {
  return {
    state: value.state,
    ...(value.email === undefined ? {} : { email: value.email }),
    ...(value.plan === undefined ? {} : { plan: value.plan }),
    ...(value.version === undefined ? {} : { version: value.version }),
  };
}

function minimizeChatGptLogin(value: ChatGptLoginResult): ChatGptLoginResult {
  if (value.status === "stored") {
    return { status: "stored", operationId: value.operationId };
  }
  return { status: "refused", operationId: value.operationId, reason: value.reason };
}

function minimizeChatGptCancel(value: ChatGptCancelLoginResult): ChatGptCancelLoginResult {
  return { status: value.status, operationId: value.operationId };
}

function validChatGptOperationId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function parseChatGptLoginInput(value: unknown): {
  readonly operationId: string;
  readonly selection: OnboardingLlmSelection;
} {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 2 ||
    !Object.hasOwn(value, "operationId") ||
    !Object.hasOwn(value, "selection") ||
    !validChatGptOperationId(value.operationId)
  ) {
    throw new TypeError();
  }
  return {
    operationId: value.operationId,
    selection: parseChatGptLlmSelection(value.selection),
  };
}

function parseChatGptCancelInput(value: unknown): { readonly operationId: string } {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, "operationId") ||
    !validChatGptOperationId(value.operationId)
  ) {
    throw new TypeError();
  }
  return { operationId: value.operationId };
}

async function llmConfiguration(
  getRuntimeConfig: () => Promise<RuntimeConfigSnapshot>,
): Promise<OnboardingLlmConfiguration> {
  let active: OnboardingLlmConfiguration["active"] = null;
  try {
    const snapshot = await getRuntimeConfig();
    if (snapshot.llm.credential_configured) {
      active = { provider: snapshot.llm.provider, model: snapshot.llm.model };
    }
  } catch {}
  return {
    schemaVersion: 1,
    providers: publicLlmProviderConfiguration(),
    active,
  };
}

export function registerOnboardingIpc(options: RegisterOnboardingIpcOptions): () => void {
  let disposed = false;
  const requireTrusted = (event: IpcMainInvokeEvent): void => {
    if (!options.isTrusted(event)) throw new TypeError();
  };
  const publishChatGptProgress = (
    sender: IpcMainInvokeEvent["sender"],
    operationId: string,
    phase: ChatGptLoginProgressPhase,
  ): void => {
    try {
      if (disposed || sender.isDestroyed() || !isDesktopRendererUrl(sender.mainFrame.url)) {
        return;
      }
      sender.send(DESKTOP_CHATGPT_LOGIN_PROGRESS_CHANNEL, {
        operationId,
        phase,
      });
    } catch {
      return;
    }
  };
  options.ipcMain.handle(DESKTOP_CREDENTIAL_STATUS_CHANNEL, async (event, ...args) => {
    requireTrusted(event);
    if (args.length !== 0) throw new TypeError();
    options.claudeCli.invalidateProbeCache();
    try {
      return minimizeStatuses(await options.vault.credentialStatuses());
    } catch {
      return DESKTOP_CREDENTIAL_SLOTS.map((slot) => ({
        slot,
        state: "re-prompt" as const,
        runtimeState: null,
      }));
    }
  });
  options.ipcMain.handle(DESKTOP_CREDENTIAL_RETRY_CHANNEL, async (event, ...args) => {
    requireTrusted(event);
    if (args.length !== 0) throw new TypeError();
    await options.vault.retryFailed();
    return minimizeStatuses(await options.vault.credentialStatuses());
  });
  options.ipcMain.handle(DESKTOP_CREDENTIAL_WRITE_CHANNEL, async (event, ...args) => {
    requireTrusted(event);
    if (args.length !== 1) throw new TypeError();
    const input = parseWriteInput(args[0]);
    try {
      if (input.slot === "intervals-icu") {
        const ownership = await options
          .checkIntervalsCredentialOwner(input.value)
          .catch(() => "check-unavailable" as const);
        if (ownership === "mismatch") {
          return {
            slot: input.slot,
            status: "refused",
            reason: "training-account-mismatch",
          };
        }
      }
      const stored =
        input.slot !== "intervals-icu" && input.selection === undefined
          ? await options.vault.writeCredential(input, { activate: false })
          : await options.vault.writeCredential(input);
      return minimizeWrite(stored);
    } catch {
      return { slot: input.slot, status: "refused", reason: "storage-failed" };
    }
  });
  options.ipcMain.handle(DESKTOP_CREDENTIAL_DELETE_CHANNEL, async (event, ...args) => {
    requireTrusted(event);
    if (args.length !== 1) throw new TypeError();
    const credential = parseDeleteInput(args[0]);
    if (credential === CHATGPT_PROFILE_NAME) {
      return minimizeDelete(credential, await options.chatGptAuth.deleteCredential());
    }
    const statuses = await options.vault.credentialStatuses();
    const local = statuses.find((status) => status.slot === credential);
    if (local?.state === "missing") {
      let active = false;
      try {
        const snapshot = await options.getRuntimeConfig();
        active =
          credential === "intervals-icu"
            ? snapshot.intervals.credential_configured
            : snapshot.llm.provider === credential && snapshot.llm.credential_configured;
      } catch {
        return {
          credential,
          status: "refused",
          reason: "runtime-unavailable",
        };
      }
      return {
        credential,
        status: "refused",
        reason: active ? "managed-by-environment" : "not-found",
      };
    }
    return minimizeDelete(credential, await options.vault.deleteCredential(credential));
  });
  options.ipcMain.handle(DESKTOP_CREDENTIAL_RECOVERY_STATUS_CHANNEL, async (event, ...args) => {
    requireTrusted(event);
    if (args.length !== 0) throw new TypeError();
    return await options.credentialRecoveryStatus();
  });
  options.ipcMain.handle(DESKTOP_CREDENTIAL_RECOVERY_RETRY_CHANNEL, async (event, ...args) => {
    requireTrusted(event);
    if (args.length !== 0) throw new TypeError();
    return await options.retryCredentialRecovery();
  });
  options.ipcMain.handle(DESKTOP_CREDENTIAL_RESET_CHANNEL, async (event, ...args) => {
    requireTrusted(event);
    if (args.length !== 0) throw new TypeError();
    return await options.resetAllCredentials();
  });
  options.ipcMain.handle(DESKTOP_LLM_CONFIGURATION_CHANNEL, async (event, ...args) => {
    requireTrusted(event);
    if (args.length !== 0) throw new TypeError();
    return llmConfiguration(options.getRuntimeConfig);
  });
  options.ipcMain.handle(DESKTOP_LLM_SELECTION_APPLY_CHANNEL, async (event, ...args) => {
    requireTrusted(event);
    if (args.length !== 1) throw new TypeError();
    let selection: OnboardingLlmSelection;
    try {
      selection = parseOnboardingLlmSelection(args[0]);
    } catch {
      return { status: "refused", reason: "invalid-input" };
    }
    const chatGptActivationSignal =
      selection.provider === "openai-codex"
        ? AbortSignal.timeout(options.chatGptActivationTimeoutMs ?? CHATGPT_ACTIVATION_TIMEOUT_MS)
        : undefined;
    try {
      let existingSelection: boolean | Promise<boolean>;
      if (chatGptActivationSignal === undefined) {
        existingSelection = options.applyExistingLlmSelection(selection);
      } else {
        const runtime = await withAbort(options.getRuntimeConfig(), chatGptActivationSignal);
        existingSelection =
          runtime.llm.provider === selection.provider && runtime.llm.credential_configured
            ? withAbort(
                options.applyExistingLlmSelection(selection, chatGptActivationSignal),
                chatGptActivationSignal,
              )
            : false;
      }
      if (await existingSelection) {
        return { status: "configured", runtimeReady: true };
      }
      if (chatGptActivationSignal !== undefined) {
        const hasStoredProfile = await withAbort(
          options.chatGptAuth.hasStoredProfile(),
          chatGptActivationSignal,
        );
        if (!hasStoredProfile) {
          return { status: "refused", reason: "credential-required" };
        }
        return minimizeSelection(
          await options.chatGptAuth.activate(
            parseChatGptLlmSelection(selection),
            chatGptActivationSignal,
          ),
        );
      }
      if (selection.provider === "claude-cli") {
        return minimizeSelection(
          await options.claudeCli.activate(parseClaudeCliLlmSelection(selection)),
        );
      }
      return minimizeSelection(await options.vault.applyLlmSelection(selection));
    } catch {
      return { status: "refused", reason: "runtime-unavailable" };
    }
  });
  options.ipcMain.handle(DESKTOP_CHATGPT_STATUS_CHANNEL, async (event, ...args) => {
    requireTrusted(event);
    if (args.length !== 0) throw new TypeError();
    return minimizeChatGptStatus(await options.chatGptAuth.status());
  });
  options.ipcMain.handle(DESKTOP_CHATGPT_LOGIN_CHANNEL, async (event, ...args) => {
    requireTrusted(event);
    if (args.length !== 1) throw new TypeError();
    const input = parseChatGptLoginInput(args[0]);
    return minimizeChatGptLogin(
      await options.chatGptAuth.login(input.operationId, input.selection, (phase) => {
        publishChatGptProgress(event.sender, input.operationId, phase);
      }),
    );
  });
  options.ipcMain.handle(DESKTOP_CHATGPT_LOGIN_CANCEL_CHANNEL, (event, ...args) => {
    requireTrusted(event);
    if (args.length !== 1) throw new TypeError();
    const input = parseChatGptCancelInput(args[0]);
    return minimizeChatGptCancel(options.chatGptAuth.cancelLogin(input.operationId));
  });
  options.ipcMain.handle(DESKTOP_CLAUDE_CLI_STATUS_CHANNEL, async (event, ...args) => {
    requireTrusted(event);
    if (args.length !== 0) throw new TypeError();
    return minimizeClaudeCliStatus(await options.claudeCli.status());
  });
  options.ipcMain.handle(DESKTOP_CLAUDE_CLI_RECHECK_CHANNEL, async (event, ...args) => {
    requireTrusted(event);
    if (args.length !== 0) throw new TypeError();
    return minimizeClaudeCliStatus(await options.claudeCli.recheck());
  });
  options.ipcMain.handle(DESKTOP_CHOOSE_IMPORT_FILES_CHANNEL, async (event, ...args) => {
    requireTrusted(event);
    if (args.length !== 0) throw new TypeError();
    let result: Awaited<ReturnType<OnboardingDialogPort["showOpenDialog"]>>;
    try {
      result = await options.dialog.showOpenDialog(options.window, {
        defaultPath: homedir(),
        properties: ["openFile", "multiSelections"],
        filters: [{ name: "Ride files", extensions: ["fit", "tcx", "gpx"] }],
      });
    } catch {
      return [];
    }
    if (result.canceled) return [];
    return result.filePaths.filter(
      (path) =>
        typeof path === "string" &&
        path.length <= 4_096 &&
        isAbsolute(path) &&
        SUPPORTED_EXTENSIONS.has(extname(path).toLowerCase()),
    );
  });
  return () => {
    disposed = true;
    options.ipcMain.removeHandler(DESKTOP_CREDENTIAL_STATUS_CHANNEL);
    options.ipcMain.removeHandler(DESKTOP_CREDENTIAL_RETRY_CHANNEL);
    options.ipcMain.removeHandler(DESKTOP_CREDENTIAL_WRITE_CHANNEL);
    options.ipcMain.removeHandler(DESKTOP_CREDENTIAL_DELETE_CHANNEL);
    options.ipcMain.removeHandler(DESKTOP_CREDENTIAL_RECOVERY_STATUS_CHANNEL);
    options.ipcMain.removeHandler(DESKTOP_CREDENTIAL_RECOVERY_RETRY_CHANNEL);
    options.ipcMain.removeHandler(DESKTOP_CREDENTIAL_RESET_CHANNEL);
    options.ipcMain.removeHandler(DESKTOP_LLM_CONFIGURATION_CHANNEL);
    options.ipcMain.removeHandler(DESKTOP_LLM_SELECTION_APPLY_CHANNEL);
    options.ipcMain.removeHandler(DESKTOP_CHATGPT_STATUS_CHANNEL);
    options.ipcMain.removeHandler(DESKTOP_CHATGPT_LOGIN_CHANNEL);
    options.ipcMain.removeHandler(DESKTOP_CHATGPT_LOGIN_CANCEL_CHANNEL);
    options.ipcMain.removeHandler(DESKTOP_CLAUDE_CLI_STATUS_CHANNEL);
    options.ipcMain.removeHandler(DESKTOP_CLAUDE_CLI_RECHECK_CHANNEL);
    options.ipcMain.removeHandler(DESKTOP_CHOOSE_IMPORT_FILES_CHANNEL);
  };
}
