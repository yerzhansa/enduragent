import { join } from "node:path";
import {
  CodexLoginError,
  deleteStoredProfile,
  loadStoredProfileSnapshot,
  loginCodex,
  recoverAndSaveStoredProfile,
  type CodexCredentials,
  type CodexLoginProgressPhase,
  type CodexLoginOptions,
} from "@enduragent/core";
import type { ConfigureRuntimeRpcParams, RuntimeConfigSnapshot } from "@enduragent/coach-contract";
import {
  parseChatGptLlmSelection,
  runtimeConfigurationForSelection,
  type OnboardingLlmSelection,
  type OnboardingLlmSelectionResult,
} from "./llm-selection.js";
import type { SerializeCredentialMutation } from "./credential-envelope-lock.js";

export const CHATGPT_PROFILE_NAME = "openai-codex" as const;
export const CHATGPT_ACTIVATION_TIMEOUT_MS = 10_000;

export type ChatGptLoginProgressPhase = CodexLoginProgressPhase;

export type ChatGptLoginRefusalReason =
  | "already-in-progress"
  | "callback-unavailable"
  | "timed-out"
  | "cancelled"
  | "exchange-failed"
  | "storage-failed"
  | "runtime-unavailable";

export interface ChatGptStatus {
  readonly state: "configured" | "absent";
  readonly runtimeReady: boolean;
}

export type ChatGptLoginResult =
  | { readonly status: "stored"; readonly operationId: string }
  | {
      readonly status: "refused";
      readonly operationId: string;
      readonly reason: ChatGptLoginRefusalReason;
    };

export type ChatGptCancelLoginResult = {
  readonly status: "cancelling" | "not-active";
  readonly operationId: string;
};

export type ChatGptDeleteResult =
  | { readonly status: "deleted"; readonly cleanupPending: false }
  | {
      readonly status: "refused";
      readonly reason:
        | "not-found"
        | "storage-failed"
        | "runtime-unavailable"
        | "runtime-state-diverged";
    };

export interface ChatGptAuthController {
  hasStoredProfile(): Promise<boolean>;
  status(): Promise<ChatGptStatus>;
  login(
    operationId: string,
    selection: OnboardingLlmSelection,
    onProgress?: (phase: ChatGptLoginProgressPhase) => void,
  ): Promise<ChatGptLoginResult>;
  cancelLogin(operationId: string): ChatGptCancelLoginResult;
  activate(
    selection: OnboardingLlmSelection,
    signal?: AbortSignal,
  ): Promise<OnboardingLlmSelectionResult>;
  deleteCredential(): Promise<ChatGptDeleteResult>;
}

interface ChatGptAuthDependencies {
  readonly loginCodex?: (options: CodexLoginOptions) => Promise<CodexCredentials>;
  readonly writeProfile?: (configDir: string, credentials: CodexCredentials) => Promise<void>;
  readonly deleteProfile?: (configDir: string) => void;
}

interface CreateChatGptAuthOptions {
  readonly configDir: string;
  readonly applyRuntimeConfig: (
    request: ConfigureRuntimeRpcParams,
    signal?: AbortSignal,
  ) => Promise<void>;
  readonly getRuntimeConfig: () => Promise<RuntimeConfigSnapshot>;
  readonly clearRuntimeCredential?: () => Promise<
    "cleared" | "not-active" | "managed-by-environment"
  >;
  readonly openExternal: (url: string) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly authorizationTimeoutMs?: number;
  readonly tokenExchangeTimeoutMs?: number;
  readonly activationTimeoutMs?: number;
  readonly serializeCredentialMutation?: SerializeCredentialMutation;
  readonly dependencies?: ChatGptAuthDependencies;
}

class ChatGptAuthFlowError extends Error {
  constructor(readonly reason: "callback-unavailable" | "cancelled") {
    super(reason);
    this.name = "ChatGptAuthFlowError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validProfile(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    value.type === "oauth" &&
    typeof value.access === "string" &&
    value.access.length > 0 &&
    typeof value.refresh === "string" &&
    value.refresh.length > 0 &&
    typeof value.expires === "number" &&
    Number.isFinite(value.expires) &&
    (value.accountId === undefined || typeof value.accountId === "string") &&
    (value.email === undefined || typeof value.email === "string")
  );
}

export async function hasChatGptProfile(configDir: string): Promise<boolean> {
  try {
    const snapshot = loadStoredProfileSnapshot(
      join(configDir, "auth-profiles.json"),
      CHATGPT_PROFILE_NAME,
    );
    return snapshot !== null && validProfile(snapshot.profile);
  } catch {
    return false;
  }
}

export async function writeChatGptProfile(
  configDir: string,
  credentials: CodexCredentials,
): Promise<void> {
  recoverAndSaveStoredProfile(join(configDir, "auth-profiles.json"), CHATGPT_PROFILE_NAME, {
    type: "oauth",
    access: credentials.access,
    refresh: credentials.refresh,
    expires: credentials.expires,
    ...(credentials.accountId.length > 0 ? { accountId: credentials.accountId } : {}),
    ...(credentials.email !== undefined ? { email: credentials.email } : {}),
  });
}

export function deleteChatGptProfile(configDir: string): void {
  deleteStoredProfile(join(configDir, "auth-profiles.json"), CHATGPT_PROFILE_NAME);
}

async function configuredRuntime(
  getRuntimeConfig: () => Promise<RuntimeConfigSnapshot>,
): Promise<boolean | undefined> {
  try {
    const llm = (await getRuntimeConfig()).llm;
    return llm.provider === CHATGPT_PROFILE_NAME && llm.credential_configured;
  } catch {
    return undefined;
  }
}

function classifyLoginFailure(
  error: unknown,
  attemptSignal: AbortSignal,
  sessionSignal: AbortSignal | undefined,
): ChatGptLoginRefusalReason {
  if (error instanceof ChatGptAuthFlowError) return error.reason;
  if (attemptSignal.aborted || sessionSignal?.aborted) return "cancelled";
  if (
    (typeof CodexLoginError === "function" && error instanceof CodexLoginError) ||
    (isRecord(error) &&
      error.name === "CodexLoginError" &&
      (error.reason === "authorization-timed-out" ||
        error.reason === "token-exchange-timed-out" ||
        error.reason === "token-exchange-failed"))
  ) {
    return error.reason === "authorization-timed-out" ? "timed-out" : "exchange-failed";
  }
  if (isRecord(error) && error.name === "AbortError") return "cancelled";
  return "exchange-failed";
}

function validOperationId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
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

export function createChatGptAuth(options: CreateChatGptAuthOptions): ChatGptAuthController {
  const runLogin = options.dependencies?.loginCodex ?? loginCodex;
  const storeProfile = options.dependencies?.writeProfile ?? writeChatGptProfile;
  const removeProfile = options.dependencies?.deleteProfile ?? deleteChatGptProfile;
  const serializeCredentialMutation: SerializeCredentialMutation =
    options.serializeCredentialMutation ?? ((operation) => operation());
  let activeLogin:
    | {
        readonly operationId: string;
        readonly controller: AbortController;
        readonly promise: Promise<ChatGptLoginResult>;
      }
    | undefined;

  const applySelection = async (
    selection: OnboardingLlmSelection,
    activationSignal?: AbortSignal,
  ): Promise<OnboardingLlmSelectionResult> => {
    let parsed: ReturnType<typeof parseChatGptLlmSelection>;
    try {
      parsed = parseChatGptLlmSelection(selection);
    } catch {
      return { status: "refused", reason: "invalid-input" };
    }
    if (!(await hasChatGptProfile(options.configDir))) {
      return { status: "refused", reason: "credential-required" };
    }
    const timeoutSignal = AbortSignal.timeout(
      options.activationTimeoutMs ?? CHATGPT_ACTIVATION_TIMEOUT_MS,
    );
    const signals = [timeoutSignal];
    if (options.signal !== undefined) signals.push(options.signal);
    if (activationSignal !== undefined) signals.push(activationSignal);
    const signal = signals.length === 1 ? timeoutSignal : AbortSignal.any(signals);
    try {
      signal.throwIfAborted();
      await withAbort(
        options.applyRuntimeConfig(runtimeConfigurationForSelection(parsed), signal),
        signal,
      );
    } catch {
      return { status: "refused", reason: "runtime-unavailable" };
    }
    return { status: "configured", runtimeReady: true };
  };

  const performLogin = async (
    operationId: string,
    attemptController: AbortController,
    onProgress?: (phase: ChatGptLoginProgressPhase) => void,
  ): Promise<ChatGptLoginResult> => {
    const signal =
      options.signal === undefined
        ? attemptController.signal
        : AbortSignal.any([options.signal, attemptController.signal]);
    let credentials: CodexCredentials;
    try {
      credentials = await runLogin({
        originator: "enduragent-desktop",
        signal,
        ...(options.authorizationTimeoutMs === undefined
          ? {}
          : { authorizationTimeoutMs: options.authorizationTimeoutMs }),
        ...(options.tokenExchangeTimeoutMs === undefined
          ? {}
          : { tokenExchangeTimeoutMs: options.tokenExchangeTimeoutMs }),
        onProgress: (phase) => {
          if (!signal.aborted) onProgress?.(phase);
        },
        onAuth: ({ url, callbackAvailable }) => {
          if (callbackAvailable === false) return;
          void options.openExternal(url).catch(() => {
            attemptController.abort(new ChatGptAuthFlowError("cancelled"));
          });
        },
        onPrompt: async () => {
          throw new ChatGptAuthFlowError("callback-unavailable");
        },
      });
    } catch (error) {
      return {
        status: "refused",
        operationId,
        reason: classifyLoginFailure(error, attemptController.signal, options.signal),
      };
    }
    try {
      signal.throwIfAborted();
      await storeProfile(options.configDir, credentials);
    } catch {
      if (signal.aborted) {
        return { status: "refused", operationId, reason: "cancelled" };
      }
      return { status: "refused", operationId, reason: "storage-failed" };
    }
    return { status: "stored", operationId };
  };

  return {
    hasStoredProfile: () => hasChatGptProfile(options.configDir),
    async status() {
      const configured = await hasChatGptProfile(options.configDir);
      const runtimeReady = await configuredRuntime(options.getRuntimeConfig);
      return {
        state: configured || runtimeReady === true ? "configured" : "absent",
        runtimeReady: runtimeReady ?? false,
      };
    },
    async login(operationId, input, onProgress) {
      if (!validOperationId(operationId)) throw new TypeError();
      parseChatGptLlmSelection(input);
      if (activeLogin !== undefined) {
        return { status: "refused", operationId, reason: "already-in-progress" };
      }
      const controller = new AbortController();
      const pending = serializeCredentialMutation(() =>
        Promise.resolve().then(() => performLogin(operationId, controller, onProgress)),
      );
      activeLogin = { operationId, controller, promise: pending };
      try {
        return await pending;
      } finally {
        if (activeLogin?.promise === pending) activeLogin = undefined;
      }
    },
    cancelLogin(operationId) {
      if (!validOperationId(operationId)) throw new TypeError();
      const active = activeLogin;
      if (active === undefined || active.operationId !== operationId) {
        return { status: "not-active", operationId };
      }
      active.controller.abort(new DOMException("Cancelled", "AbortError"));
      return { status: "cancelling", operationId };
    },
    activate: (selection, signal) =>
      serializeCredentialMutation(() => applySelection(selection, signal)),
    deleteCredential() {
      return serializeCredentialMutation(async () => {
        const stored = await hasChatGptProfile(options.configDir);
        const runtimeReady = await configuredRuntime(options.getRuntimeConfig);
        if (!stored) {
          return runtimeReady === true
            ? { status: "refused", reason: "runtime-state-diverged" }
            : { status: "refused", reason: "not-found" };
        }
        if (runtimeReady === undefined) {
          return { status: "refused", reason: "runtime-unavailable" };
        }
        if (runtimeReady) {
          if (options.clearRuntimeCredential === undefined) {
            return { status: "refused", reason: "runtime-unavailable" };
          }
          try {
            const cleared = await options.clearRuntimeCredential();
            if (cleared === "not-active") {
              removeProfile(options.configDir);
            } else if (cleared !== "cleared") {
              throw new TypeError();
            }
          } catch {
            return { status: "refused", reason: "runtime-state-diverged" };
          }
        } else {
          try {
            removeProfile(options.configDir);
          } catch {
            return { status: "refused", reason: "storage-failed" };
          }
        }
        if (await hasChatGptProfile(options.configDir)) {
          return { status: "refused", reason: "runtime-state-diverged" };
        }
        return { status: "deleted", cleanupPending: false };
      });
    },
  };
}
