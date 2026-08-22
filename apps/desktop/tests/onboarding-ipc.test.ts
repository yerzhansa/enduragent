import { homedir } from "node:os";
import type { IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeConfigSnapshot } from "@enduragent/coach-contract";
import {
  DESKTOP_CHOOSE_IMPORT_FILES_CHANNEL,
  DESKTOP_CHATGPT_LOGIN_CANCEL_CHANNEL,
  DESKTOP_CHATGPT_LOGIN_CHANNEL,
  DESKTOP_CHATGPT_LOGIN_PROGRESS_CHANNEL,
  DESKTOP_CHATGPT_STATUS_CHANNEL,
  DESKTOP_CLAUDE_CLI_RECHECK_CHANNEL,
  DESKTOP_CLAUDE_CLI_STATUS_CHANNEL,
  DESKTOP_CREDENTIAL_RETRY_CHANNEL,
  DESKTOP_CREDENTIAL_DELETE_CHANNEL,
  DESKTOP_CREDENTIAL_RECOVERY_RETRY_CHANNEL,
  DESKTOP_CREDENTIAL_RECOVERY_STATUS_CHANNEL,
  DESKTOP_CREDENTIAL_RESET_CHANNEL,
  DESKTOP_CREDENTIAL_STATUS_CHANNEL,
  DESKTOP_CREDENTIAL_WRITE_CHANNEL,
  DESKTOP_LLM_CONFIGURATION_CHANNEL,
  DESKTOP_LLM_SELECTION_APPLY_CHANNEL,
  registerOnboardingIpc,
  runtimeConfigurationForCredential,
} from "../src/main/onboarding-ipc.js";
import { createDesktopRendererUrl } from "../src/main/renderer-navigation.js";
import {
  runtimeConfigurationForExistingSelection,
  type OnboardingLlmSelection,
  type OnboardingLlmSelectionResult,
} from "../src/main/llm-selection.js";
import type {
  CredentialVault,
  CredentialWriteBehavior,
  CredentialWriteInput,
} from "../src/main/credential-vault.js";

const RENDERER_URL = createDesktopRendererUrl("A".repeat(43));

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
type OwnershipCheck = (
  value: string,
) => Promise<"unowned" | "matched" | "mismatch" | "unresolved" | "store-unavailable">;

function runtimeConfigSnapshot(
  provider: RuntimeConfigSnapshot["llm"]["provider"] = "anthropic",
  credentialConfigured = true,
): RuntimeConfigSnapshot {
  return {
    schemaVersion: 3,
    llm: {
      provider,
      model: "athlete-selected-model",
      credential_configured: credentialConfigured,
    },
    intervals: {
      athlete_id: "synthetic-athlete",
      credential_configured: true,
      managedByEnvironment: { athleteId: false },
    },
    session: {
      historyTokenBudgetRatio: 0.3,
      idleMinutes: 0,
      dailyResetHour: 4,
      resetArchiveRetentionDays: 0,
      timezone: "UTC",
      managedByEnvironment: {
        historyTokenBudgetRatio: false,
        idleMinutes: false,
        dailyResetHour: false,
        resetArchiveRetentionDays: false,
        timezone: false,
      },
    },
  };
}

function harness(
  checkIntervalsCredentialOwner: OwnershipCheck = vi.fn(async () => "unresolved" as const),
  chatGptActivationTimeoutMs?: number,
) {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  };
  const vault: CredentialVault = {
    writeCredential: vi.fn(async (input, behavior) => ({
      slot: input.slot,
      status: "configured" as const,
      runtimeReady: behavior?.activate !== false,
    })),
    runExclusiveMutation: vi.fn(async (operation) =>
      operation({
        writeCredential: (input: CredentialWriteInput, behavior?: CredentialWriteBehavior) =>
          vault.writeCredential(input, behavior),
        credentialStatuses: () => vault.credentialStatuses(),
      }),
    ),
    applyLlmSelection: vi.fn(async () => ({
      status: "configured" as const,
      runtimeReady: true as const,
    })),
    credentialStatuses: vi.fn(async () => [
      {
        slot: "anthropic" as const,
        state: "configured" as const,
        runtimeState: "active" as const,
      },
    ]),
    deleteCredential: vi.fn(async (slot) => ({
      slot,
      status: "deleted" as const,
      cleanupPending: false,
    })),
    reapplyConfigured: vi.fn(async () => {}),
    retryFailed: vi.fn(async () => {}),
  };
  const dialog = {
    showOpenDialog: vi.fn(async () => ({
      canceled: false,
      filePaths: ["/synthetic/ride.fit", "/synthetic/ride.txt", "relative.tcx"],
    })),
  };
  const chatGptAuth = {
    hasStoredProfile: vi.fn(async () => true),
    status: vi.fn(async () => ({ state: "configured" as const, runtimeReady: true })),
    login: vi.fn(
      async (
        operationId: string,
        _selection: unknown,
        _onProgress?: (phase: "waiting-for-browser" | "completing-sign-in") => void,
      ) => ({ status: "stored" as const, operationId }),
    ),
    cancelLogin: vi.fn((operationId: string) => ({
      status: "cancelling" as const,
      operationId,
    })),
    activate: vi.fn(
      async (
        _selection: OnboardingLlmSelection,
        _signal?: AbortSignal,
      ): Promise<OnboardingLlmSelectionResult> => ({
        status: "configured",
        runtimeReady: true,
      }),
    ),
    deleteCredential: vi.fn(async () => ({
      status: "deleted" as const,
      cleanupPending: false as const,
    })),
  };
  const claudeCli = {
    status: vi.fn(async () => ({
      state: "ready" as const,
      email: "athlete@synthetic.test",
      plan: "Max",
      version: "2.9.0",
    })),
    recheck: vi.fn(async () => ({ state: "not-logged-in" as const })),
    invalidateProbeCache: vi.fn(),
    activate: vi.fn(async () => ({ status: "configured" as const, runtimeReady: true as const })),
  };
  const getRuntimeConfig = vi.fn(async () => runtimeConfigSnapshot());
  const applyExistingLlmSelection = vi.fn(
    async (_selection: OnboardingLlmSelection, _signal?: AbortSignal) => false,
  );
  const credentialRecoveryStatus = vi.fn(async () => ({
    state: "locked" as const,
  }));
  const retryCredentialRecovery = vi.fn(async () => ({
    state: "ready" as const,
    unverifiedEnvelopes: 2,
  }));
  const resetAllCredentials = vi.fn(async () => ({
    status: "reset" as const,
    keyCleanupPending: false,
  }));
  const progressSend = vi.fn();
  const trustedEvent = {
    sender: {
      isDestroyed: () => false,
      mainFrame: { url: RENDERER_URL },
      send: progressSend,
    },
  } as unknown as IpcMainInvokeEvent;
  const dispose = registerOnboardingIpc({
    ipcMain: ipcMain as never,
    dialog,
    window: {} as never,
    vault,
    chatGptAuth,
    claudeCli,
    getRuntimeConfig,
    applyExistingLlmSelection,
    ...(chatGptActivationTimeoutMs === undefined ? {} : { chatGptActivationTimeoutMs }),
    isTrusted: (event) => event === trustedEvent,
    checkIntervalsCredentialOwner,
    credentialRecoveryStatus,
    retryCredentialRecovery,
    resetAllCredentials,
  });
  const invoke = (channel: string, event: IpcMainInvokeEvent, ...args: unknown[]) =>
    handlers.get(channel)!(event, ...args);
  return {
    handlers,
    ipcMain,
    vault,
    chatGptAuth,
    claudeCli,
    getRuntimeConfig,
    applyExistingLlmSelection,
    dialog,
    checkIntervalsCredentialOwner,
    progressSend,
    credentialRecoveryStatus,
    retryCredentialRecovery,
    resetAllCredentials,
    trustedEvent,
    dispose,
    invoke,
  };
}

describe("desktop onboarding IPC", () => {
  it("exposes trusted recovery, retry, and explicit reset operations", async () => {
    const subject = harness();

    await expect(
      subject.invoke(DESKTOP_CREDENTIAL_RECOVERY_STATUS_CHANNEL, subject.trustedEvent),
    ).resolves.toEqual({ state: "locked" });
    await expect(
      subject.invoke(DESKTOP_CREDENTIAL_RECOVERY_RETRY_CHANNEL, subject.trustedEvent),
    ).resolves.toEqual({ state: "ready", unverifiedEnvelopes: 2 });
    await expect(
      subject.invoke(DESKTOP_CREDENTIAL_RESET_CHANNEL, subject.trustedEvent),
    ).resolves.toEqual({ status: "reset", keyCleanupPending: false });
    expect(subject.credentialRecoveryStatus).toHaveBeenCalledOnce();
    expect(subject.retryCredentialRecovery).toHaveBeenCalledOnce();
    expect(subject.resetAllCredentials).toHaveBeenCalledOnce();
  });

  it("refuses an intervals.icu credential for a different training account", async () => {
    const subject = harness(vi.fn(async () => "mismatch" as const));

    await expect(
      subject.invoke(DESKTOP_CREDENTIAL_WRITE_CHANNEL, subject.trustedEvent, {
        slot: "intervals-icu",
        value: "synthetic",
      }),
    ).resolves.toEqual({
      slot: "intervals-icu",
      status: "refused",
      reason: "training-account-mismatch",
    });
    expect(subject.checkIntervalsCredentialOwner).toHaveBeenCalledWith("synthetic");
    expect(subject.vault.writeCredential).not.toHaveBeenCalled();
  });

  it.each([
    ["the same training account", "matched"],
    ["a readable ownerless store", "unowned"],
    ["an unresolved identity", "unresolved"],
    ["an unavailable store", "store-unavailable"],
  ] as const)("saves an intervals.icu credential for %s", async (_case, outcome) => {
    const subject = harness(vi.fn(async () => outcome));

    await expect(
      subject.invoke(DESKTOP_CREDENTIAL_WRITE_CHANNEL, subject.trustedEvent, {
        slot: "intervals-icu",
        value: "synthetic",
      }),
    ).resolves.toEqual({
      slot: "intervals-icu",
      status: "configured",
      runtimeReady: true,
    });
    expect(subject.vault.writeCredential).toHaveBeenCalledOnce();
  });

  it("saves an intervals.icu credential when the convenience check fails", async () => {
    const subject = harness(
      vi.fn(async () => {
        throw new Error("check unavailable");
      }),
    );

    await expect(
      subject.invoke(DESKTOP_CREDENTIAL_WRITE_CHANNEL, subject.trustedEvent, {
        slot: "intervals-icu",
        value: "synthetic",
      }),
    ).resolves.toMatchObject({ status: "configured" });
    expect(subject.vault.writeCredential).toHaveBeenCalledOnce();
  });

  it("maps each credential slot to the landed runtime request", () => {
    expect(runtimeConfigurationForCredential("anthropic", "synthetic")).toEqual({
      llm: { provider: "anthropic", api_key: "synthetic" },
    });
    expect(runtimeConfigurationForCredential("openrouter", "synthetic")).toEqual({
      llm: {
        provider: "openrouter",
        api_key: "synthetic",
      },
    });
    expect(runtimeConfigurationForCredential("intervals-icu", "synthetic")).toEqual({
      intervals: { api_key: "synthetic" },
    });
    expect(
      runtimeConfigurationForCredential("openrouter", "synthetic", {
        provider: "openrouter",
        model: "athlete-model",
        endpoint: { mode: "automatic" },
      }),
    ).toEqual({
      llm: {
        provider: "openrouter",
        model: "athlete-model",
        api_key: "synthetic",
      },
    });
    expect(
      runtimeConfigurationForCredential("openrouter", "synthetic", {
        provider: "openrouter",
        model: "athlete-model",
        endpoint: { mode: "default" },
      }),
    ).toEqual({
      llm: {
        provider: "openrouter",
        model: "athlete-model",
        api_key: "synthetic",
        base_url: null,
      },
    });
    expect(
      runtimeConfigurationForCredential("openrouter", "synthetic", {
        provider: "openrouter",
        model: "athlete-model",
        endpoint: { mode: "custom", value: "https://models.example.invalid/v1" },
      }),
    ).toEqual({
      llm: {
        provider: "openrouter",
        model: "athlete-model",
        api_key: "synthetic",
        base_url: "https://models.example.invalid/v1",
      },
    });
    expect(() =>
      runtimeConfigurationForCredential("anthropic", "synthetic", {
        provider: "anthropic",
        model: "athlete-model",
        endpoint: { mode: "default" },
      }),
    ).toThrow(TypeError);
    expect(
      runtimeConfigurationForExistingSelection({
        provider: "openai-codex",
        model: "athlete-chat-model",
        endpoint: { mode: "automatic" },
      }),
    ).toEqual({
      llm: { model: "athlete-chat-model" },
    });
    expect(
      runtimeConfigurationForExistingSelection({
        provider: "openrouter",
        model: "athlete-model",
        endpoint: { mode: "default" },
      }),
    ).toEqual({
      llm: { model: "athlete-model", base_url: null },
    });
  });

  it("registers only semantic onboarding channels and returns metadata", async () => {
    const subject = harness();
    expect([...subject.handlers.keys()].sort()).toEqual(
      [
        DESKTOP_CREDENTIAL_STATUS_CHANNEL,
        DESKTOP_CREDENTIAL_RETRY_CHANNEL,
        DESKTOP_CREDENTIAL_WRITE_CHANNEL,
        DESKTOP_CREDENTIAL_DELETE_CHANNEL,
        DESKTOP_CREDENTIAL_RECOVERY_STATUS_CHANNEL,
        DESKTOP_CREDENTIAL_RECOVERY_RETRY_CHANNEL,
        DESKTOP_CREDENTIAL_RESET_CHANNEL,
        DESKTOP_LLM_CONFIGURATION_CHANNEL,
        DESKTOP_LLM_SELECTION_APPLY_CHANNEL,
        DESKTOP_CHATGPT_STATUS_CHANNEL,
        DESKTOP_CHATGPT_LOGIN_CHANNEL,
        DESKTOP_CHATGPT_LOGIN_CANCEL_CHANNEL,
        DESKTOP_CLAUDE_CLI_STATUS_CHANNEL,
        DESKTOP_CLAUDE_CLI_RECHECK_CHANNEL,
        DESKTOP_CHOOSE_IMPORT_FILES_CHANNEL,
      ].sort(),
    );
    await expect(
      subject.invoke(DESKTOP_CREDENTIAL_STATUS_CHANNEL, subject.trustedEvent),
    ).resolves.toEqual([{ slot: "anthropic", state: "configured", runtimeState: "active" }]);
    expect(subject.vault.reapplyConfigured).not.toHaveBeenCalled();
    expect(
      JSON.stringify(await subject.invoke(DESKTOP_CREDENTIAL_STATUS_CHANNEL, subject.trustedEvent)),
    ).not.toContain("value");
  });

  it("reads credential metadata without waiting for credential replay", async () => {
    const subject = harness();
    vi.mocked(subject.vault.reapplyConfigured).mockImplementation(
      () => new Promise<void>(() => {}),
    );

    await expect(
      subject.invoke(DESKTOP_CREDENTIAL_STATUS_CHANNEL, subject.trustedEvent),
    ).resolves.toEqual([{ slot: "anthropic", state: "configured", runtimeState: "active" }]);
    expect(subject.vault.credentialStatuses).toHaveBeenCalledOnce();
    expect(subject.vault.reapplyConfigured).not.toHaveBeenCalled();
  });

  it("routes strict redacted credential deletion and refuses externally managed runtime state", async () => {
    const subject = harness();

    await expect(
      subject.invoke(DESKTOP_CREDENTIAL_DELETE_CHANNEL, subject.trustedEvent, {
        credential: "anthropic",
      }),
    ).resolves.toEqual({
      credential: "anthropic",
      status: "deleted",
      cleanupPending: false,
    });
    expect(subject.vault.deleteCredential).toHaveBeenCalledWith("anthropic");

    vi.mocked(subject.vault.credentialStatuses).mockResolvedValueOnce([
      { slot: "anthropic", state: "missing", runtimeState: null },
    ]);
    await expect(
      subject.invoke(DESKTOP_CREDENTIAL_DELETE_CHANNEL, subject.trustedEvent, {
        credential: "anthropic",
      }),
    ).resolves.toEqual({
      credential: "anthropic",
      status: "refused",
      reason: "managed-by-environment",
    });

    await expect(
      subject.invoke(DESKTOP_CREDENTIAL_DELETE_CHANNEL, subject.trustedEvent, {
        credential: "openai-codex",
      }),
    ).resolves.toEqual({
      credential: "openai-codex",
      status: "deleted",
      cleanupPending: false,
    });
    expect(subject.chatGptAuth.deleteCredential).toHaveBeenCalledOnce();
  });

  it("deletes a locally stored Intervals.icu credential through the existing channel", async () => {
    const subject = harness();
    vi.mocked(subject.vault.credentialStatuses).mockResolvedValueOnce([
      { slot: "intervals-icu", state: "configured", runtimeState: "active" },
    ]);

    await expect(
      subject.invoke(DESKTOP_CREDENTIAL_DELETE_CHANNEL, subject.trustedEvent, {
        credential: "intervals-icu",
      }),
    ).resolves.toEqual({
      credential: "intervals-icu",
      status: "deleted",
      cleanupPending: false,
    });
    expect(subject.vault.deleteCredential).toHaveBeenCalledWith("intervals-icu");
    expect(subject.getRuntimeConfig).not.toHaveBeenCalled();
  });

  it("projects credential deletion uncertainty as its exact slot envelope", async () => {
    const subject = harness();
    vi.mocked(subject.vault.deleteCredential).mockResolvedValueOnce({
      slot: "anthropic",
      status: "uncertain",
      reason: "storage-uncertain",
    });

    const result = await subject.invoke(DESKTOP_CREDENTIAL_DELETE_CHANNEL, subject.trustedEvent, {
      credential: "anthropic",
    });

    expect(result).toEqual({
      slot: "anthropic",
      status: "uncertain",
      reason: "storage-uncertain",
    });
    expect(Object.keys(result as object)).toEqual(["slot", "status", "reason"]);
  });

  it("rejects untrusted, widened, and unknown credential deletion inputs", async () => {
    const subject = harness();
    for (const [event, input] of [
      [{} as IpcMainInvokeEvent, { credential: "anthropic" }],
      [subject.trustedEvent, { credential: "unknown" }],
      [subject.trustedEvent, { credential: "anthropic", extra: true }],
    ] as const) {
      await expect(
        subject.invoke(DESKTOP_CREDENTIAL_DELETE_CHANNEL, event, input),
      ).rejects.toBeInstanceOf(TypeError);
    }
    expect(subject.vault.deleteCredential).not.toHaveBeenCalled();
  });

  it("fails closed to re-entry metadata when stored status cannot be read", async () => {
    const subject = harness();
    vi.mocked(subject.vault.credentialStatuses).mockRejectedValueOnce(
      new Error("private storage detail"),
    );

    const statuses = await subject.invoke(DESKTOP_CREDENTIAL_STATUS_CHANNEL, subject.trustedEvent);

    expect(statuses).toHaveLength(10);
    expect(statuses).toContainEqual({
      slot: "anthropic",
      state: "re-prompt",
      runtimeState: null,
    });
    expect(JSON.stringify(statuses)).not.toContain("private storage detail");
    expect(subject.vault.reapplyConfigured).not.toHaveBeenCalled();
  });

  it("retries only failed credentials through the explicit vault path", async () => {
    const subject = harness();
    vi.mocked(subject.vault.credentialStatuses).mockResolvedValueOnce([
      { slot: "anthropic", state: "configured", runtimeState: "active" },
    ]);

    await expect(
      subject.invoke(DESKTOP_CREDENTIAL_RETRY_CHANNEL, subject.trustedEvent),
    ).resolves.toEqual([{ slot: "anthropic", state: "configured", runtimeState: "active" }]);
    expect(subject.vault.retryFailed).toHaveBeenCalledOnce();
    expect(subject.vault.reapplyConfigured).not.toHaveBeenCalled();
  });

  it("returns only the ordered public catalogue and minimized active selection", async () => {
    const subject = harness();

    const result = (await subject.invoke(
      DESKTOP_LLM_CONFIGURATION_CHANNEL,
      subject.trustedEvent,
    )) as {
      readonly schemaVersion: number;
      readonly providers: readonly Record<string, unknown>[];
      readonly active: Record<string, unknown>;
    };

    expect(result.schemaVersion).toBe(1);
    expect(result.providers.map((provider) => provider.provider)).toEqual([
      "anthropic",
      "openai",
      "google",
      "openai-codex",
      "claude-cli",
      "deepseek",
      "qwen",
      "minimax",
      "kimi",
      "zai",
      "openrouter",
    ]);
    expect(result.providers.map((provider) => provider.provider)).not.toContain("codex-agent");
    expect(result.active).toEqual({
      provider: "anthropic",
      model: "athlete-selected-model",
    });
    expect(Object.keys(result.active).sort()).toEqual(["model", "provider"]);
    expect(JSON.stringify(result)).not.toMatch(/credential|api[_-]?key|path|error/i);
    await expect(
      subject.invoke(DESKTOP_LLM_CONFIGURATION_CHANNEL, {} as IpcMainInvokeEvent),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      subject.invoke(DESKTOP_LLM_CONFIGURATION_CHANNEL, subject.trustedEvent, null),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("keeps a keyless subscription lane as the minimized active selection", async () => {
    const subject = harness();
    subject.getRuntimeConfig.mockResolvedValueOnce({
      schemaVersion: 3,
      llm: {
        provider: "claude-cli",
        model: "athlete-selected-model",
        credential_configured: true,
      },
      intervals: {
        athlete_id: "synthetic-athlete",
        credential_configured: true,
        managedByEnvironment: { athleteId: false },
      },
      session: {
        historyTokenBudgetRatio: 0.3,
        idleMinutes: 0,
        dailyResetHour: 4,
        resetArchiveRetentionDays: 0,
        timezone: "UTC",
        managedByEnvironment: {
          historyTokenBudgetRatio: false,
          idleMinutes: false,
          dailyResetHour: false,
          resetArchiveRetentionDays: false,
          timezone: false,
        },
      },
    });

    const result = (await subject.invoke(
      DESKTOP_LLM_CONFIGURATION_CHANNEL,
      subject.trustedEvent,
    )) as { readonly active: Record<string, unknown> };

    expect(result.active).toEqual({
      provider: "claude-cli",
      model: "athlete-selected-model",
    });
    expect(Object.keys(result.active).sort()).toEqual(["model", "provider"]);
    expect(JSON.stringify(result)).not.toMatch(/credential|api[_-]?key|path|error/i);
  });

  it("keeps the catalogue available with a null active selection when snapshotting fails", async () => {
    const subject = harness();
    subject.getRuntimeConfig.mockRejectedValueOnce(new Error("private daemon path and token"));

    const result = (await subject.invoke(
      DESKTOP_LLM_CONFIGURATION_CHANNEL,
      subject.trustedEvent,
    )) as { readonly providers: readonly unknown[]; readonly active: unknown };

    expect(result.providers).toHaveLength(11);
    expect(result.active).toBeNull();
    expect(JSON.stringify(result)).not.toContain("private daemon path and token");
  });

  it("dispatches strict model selection to a stored key or stored ChatGPT profile", async () => {
    const subject = harness();
    const apiSelection = {
      provider: "openrouter",
      model: "  athlete-model  ",
      endpoint: { mode: "custom", value: "  https://models.example.invalid/v1  " },
    };
    await expect(
      subject.invoke(DESKTOP_LLM_SELECTION_APPLY_CHANNEL, subject.trustedEvent, apiSelection),
    ).resolves.toEqual({ status: "configured", runtimeReady: true });
    expect(subject.vault.applyLlmSelection).toHaveBeenCalledWith({
      provider: "openrouter",
      model: "athlete-model",
      endpoint: { mode: "custom", value: "https://models.example.invalid/v1" },
    });

    const chatGpt = {
      provider: "openai-codex",
      model: "gpt-5.4-mini",
      endpoint: { mode: "automatic" },
    };
    await expect(
      subject.invoke(DESKTOP_LLM_SELECTION_APPLY_CHANNEL, subject.trustedEvent, chatGpt),
    ).resolves.toEqual({ status: "configured", runtimeReady: true });
    expect(subject.chatGptAuth.activate).toHaveBeenCalledWith(chatGpt, expect.any(AbortSignal));
  });

  it("preserves an active API credential without requiring a Desktop-owned credential", async () => {
    const subject = harness();
    const selection = {
      provider: "anthropic" as const,
      model: "athlete-selected-model",
      endpoint: { mode: "automatic" as const },
    };
    subject.applyExistingLlmSelection.mockResolvedValueOnce(true);

    await expect(
      subject.invoke(DESKTOP_LLM_SELECTION_APPLY_CHANNEL, subject.trustedEvent, selection),
    ).resolves.toEqual({ status: "configured", runtimeReady: true });

    expect(subject.applyExistingLlmSelection).toHaveBeenCalledWith(selection);
    expect(subject.vault.applyLlmSelection).not.toHaveBeenCalled();
    expect(subject.chatGptAuth.activate).not.toHaveBeenCalled();
  });

  it("bounds a stalled custom ChatGPT profile activation with the shared deadline", async () => {
    const subject = harness(
      vi.fn(async () => "unresolved" as const),
      5,
    );
    const selection = {
      provider: "openai-codex" as const,
      model: "gpt-5.4-mini",
      endpoint: { mode: "automatic" as const },
    };
    let activationSignal: AbortSignal | undefined;
    subject.getRuntimeConfig.mockResolvedValueOnce(runtimeConfigSnapshot("openai-codex"));
    subject.chatGptAuth.hasStoredProfile.mockResolvedValueOnce(false);
    subject.applyExistingLlmSelection.mockImplementationOnce(async (_selection, signal) => {
      activationSignal = signal;
      return await new Promise<boolean>(() => {});
    });

    await expect(
      subject.invoke(DESKTOP_LLM_SELECTION_APPLY_CHANNEL, subject.trustedEvent, selection),
    ).resolves.toEqual({ status: "refused", reason: "runtime-unavailable" });

    expect(activationSignal?.aborted).toBe(true);
    expect(subject.chatGptAuth.activate).not.toHaveBeenCalled();
  });

  it("preserves an active custom ChatGPT profile without requiring a Desktop profile", async () => {
    const subject = harness();
    const selection = {
      provider: "openai-codex" as const,
      model: "gpt-5.4-mini",
      endpoint: { mode: "automatic" as const },
    };
    subject.getRuntimeConfig.mockResolvedValueOnce(runtimeConfigSnapshot("openai-codex"));
    subject.chatGptAuth.hasStoredProfile.mockResolvedValueOnce(false);
    subject.applyExistingLlmSelection.mockResolvedValueOnce(true);

    await expect(
      subject.invoke(DESKTOP_LLM_SELECTION_APPLY_CHANNEL, subject.trustedEvent, selection),
    ).resolves.toEqual({ status: "configured", runtimeReady: true });

    expect(subject.applyExistingLlmSelection).toHaveBeenCalledWith(
      selection,
      expect.any(AbortSignal),
    );
    expect(subject.vault.applyLlmSelection).not.toHaveBeenCalled();
    expect(subject.chatGptAuth.activate).not.toHaveBeenCalled();
  });

  it("preserves an active custom ChatGPT profile when the Desktop default also exists", async () => {
    const subject = harness();
    const selection = {
      provider: "openai-codex" as const,
      model: "gpt-5.4-mini",
      endpoint: { mode: "automatic" as const },
    };
    subject.getRuntimeConfig.mockResolvedValueOnce(runtimeConfigSnapshot("openai-codex"));
    subject.chatGptAuth.hasStoredProfile.mockResolvedValueOnce(true);
    subject.applyExistingLlmSelection.mockResolvedValueOnce(true);

    await expect(
      subject.invoke(DESKTOP_LLM_SELECTION_APPLY_CHANNEL, subject.trustedEvent, selection),
    ).resolves.toEqual({ status: "configured", runtimeReady: true });

    expect(subject.applyExistingLlmSelection).toHaveBeenCalledWith(
      selection,
      expect.any(AbortSignal),
    );
    expect(subject.chatGptAuth.hasStoredProfile).not.toHaveBeenCalled();
    expect(subject.chatGptAuth.activate).not.toHaveBeenCalled();
  });

  it("activates the stored default when the selected custom ChatGPT profile is unusable", async () => {
    const subject = harness();
    const selection = {
      provider: "openai-codex" as const,
      model: "gpt-5.4-mini",
      endpoint: { mode: "automatic" as const },
    };
    subject.getRuntimeConfig.mockResolvedValueOnce(runtimeConfigSnapshot("openai-codex", false));
    subject.chatGptAuth.hasStoredProfile.mockResolvedValueOnce(true);
    subject.applyExistingLlmSelection.mockResolvedValueOnce(true);

    await expect(
      subject.invoke(DESKTOP_LLM_SELECTION_APPLY_CHANNEL, subject.trustedEvent, selection),
    ).resolves.toEqual({ status: "configured", runtimeReady: true });

    expect(subject.applyExistingLlmSelection).not.toHaveBeenCalled();
    expect(subject.chatGptAuth.hasStoredProfile).toHaveBeenCalledOnce();
    expect(subject.chatGptAuth.activate).toHaveBeenCalledWith(selection, expect.any(AbortSignal));
  });

  it("does not replace a custom ChatGPT profile when its runtime preflight fails", async () => {
    const subject = harness();
    const selection = {
      provider: "openai-codex" as const,
      model: "gpt-5.4-mini",
      endpoint: { mode: "automatic" as const },
    };
    subject.getRuntimeConfig.mockRejectedValueOnce(new Error("private runtime failure"));

    await expect(
      subject.invoke(DESKTOP_LLM_SELECTION_APPLY_CHANNEL, subject.trustedEvent, selection),
    ).resolves.toEqual({ status: "refused", reason: "runtime-unavailable" });

    expect(subject.applyExistingLlmSelection).not.toHaveBeenCalled();
    expect(subject.chatGptAuth.hasStoredProfile).not.toHaveBeenCalled();
    expect(subject.chatGptAuth.activate).not.toHaveBeenCalled();
  });

  it("routes an inactive stored ChatGPT profile through bounded activation", async () => {
    const subject = harness();
    const selection = {
      provider: "openai-codex" as const,
      model: "gpt-5.4-mini",
      endpoint: { mode: "automatic" as const },
    };
    subject.getRuntimeConfig.mockResolvedValueOnce(runtimeConfigSnapshot("openai-codex"));
    subject.applyExistingLlmSelection.mockResolvedValueOnce(false);
    subject.chatGptAuth.activate.mockResolvedValueOnce({
      status: "refused",
      reason: "runtime-unavailable",
    });

    await expect(
      subject.invoke(DESKTOP_LLM_SELECTION_APPLY_CHANNEL, subject.trustedEvent, selection),
    ).resolves.toEqual({ status: "refused", reason: "runtime-unavailable" });

    expect(subject.chatGptAuth.hasStoredProfile).toHaveBeenCalledOnce();
    expect(subject.chatGptAuth.activate).toHaveBeenCalledWith(selection, expect.any(AbortSignal));
    expect(subject.applyExistingLlmSelection).toHaveBeenCalledWith(
      selection,
      expect.any(AbortSignal),
    );
  });

  it("fails an active-provider apply closed without falling back to another credential", async () => {
    const subject = harness();
    subject.applyExistingLlmSelection.mockRejectedValueOnce(new Error("private runtime failure"));

    await expect(
      subject.invoke(DESKTOP_LLM_SELECTION_APPLY_CHANNEL, subject.trustedEvent, {
        provider: "anthropic",
        model: "athlete-selected-model",
        endpoint: { mode: "automatic" },
      }),
    ).resolves.toEqual({ status: "refused", reason: "runtime-unavailable" });

    expect(subject.vault.applyLlmSelection).not.toHaveBeenCalled();
    expect(subject.chatGptAuth.activate).not.toHaveBeenCalled();
  });

  it("returns fixed selection refusals and rejects unsafe endpoint shapes", async () => {
    const subject = harness();
    vi.mocked(subject.vault.applyLlmSelection)
      .mockResolvedValueOnce({ status: "refused", reason: "credential-required" })
      .mockRejectedValueOnce(new Error("private runtime failure"));
    const automatic = {
      provider: "anthropic",
      model: "model",
      endpoint: { mode: "automatic" },
    };
    await expect(
      subject.invoke(DESKTOP_LLM_SELECTION_APPLY_CHANNEL, subject.trustedEvent, automatic),
    ).resolves.toEqual({ status: "refused", reason: "credential-required" });
    await expect(
      subject.invoke(DESKTOP_LLM_SELECTION_APPLY_CHANNEL, subject.trustedEvent, automatic),
    ).resolves.toEqual({ status: "refused", reason: "runtime-unavailable" });

    for (const selection of [
      { provider: "anthropic", model: "model", endpoint: { mode: "default" } },
      {
        provider: "openrouter",
        model: "model",
        endpoint: { mode: "custom", value: "http://models.example.invalid/v1" },
      },
      {
        provider: "openrouter",
        model: "model",
        endpoint: { mode: "custom", value: "https://user:secret@example.invalid/v1" },
      },
      {
        provider: "openrouter",
        model: "model",
        endpoint: { mode: "custom", value: "https://example.invalid/v1?secret=value" },
      },
      {
        provider: "openrouter",
        model: "model",
        endpoint: { mode: "custom", value: "https://example.invalid/v1?" },
      },
      {
        provider: "openrouter",
        model: "bad\u007fmodel",
        endpoint: { mode: "automatic" },
      },
      {
        provider: "openrouter",
        model: "\nmodel",
        endpoint: { mode: "automatic" },
      },
    ]) {
      await expect(
        subject.invoke(DESKTOP_LLM_SELECTION_APPLY_CHANNEL, subject.trustedEvent, selection),
      ).resolves.toEqual({ status: "refused", reason: "invalid-input" });
    }
    await expect(
      subject.invoke(DESKTOP_LLM_SELECTION_APPLY_CHANNEL, subject.trustedEvent, {
        provider: "openrouter",
        model: "loopback-model",
        endpoint: { mode: "custom", value: "http://127.0.0.1:11434/v1" },
      }),
    ).resolves.toEqual({ status: "configured", runtimeReady: true });
  });

  it("passes an optional matching selection through the credential transaction", async () => {
    const subject = harness();
    const selection = {
      provider: "openrouter",
      model: "athlete-model",
      endpoint: { mode: "default" },
    };

    await expect(
      subject.invoke(DESKTOP_CREDENTIAL_WRITE_CHANNEL, subject.trustedEvent, {
        slot: "openrouter",
        value: "synthetic",
        selection,
      }),
    ).resolves.toEqual({ slot: "openrouter", status: "configured", runtimeReady: true });
    expect(subject.vault.writeCredential).toHaveBeenCalledWith({
      slot: "openrouter",
      value: "synthetic",
      selection,
    });
    await expect(
      subject.invoke(DESKTOP_CREDENTIAL_WRITE_CHANNEL, subject.trustedEvent, {
        slot: "anthropic",
        value: "synthetic",
        selection,
      }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      subject.invoke(DESKTOP_CREDENTIAL_WRITE_CHANNEL, subject.trustedEvent, {
        slot: "intervals-icu",
        value: "synthetic",
        selection,
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("gates strict claude-cli status and recheck invokes", async () => {
    const subject = harness();
    await expect(
      subject.invoke(DESKTOP_CLAUDE_CLI_STATUS_CHANNEL, subject.trustedEvent),
    ).resolves.toEqual({
      state: "ready",
      email: "athlete@synthetic.test",
      plan: "Max",
      version: "2.9.0",
    });
    await expect(
      subject.invoke(DESKTOP_CLAUDE_CLI_RECHECK_CHANNEL, subject.trustedEvent),
    ).resolves.toEqual({ state: "not-logged-in" });
    await expect(
      subject.invoke(DESKTOP_CLAUDE_CLI_STATUS_CHANNEL, {} as IpcMainInvokeEvent),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      subject.invoke(DESKTOP_CLAUDE_CLI_RECHECK_CHANNEL, {} as IpcMainInvokeEvent),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      subject.invoke(DESKTOP_CLAUDE_CLI_STATUS_CHANNEL, subject.trustedEvent, null),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      subject.invoke(DESKTOP_CLAUDE_CLI_RECHECK_CHANNEL, subject.trustedEvent, {}),
    ).rejects.toBeInstanceOf(TypeError);
    expect(subject.claudeCli.status).toHaveBeenCalledOnce();
    expect(subject.claudeCli.recheck).toHaveBeenCalledOnce();
  });

  it("re-minimizes the claude-cli status payload to its exact keys", async () => {
    const subject = harness();
    subject.claudeCli.status.mockResolvedValueOnce({
      state: "ready",
      email: "athlete@synthetic.test",
      plan: "Max",
      version: "2.9.0",
      probeSecret: "must-not-cross",
    } as never);

    const status = (await subject.invoke(
      DESKTOP_CLAUDE_CLI_STATUS_CHANNEL,
      subject.trustedEvent,
    )) as Record<string, unknown>;

    expect(Object.keys(status).sort()).toEqual(["email", "plan", "state", "version"]);
    expect(JSON.stringify(status)).not.toContain("must-not-cross");
  });

  it("busts the claude-cli probe cache when the credentials surface opens", async () => {
    const subject = harness();

    await subject.invoke(DESKTOP_CREDENTIAL_STATUS_CHANNEL, subject.trustedEvent);

    expect(subject.claudeCli.invalidateProbeCache).toHaveBeenCalledOnce();
  });

  it("routes a claude-cli selection through the claude-cli controller", async () => {
    const subject = harness();
    const selection = {
      provider: "claude-cli",
      model: "  sonnet  ",
      endpoint: { mode: "automatic" },
    };

    await expect(
      subject.invoke(DESKTOP_LLM_SELECTION_APPLY_CHANNEL, subject.trustedEvent, selection),
    ).resolves.toEqual({ status: "configured", runtimeReady: true });
    expect(subject.claudeCli.activate).toHaveBeenCalledWith({
      provider: "claude-cli",
      model: "sonnet",
      endpoint: { mode: "automatic" },
    });
    expect(subject.vault.applyLlmSelection).not.toHaveBeenCalled();
  });

  it("gates correlated ChatGPT login, progress, and cancellation invokes", async () => {
    const subject = harness();
    subject.chatGptAuth.login.mockImplementationOnce(
      async (
        operationId: string,
        _selection: unknown,
        onProgress?: (phase: "waiting-for-browser" | "completing-sign-in") => void,
      ) => {
        onProgress?.("waiting-for-browser");
        onProgress?.("completing-sign-in");
        return { status: "stored" as const, operationId };
      },
    );
    await expect(
      subject.invoke(DESKTOP_CHATGPT_STATUS_CHANNEL, subject.trustedEvent),
    ).resolves.toEqual({ state: "configured", runtimeReady: true });
    await expect(
      subject.invoke(DESKTOP_CHATGPT_LOGIN_CHANNEL, subject.trustedEvent, {
        operationId: "login-1",
        selection: {
          provider: "openai-codex",
          model: "gpt-5.5",
          endpoint: { mode: "automatic" },
        },
      }),
    ).resolves.toEqual({ status: "stored", operationId: "login-1" });
    expect(subject.progressSend).toHaveBeenNthCalledWith(
      1,
      DESKTOP_CHATGPT_LOGIN_PROGRESS_CHANNEL,
      { operationId: "login-1", phase: "waiting-for-browser" },
    );
    expect(subject.progressSend).toHaveBeenNthCalledWith(
      2,
      DESKTOP_CHATGPT_LOGIN_PROGRESS_CHANNEL,
      { operationId: "login-1", phase: "completing-sign-in" },
    );
    expect(
      subject.invoke(DESKTOP_CHATGPT_LOGIN_CANCEL_CHANNEL, subject.trustedEvent, {
        operationId: "login-1",
      }),
    ).toEqual({ status: "cancelling", operationId: "login-1" });
    await expect(
      subject.invoke(DESKTOP_CHATGPT_LOGIN_CHANNEL, {} as IpcMainInvokeEvent),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      subject.invoke(DESKTOP_CHATGPT_STATUS_CHANNEL, subject.trustedEvent, null),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      subject.invoke(DESKTOP_CHATGPT_LOGIN_CHANNEL, subject.trustedEvent),
    ).rejects.toBeInstanceOf(TypeError);
    expect(subject.chatGptAuth.status).toHaveBeenCalledOnce();
    expect(subject.chatGptAuth.login).toHaveBeenCalledOnce();
    expect(subject.chatGptAuth.cancelLogin).toHaveBeenCalledWith("login-1");
  });

  it("does not publish delayed ChatGPT progress after requester navigation or disposal", async () => {
    const subject = harness();
    let publish!: (phase: "waiting-for-browser" | "completing-sign-in") => void;
    subject.chatGptAuth.login.mockImplementationOnce(
      async (operationId, _selection, onProgress) => {
        publish = onProgress!;
        return { status: "stored" as const, operationId };
      },
    );
    await subject.invoke(DESKTOP_CHATGPT_LOGIN_CHANNEL, subject.trustedEvent, {
      operationId: "login-navigation",
      selection: {
        provider: "openai-codex",
        model: "gpt-5.5",
        endpoint: { mode: "automatic" },
      },
    });

    (subject.trustedEvent.sender.mainFrame as { url: string }).url = "https://attacker.invalid";
    publish("waiting-for-browser");
    expect(subject.progressSend).not.toHaveBeenCalled();

    (subject.trustedEvent.sender.mainFrame as { url: string }).url = RENDERER_URL;
    subject.dispose();
    publish("completing-sign-in");
    expect(subject.progressSend).not.toHaveBeenCalled();
  });

  it("rejects malformed ChatGPT operation envelopes before dispatch", async () => {
    const subject = harness();
    for (const value of [
      { operationId: "bad id", selection: {} },
      { operationId: "login-1", selection: { provider: "anthropic" } },
      {
        operationId: "login-1",
        selection: {
          provider: "openai-codex",
          model: "gpt-5.5",
          endpoint: { mode: "automatic" },
        },
        extra: true,
      },
    ]) {
      await expect(
        subject.invoke(DESKTOP_CHATGPT_LOGIN_CHANNEL, subject.trustedEvent, value),
      ).rejects.toBeInstanceOf(TypeError);
    }
    expect(() =>
      subject.invoke(DESKTOP_CHATGPT_LOGIN_CANCEL_CHANNEL, subject.trustedEvent, {
        operationId: "login-1",
        extra: true,
      }),
    ).toThrow(TypeError);
    expect(subject.chatGptAuth.login).not.toHaveBeenCalled();
    expect(subject.chatGptAuth.cancelLogin).not.toHaveBeenCalled();
  });

  it("validates trusted senders and exact credential inputs before dispatch", async () => {
    const subject = harness();
    await expect(
      subject.invoke(DESKTOP_CREDENTIAL_WRITE_CHANNEL, {} as IpcMainInvokeEvent, {
        slot: "anthropic",
        value: "synthetic",
      }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      subject.invoke(DESKTOP_CREDENTIAL_WRITE_CHANNEL, subject.trustedEvent, {
        slot: "unknown",
        value: "synthetic",
      }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      subject.invoke(DESKTOP_CREDENTIAL_WRITE_CHANNEL, subject.trustedEvent, {
        slot: "anthropic",
        value: "synthetic",
        extra: true,
      }),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      subject.invoke(DESKTOP_CREDENTIAL_WRITE_CHANNEL, subject.trustedEvent, {
        slot: "anthropic",
        value: "synthetic",
      }),
    ).resolves.toEqual({ slot: "anthropic", status: "configured", runtimeReady: false });
    expect(subject.vault.writeCredential).toHaveBeenCalledTimes(1);
    expect(subject.vault.writeCredential).toHaveBeenCalledWith(
      { slot: "anthropic", value: "synthetic" },
      { activate: false },
    );
  });

  it("minimizes failures without exposing raw errors", async () => {
    const subject = harness();
    vi.mocked(subject.vault.writeCredential).mockResolvedValueOnce({
      slot: "anthropic",
      status: "refused",
      reason: "runtime-unavailable",
    });
    const result = await subject.invoke(DESKTOP_CREDENTIAL_WRITE_CHANNEL, subject.trustedEvent, {
      slot: "anthropic",
      value: "synthetic",
    });
    expect(result).toEqual({
      slot: "anthropic",
      status: "refused",
      reason: "runtime-unavailable",
    });
    expect(Object.keys(result as object)).toEqual(["slot", "status", "reason"]);
  });

  it("projects credential durability uncertainty without downgrading it to refusal", async () => {
    const subject = harness();
    vi.mocked(subject.vault.writeCredential).mockResolvedValueOnce({
      slot: "anthropic",
      status: "uncertain",
      reason: "storage-uncertain",
    });

    const result = await subject.invoke(DESKTOP_CREDENTIAL_WRITE_CHANNEL, subject.trustedEvent, {
      slot: "anthropic",
      value: "synthetic",
    });

    expect(result).toEqual({
      slot: "anthropic",
      status: "uncertain",
      reason: "storage-uncertain",
    });
    expect(Object.keys(result as object)).toEqual(["slot", "status", "reason"]);
  });

  it("uses the bounded native chooser and filters its result", async () => {
    const subject = harness();
    await expect(
      subject.invoke(DESKTOP_CHOOSE_IMPORT_FILES_CHANNEL, subject.trustedEvent),
    ).resolves.toEqual(["/synthetic/ride.fit"]);
    const chooserDefaultPath = homedir();
    expect(chooserDefaultPath).not.toMatch(/\/(Desktop|Documents|Downloads)(\/|$)/);
    expect(subject.dialog.showOpenDialog).toHaveBeenCalledWith(expect.anything(), {
      defaultPath: chooserDefaultPath,
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Ride files", extensions: ["fit", "tcx", "gpx"] }],
    });
    subject.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    await expect(
      subject.invoke(DESKTOP_CHOOSE_IMPORT_FILES_CHANNEL, subject.trustedEvent),
    ).resolves.toEqual([]);
  });

  it("disposes only its fifteen handlers", () => {
    const subject = harness();
    subject.dispose();
    expect(subject.handlers.size).toBe(0);
    expect(subject.ipcMain.removeHandler).toHaveBeenCalledTimes(15);
  });
});
