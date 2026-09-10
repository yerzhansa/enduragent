import {
  CoachRpcRemoteError,
  connectCoachClient,
  type CoachClient,
} from "@enduragent/coach-client";
import {
  isKeylessProvider,
  type ConfigureRuntimeRpcParams,
  type GetLanguagePreferenceRpcResult,
  type LlmProvider,
  type RuntimeConfigSnapshot,
  type VerifyIntervalsCredentialRpcResult,
} from "@enduragent/coach-contract";
import { CHATGPT_PROFILE_NAME } from "./chatgpt-auth.js";
import {
  CredentialRuntimeRefusal,
  type CredentialRuntimeState,
  type DesktopCredentialSlot,
} from "./credential-vault.js";
import { runtimeConfigurationForCredential } from "./onboarding-ipc.js";

export type DesktopManagedCredential = DesktopCredentialSlot | typeof CHATGPT_PROFILE_NAME;

export interface LlmProviderSelectionEvidence {
  readonly chatGptProfilePresent: boolean;
  readonly storedCredentialSlots: readonly DesktopCredentialSlot[];
}

export interface CredentialRuntimeApplication {
  applyExplicit(
    request: ConfigureRuntimeRpcParams,
    signal?: AbortSignal,
    verificationApproval?: string,
  ): Promise<void>;
  applyExistingLlmSelection(
    provider: LlmProvider,
    request: ConfigureRuntimeRpcParams,
    signal?: AbortSignal,
  ): Promise<boolean>;
  reapplyStoredCredential(
    slot: DesktopCredentialSlot,
    value: string,
    storedCredentialSlots: readonly DesktopCredentialSlot[],
  ): Promise<Exclude<CredentialRuntimeState, "failed">>;
  clearCredential(
    credential: DesktopManagedCredential,
  ): Promise<"cleared" | "not-active" | "managed-by-environment">;
}

export function applyExplicitCredentialToRuntime(
  runtime: Pick<CredentialRuntimeApplication, "applyExplicit">,
  request: ConfigureRuntimeRpcParams,
  verificationApproval?: string,
): Promise<void> {
  if (verificationApproval === undefined) return runtime.applyExplicit(request);
  return runtime.applyExplicit(request, undefined, verificationApproval);
}

interface CredentialRuntimeApplicationOptions {
  readonly selectedLlmProvider: (
    storedCredentialSlots: readonly DesktopCredentialSlot[],
  ) => Promise<LlmProvider | undefined>;
  readonly configureRuntime: (
    request: ConfigureRuntimeRpcParams,
    signal?: AbortSignal,
  ) => Promise<void>;
  readonly clearRuntimeCredential?: (
    credential: DesktopManagedCredential,
  ) => Promise<"cleared" | "not-active" | "managed-by-environment">;
}

export interface RuntimeConfigurationAuthority {
  getLanguagePreference?(signal?: AbortSignal): Promise<GetLanguagePreferenceRpcResult>;
  configureRuntime(request: ConfigureRuntimeRpcParams, signal?: AbortSignal): Promise<void>;
  verifyIntervalsCredential(
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<VerifyIntervalsCredentialRpcResult>;
  clearCredential(
    credential: DesktopManagedCredential,
  ): Promise<"cleared" | "not-active" | "managed-by-environment">;
  getRuntimeConfig(signal?: AbortSignal): Promise<RuntimeConfigSnapshot>;
}

export interface ActiveIntervalsCredentialBinding {
  readonly authority: Pick<RuntimeConfigurationAuthority, "verifyIntervalsCredential">;
}

export interface ActiveIntervalsCredentialLifecycleSnapshot {
  readonly status: string;
  readonly generation?: number;
}

export function createActiveIntervalsCredentialPreflight(input: {
  readonly currentBinding: () => ActiveIntervalsCredentialBinding | undefined;
  readonly lifecycleSnapshot: () => ActiveIntervalsCredentialLifecycleSnapshot | undefined;
}): (
  apiKey: string,
  signal: AbortSignal,
) => Promise<VerifyIntervalsCredentialRpcResult | undefined> {
  return async (apiKey, signal) => {
    const binding = input.currentBinding();
    const lifecycleState = input.lifecycleSnapshot();
    if (
      binding === undefined ||
      lifecycleState?.status !== "ready" ||
      typeof lifecycleState.generation !== "number"
    ) {
      return undefined;
    }
    let result: VerifyIntervalsCredentialRpcResult;
    try {
      result = await binding.authority.verifyIntervalsCredential(apiKey, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof CoachRpcRemoteError && error.code === -32601) return undefined;
      throw error;
    }
    const currentLifecycleState = input.lifecycleSnapshot();
    if (
      input.currentBinding() !== binding ||
      currentLifecycleState?.status !== "ready" ||
      currentLifecycleState.generation !== lifecycleState.generation
    ) {
      throw new TypeError();
    }
    return result;
  };
}

export function runtimeConfigurationForCredentialDeletion(
  credential: DesktopManagedCredential,
): ConfigureRuntimeRpcParams {
  return credential === "intervals-icu"
    ? { intervals: { clear_credential: true } }
    : { llm: { provider: credential, clear_credential: true } };
}

export function intervalsAthleteIdForOwnership(snapshot: RuntimeConfigSnapshot): string {
  return snapshot.intervals.athlete_id === "" ? "0" : snapshot.intervals.athlete_id;
}

export function readSelectedLlmProvider(
  snapshot: RuntimeConfigSnapshot,
  evidence: LlmProviderSelectionEvidence,
): LlmProvider | undefined {
  const provider = snapshot.llm.provider;
  if (snapshot.llm.credential_configured) return provider;
  if (provider === CHATGPT_PROFILE_NAME) {
    return evidence.chatGptProfilePresent ? provider : undefined;
  }
  if (isKeylessProvider(provider)) return provider;
  return evidence.storedCredentialSlots.includes(provider) ? provider : undefined;
}

export function createConnectionRuntimeAuthority(
  connection: Readonly<{
    url: `ws://127.0.0.1:${number}/rpc`;
    token: string;
    athleteHome: string;
  }>,
  connect: typeof connectCoachClient = connectCoachClient,
): RuntimeConfigurationAuthority {
  const call = async <T>(
    operation: (client: CoachClient) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> => {
    signal?.throwIfAborted();
    const client = await connect({
      url: connection.url,
      token: connection.token,
      expectedAthleteHome: connection.athleteHome,
      ...(signal === undefined ? {} : { signal }),
    });
    try {
      return (await operation(client)) as T;
    } finally {
      await client.close();
    }
  };
  return {
    async configureRuntime(request, signal) {
      const result = await call(
        (client) =>
          signal === undefined
            ? client.call("configureRuntime", request)
            : client.call("configureRuntime", request, { signal }),
        signal,
      );
      if ("status" in result && result.status === "refused") {
        throw new CredentialRuntimeRefusal(result.reason);
      }
      if (
        !("status" in result) ||
        result.status !== "applied" ||
        (request.llm !== undefined && !result.applied.llm) ||
        (request.intervals !== undefined && !result.applied.intervals) ||
        (request.session !== undefined && !result.applied.session)
      ) {
        throw new TypeError();
      }
    },
    async clearCredential(credential) {
      const request = runtimeConfigurationForCredentialDeletion(credential);
      const result = await call((client) => client.call("configureRuntime", request));
      if ("status" in result && result.status === "refused") {
        if (result.reason === "managed-by-environment") return "managed-by-environment";
        if (result.reason === "credential-required") return "not-active";
        throw new TypeError();
      }
      if (
        !("status" in result) ||
        result.status !== "applied" ||
        result.applied.llm !== (request.llm !== undefined) ||
        result.applied.intervals !== (request.intervals !== undefined) ||
        result.applied.session
      ) {
        throw new TypeError();
      }
      return "cleared";
    },
    verifyIntervalsCredential(apiKey, signal) {
      return call(
        (client) =>
          signal === undefined
            ? client.call("verify_intervals_credential", { api_key: apiKey })
            : client.call("verify_intervals_credential", { api_key: apiKey }, { signal }),
        signal,
      );
    },
    getLanguagePreference(signal) {
      return call((client) => client.call("getLanguagePreference", {}, { signal }), signal);
    },
    getRuntimeConfig(signal) {
      return call(
        (client) =>
          signal === undefined
            ? client.call("getRuntimeConfig", {})
            : client.call("getRuntimeConfig", {}, { signal }),
        signal,
      );
    },
  };
}

export function createCredentialRuntimeApplication(
  options: CredentialRuntimeApplicationOptions,
): CredentialRuntimeApplication {
  let pending: Promise<void> = Promise.resolve();

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = pending.then(operation);
    pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const settleWithSignal = async <T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> => {
    if (signal === undefined) return await operation;
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
  };

  return {
    applyExplicit(request, signal, verificationApproval) {
      return serialize(() => {
        signal?.throwIfAborted();
        if (verificationApproval === undefined) return options.configureRuntime(request, signal);
        if (
          !/^[0-9a-f]{64}$/.test(verificationApproval) ||
          request.intervals?.api_key === undefined
        ) {
          throw new TypeError();
        }
        return options.configureRuntime(
          {
            ...request,
            intervals: {
              ...request.intervals,
              verification_approval: verificationApproval,
            },
          },
          signal,
        );
      });
    },
    applyExistingLlmSelection(provider, request, signal) {
      return serialize(async () => {
        signal?.throwIfAborted();
        if (request.llm === undefined || request.llm.provider !== undefined) throw new TypeError();
        const selectedProvider = await settleWithSignal(options.selectedLlmProvider([]), signal);
        if (selectedProvider !== provider) return false;
        signal?.throwIfAborted();
        await settleWithSignal(
          signal === undefined
            ? options.configureRuntime(request)
            : options.configureRuntime(request, signal),
          signal,
        );
        return true;
      });
    },
    reapplyStoredCredential(slot, value, storedCredentialSlots) {
      return serialize(async () => {
        const request = runtimeConfigurationForCredential(slot, value);
        const selectedProvider = await options.selectedLlmProvider(storedCredentialSlots);
        if (request.llm !== undefined && selectedProvider !== undefined) {
          if (selectedProvider !== request.llm.provider) return "stored-inactive";
        }
        await options.configureRuntime(request);
        return "active";
      });
    },
    clearCredential(credential) {
      return serialize(() => {
        if (options.clearRuntimeCredential === undefined) throw new TypeError();
        return options.clearRuntimeCredential(credential);
      });
    },
  };
}
