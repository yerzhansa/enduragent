import { describe, expect, it, vi } from "vitest";
import type {
  OnboardingBridge,
  OnboardingLlmConfiguration,
  OnboardingLlmSelectionResult,
} from "../src/onboarding/bridge";
import {
  createOnboardingCompletionController,
  type OnboardingCompletionStorage,
} from "../src/onboarding/completion";
import {
  createOnboardingController,
  type OnboardingSurfaceState,
} from "../src/onboarding/controller";
import {
  onboardingStatusRetryDelayMs,
  ONBOARDING_STATUS_COLD_START_TIMEOUT_MS,
  ONBOARDING_STATUS_LOAD_ATTEMPTS,
} from "../src/onboarding/status-read";
import type { CredentialDraftPort } from "../src/onboarding/credentials";
import type { OnboardingCompletion } from "../src/onboarding/machine";
import { openRouterTestBridge } from "./openrouter-test-bridge";

const COLD_START_WINDOW_MS =
  ONBOARDING_STATUS_COLD_START_TIMEOUT_MS * ONBOARDING_STATUS_LOAD_ATTEMPTS +
  Array.from({ length: ONBOARDING_STATUS_LOAD_ATTEMPTS }, (_unused, attempt) =>
    onboardingStatusRetryDelayMs(attempt),
  ).reduce((total, delay) => total + delay, 0);

const completion = {
  providerConfigured: true,
  trainingDataConfigured: true,
  requiresProviderSync: true,
} as const;

const fileOnlyCompletion = { ...completion, requiresProviderSync: false } as const;

function memoryStorage(
  entries: readonly (readonly [string, string])[] = [],
): OnboardingCompletionStorage & { readonly entries: Map<string, string> } {
  const stored = new Map(entries);
  return {
    entries: stored,
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => {
      stored.set(key, value);
    },
  };
}

const KEYLESS_CONFIGURATION: OnboardingLlmConfiguration = {
  schemaVersion: 1,
  catalogRevision: 7,
  providers: [
    {
      provider: "anthropic",
      defaultModel: "claude-sonnet-4-6",
      models: [{ value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" }],
    },
    {
      provider: "claude-cli",
      defaultModel: "sonnet",
      models: [{ value: "sonnet", label: "Claude Sonnet" }],
    },
    {
      provider: "openai-codex",
      defaultModel: "gpt-5.5",
      models: [{ value: "gpt-5.5", label: "GPT-5.5" }],
    },
  ],
  active: { provider: "anthropic", model: "claude-sonnet-4-6", kind: "listed" },
};

const NEXT_CONFIGURATION: OnboardingLlmConfiguration = {
  ...KEYLESS_CONFIGURATION,
  catalogRevision: 8,
};

const TWO_MODEL_CONFIGURATION: OnboardingLlmConfiguration = {
  ...KEYLESS_CONFIGURATION,
  providers: [
    {
      provider: "anthropic",
      defaultModel: "claude-sonnet-4-6",
      models: [
        { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
        { value: "claude-opus-4-7", label: "Claude Opus 4.7" },
      ],
    },
    ...KEYLESS_CONFIGURATION.providers.slice(1),
  ],
};

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function activationBridge(
  apply: OnboardingBridge["applyLlmSelection"],
  chatGptStatus: OnboardingBridge["chatGptStatus"] = async () => ({
    state: "absent",
    runtimeReady: false,
  }),
) {
  const statuses = [
    { slot: "anthropic", state: "configured", runtimeState: "active" },
    { slot: "intervals-icu", state: "configured", runtimeState: "active" },
  ] as const;
  return {
    ...openRouterTestBridge(),
    credentialStatuses: vi.fn<OnboardingBridge["credentialStatuses"]>(async () => statuses),
    retryFailedCredentials: vi.fn<OnboardingBridge["retryFailedCredentials"]>(async () => statuses),
    writeCredential: vi.fn<OnboardingBridge["writeCredential"]>(async ({ slot }) => ({
      slot,
      status: "configured",
      runtimeReady: true,
    })),
    signInWithIntervals: vi.fn<OnboardingBridge["signInWithIntervals"]>(async () => ({
      outcome: "applied",
      current: { slot: "intervals-icu", state: "configured", runtimeState: "active" },
    })),
    cancelIntervalsSignIn: vi.fn<OnboardingBridge["cancelIntervalsSignIn"]>(async () => true),
    reopenIntervalsSignIn: vi.fn<OnboardingBridge["reopenIntervalsSignIn"]>(async () => true),
    onIntervalsSignInProgress: vi.fn<OnboardingBridge["onIntervalsSignInProgress"]>(() => () => {}),
    llmConfiguration: vi.fn<OnboardingBridge["llmConfiguration"]>(
      async () => KEYLESS_CONFIGURATION,
    ),
    applyLlmSelection: vi.fn<OnboardingBridge["applyLlmSelection"]>(apply),
    chatGptStatus: vi.fn<OnboardingBridge["chatGptStatus"]>(chatGptStatus),
    chatGptLogin: vi.fn<OnboardingBridge["chatGptLogin"]>(async ({ operationId }) => ({
      status: "refused",
      operationId,
      reason: "cancelled",
    })),
    cancelChatGptLogin: vi.fn<OnboardingBridge["cancelChatGptLogin"]>(async (operationId) => ({
      status: "not-active",
      operationId,
    })),
    onChatGptLoginProgress: vi.fn<OnboardingBridge["onChatGptLoginProgress"]>(() => () => {}),
    claudeCliStatus: vi.fn<OnboardingBridge["claudeCliStatus"]>(async () => ({
      state: "ready",
      email: "athlete@example.test",
      plan: "Max",
    })),
    claudeCliRecheck: vi.fn<OnboardingBridge["claudeCliRecheck"]>(async () => ({
      state: "ready",
    })),
    chooseImportFiles: vi.fn<OnboardingBridge["chooseImportFiles"]>(async () => []),
    onDroppedImportFiles: vi.fn<OnboardingBridge["onDroppedImportFiles"]>(() => () => {}),
    importFiles: vi.fn<OnboardingBridge["importFiles"]>(async () => ({
      schemaVersion: 2,
      files: { total: 0, imported: 0, quarantined: 0 },
      changes: {
        rawFilesInserted: 0,
        sourceRecordsInserted: 0,
        sourceRecordsUpdated: 0,
        relinkedSourceRecords: 0,
      },
      publication: { scope: "activities-and-streams", status: "available" },
    })),
  };
}

function onboardingHarness(
  bridge: OnboardingBridge,
  credentials: CredentialDraftPort = {
    harvest: () => [],
    clear: vi.fn(),
  },
) {
  let surface: OnboardingSurfaceState | undefined;
  const onComplete = vi.fn<(value: OnboardingCompletion) => void>();
  const onReady = vi.fn<() => void>();
  const controller = createOnboardingController({
    bridge,
    credentials,
    view: {
      render(next) {
        surface = next;
      },
    },
    focusOpener: vi.fn(),
    onComplete,
    onReady,
  });
  return {
    controller,
    onComplete,
    onReady,
    surface: () => {
      if (surface === undefined) throw new Error("Onboarding surface was not rendered");
      return surface;
    },
  };
}

describe("onboarding completion", () => {
  it("opens Setup on first launch without writing a completion marker", async () => {
    const storage = memoryStorage();
    const openSetup = vi.fn(async () => {});
    const onComplete = vi.fn();
    const controller = createOnboardingCompletionController({
      storage: () => storage,
      onComplete,
    });

    await controller.openOnStartup(openSetup);

    expect(openSetup).toHaveBeenCalledOnce();
    expect(storage.entries.size).toBe(0);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("persists the exact completion marker across a fresh window decision", async () => {
    const storage = memoryStorage();
    const firstSync = vi.fn();
    const firstWindow = createOnboardingCompletionController({
      storage: () => storage,
      onComplete: firstSync,
    });

    firstWindow.complete(fileOnlyCompletion);

    expect([...storage.entries]).toEqual([
      ["enduragent.desktop.onboarding", '{"version":1,"completed":true}'],
    ]);
    expect(firstSync).toHaveBeenCalledWith(fileOnlyCompletion);

    const openSetup = vi.fn(async () => {});
    const nextWindow = createOnboardingCompletionController({
      storage: () => storage,
      onComplete: vi.fn(),
    });
    expect(nextWindow.isCompleted()).toBe(true);
    await nextWindow.openOnStartup(openSetup);

    expect(openSetup).not.toHaveBeenCalled();
  });

  it("uses the completion marker as a one-time first-sync guard", () => {
    const storage = memoryStorage();
    const firstSync = vi.fn();
    const controller = createOnboardingCompletionController({
      storage: () => storage,
      onComplete: firstSync,
    });

    controller.complete(completion);
    controller.complete(completion);

    expect(firstSync).toHaveBeenCalledOnce();
  });

  it("always opens Setup for a manual replay after completion", async () => {
    const storage = memoryStorage([
      ["enduragent.desktop.onboarding", '{"version":1,"completed":true}'],
    ]);
    const openSetup = vi.fn(async () => {});
    const controller = createOnboardingCompletionController({
      storage: () => storage,
      onComplete: vi.fn(),
    });

    await controller.openOnStartup(openSetup);
    await controller.openManually(openSetup);

    expect(openSetup).toHaveBeenCalledOnce();
  });

  it.each([
    "",
    "completed",
    '{"version":1,"completed":false}',
    '{"version":2,"completed":true}',
    '{"version":1,"completed":true,"extra":true}',
  ])("opens Setup when the stored marker is malformed or inexact: %s", async (marker) => {
    const storage = memoryStorage([["enduragent.desktop.onboarding", marker]]);
    const openSetup = vi.fn(async () => {});
    const controller = createOnboardingCompletionController({
      storage: () => storage,
      onComplete: vi.fn(),
    });

    await controller.openOnStartup(openSetup);

    expect(openSetup).toHaveBeenCalledOnce();
  });

  it("opens Setup when browser storage cannot be read", async () => {
    const openSetup = vi.fn(async () => {});
    const controller = createOnboardingCompletionController({
      storage: () => {
        throw new TypeError("unavailable");
      },
      onComplete: vi.fn(),
    });

    await controller.openOnStartup(openSetup);

    expect(openSetup).toHaveBeenCalledOnce();
  });

  it("continues first sync and leaves manual Setup available when storage cannot be written", async () => {
    const storage: OnboardingCompletionStorage = {
      getItem: () => null,
      setItem: () => {
        throw new TypeError("unavailable");
      },
    };
    const firstSync = vi.fn();
    const openSetup = vi.fn(async () => {});
    const controller = createOnboardingCompletionController({
      storage: () => storage,
      onComplete: firstSync,
    });

    expect(() => controller.complete(completion)).not.toThrow();
    expect(() => controller.complete(completion)).not.toThrow();
    await controller.openManually(openSetup);

    expect(firstSync).toHaveBeenCalledWith(completion);
    expect(firstSync).toHaveBeenCalledOnce();
    expect(openSetup).toHaveBeenCalledOnce();
  });
});

describe("onboarding runtime completion gate", () => {
  it("blocks controller mutations after a setup read timeout until a full retry succeeds", async () => {
    vi.useFakeTimers();
    try {
      const baseBridge = activationBridge(async () => ({
        status: "configured",
        runtimeReady: true,
      }));
      let credentialStatusesHang = true;
      const readyStatuses = baseBridge.credentialStatuses.getMockImplementation();
      baseBridge.credentialStatuses.mockImplementation(async () =>
        credentialStatusesHang
          ? await new Promise<never>(() => undefined)
          : ((await readyStatuses?.()) ?? []),
      );
      const bridge = {
        ...baseBridge,
        getSetupStatus: vi.fn<NonNullable<OnboardingBridge["getSetupStatus"]>>(async () => ({
          schemaVersion: 1,
          durableTrainingData: true,
        })),
      };
      const harness = onboardingHarness(bridge);

      const opening = harness.controller.open();
      await vi.advanceTimersByTimeAsync(COLD_START_WINDOW_MS);
      await opening;

      expect(harness.surface().loadUnavailable).toBe(true);
      expect(bridge.credentialStatuses).toHaveBeenCalledTimes(ONBOARDING_STATUS_LOAD_ATTEMPTS);
      const stateBeforeMutations = harness.controller.state();
      harness.controller.selectProvider("anthropic");
      harness.controller.selectModel("claude-sonnet-4-6");
      harness.controller.setCustomModel("synthetic-model");
      harness.controller.setEndpointMode("default");
      harness.controller.setCustomEndpoint("https://example.test/v1");
      harness.controller.saveModelKey();
      harness.controller.connectTrainingData();
      harness.controller.retrySavedKeys();
      harness.controller.startChatGptLogin();
      harness.controller.retryChatGptActivation();
      harness.controller.recheckClaudeCli();
      harness.controller.chooseImportFiles();
      harness.controller.importDroppedFiles(["/tmp/synthetic.fit"]);
      harness.controller.finish();
      await Promise.resolve();

      expect(harness.controller.state()).toBe(stateBeforeMutations);
      expect(bridge.writeCredential).not.toHaveBeenCalled();
      expect(bridge.signInWithIntervals).not.toHaveBeenCalled();
      expect(bridge.retryFailedCredentials).not.toHaveBeenCalled();
      expect(bridge.chatGptLogin).not.toHaveBeenCalled();
      expect(bridge.applyLlmSelection).not.toHaveBeenCalled();
      expect(bridge.claudeCliRecheck).not.toHaveBeenCalled();
      expect(bridge.chooseImportFiles).not.toHaveBeenCalled();
      expect(bridge.importFiles).not.toHaveBeenCalled();
      expect(harness.controller.ownsDroppedImportFiles()).toBe(false);

      credentialStatusesHang = false;
      await harness.controller.refresh();

      expect(harness.surface().loadUnavailable).toBe(false);
      expect(harness.surface().readiness).toEqual({
        provider: true,
        trainingData: true,
      });
      harness.controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("activates a selected ready Claude lane and ignores Finish while activation is pending", async () => {
    const pending = deferred<OnboardingLlmSelectionResult>();
    const bridge = activationBridge(() => pending.promise);
    const harness = onboardingHarness(bridge);
    await harness.controller.open();
    expect(harness.controller.state().claudeCliState).toBeNull();
    expect(bridge.claudeCliStatus).not.toHaveBeenCalled();

    harness.controller.selectProvider("claude-cli");

    await vi.waitFor(() => {
      expect(bridge.claudeCliStatus).toHaveBeenCalledOnce();
      expect(bridge.applyLlmSelection).toHaveBeenCalledWith({
        catalogRevision: 7,
        provider: "claude-cli",
        model: "sonnet",
        endpoint: { mode: "automatic" },
      });
    });
    expect(harness.controller.state().busy).toBe(true);
    harness.controller.finish();
    expect(harness.onComplete).not.toHaveBeenCalled();

    pending.resolve({ status: "configured", runtimeReady: true });
    await vi.waitFor(() => {
      expect(harness.controller.state().busy).toBe(false);
      expect(harness.surface().readiness.provider).toBe(true);
    });
    expect(harness.surface().configuration?.active).toEqual({
      provider: "claude-cli",
      model: "sonnet",
      kind: "listed",
    });

    harness.controller.finish();

    await vi.waitFor(() => {
      expect(harness.onComplete).toHaveBeenCalledOnce();
    });
    expect(bridge.applyLlmSelection.mock.invocationCallOrder[0]).toBeLessThan(
      harness.onComplete.mock.invocationCallOrder[0]!,
    );
    harness.controller.dispose();
  });

  it("keeps the selected lane when its captured catalog revision is no longer pinned", async () => {
    const bridge = activationBridge(async (selection) => ({
      status: "stale-draft",
      reason: "catalog-unavailable",
      selection,
    }));
    const harness = onboardingHarness(bridge);
    await harness.controller.open();

    harness.controller.selectProvider("claude-cli");

    await vi.waitFor(() => {
      expect(harness.controller.state().fixedError).toBe("configuration-unavailable");
    });
    expect(harness.surface().draft).toMatchObject({
      catalogRevision: 7,
      provider: { provider: "claude-cli" },
      modelChoice: "sonnet",
    });
    harness.controller.dispose();
  });

  it("keeps the ChatGPT draft when sign-in receives an unpinned revision", async () => {
    const bridge = activationBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.chatGptLogin.mockImplementation(async ({ operationId, selection }) => ({
      status: "stale-draft",
      operationId,
      reason: "catalog-unavailable",
      selection,
    }));
    const harness = onboardingHarness(bridge);
    await harness.controller.open();
    harness.controller.selectProvider("openai-codex");
    const draft = harness.surface().draft;

    harness.controller.startChatGptLogin();

    await vi.waitFor(() => {
      expect(harness.controller.state()).toMatchObject({
        busy: false,
        fixedError: "configuration-unavailable",
      });
    });
    expect(harness.surface().draft).toBe(draft);
    expect(bridge.chatGptLogin).toHaveBeenCalledWith({
      operationId: expect.any(String),
      selection: {
        catalogRevision: 7,
        provider: "openai-codex",
        model: "gpt-5.5",
        endpoint: { mode: "automatic" },
      },
    });
    expect(bridge.applyLlmSelection).not.toHaveBeenCalled();
    harness.controller.dispose();
  });

  it("keeps the credential draft when its captured catalog revision is no longer pinned", async () => {
    const bridge = activationBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.writeCredential.mockImplementation(async (input) => {
      if (input.selection === undefined) throw new TypeError();
      return {
        slot: input.slot,
        status: "stale-draft",
        reason: "catalog-unavailable",
        selection: input.selection,
      };
    });
    const credentialInput = {
      value: "obviously-fake-key",
      dataset: { slot: "anthropic" },
    };
    const credentials: CredentialDraftPort = {
      harvest: () => [credentialInput],
      clear: vi.fn(),
    };
    const harness = onboardingHarness(bridge, credentials);
    await harness.controller.open();
    const draft = harness.surface().draft;

    harness.controller.saveModelKey();

    await vi.waitFor(() => {
      expect(harness.controller.state()).toMatchObject({
        busy: false,
        fixedError: "configuration-unavailable",
      });
    });
    expect(harness.surface().draft).toBe(draft);
    expect(bridge.credentialStatuses).toHaveBeenCalledOnce();
    expect(bridge.applyLlmSelection).not.toHaveBeenCalled();
    expect(bridge.writeCredential).toHaveBeenCalledWith({
      slot: "anthropic",
      value: "obviously-fake-key",
      selection: {
        catalogRevision: 7,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        endpoint: { mode: "automatic" },
      },
    });
    harness.controller.dispose();
  });

  it("shows the newest model list with the error when the chosen model is gone", async () => {
    const bridge = activationBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.llmConfiguration
      .mockResolvedValueOnce(TWO_MODEL_CONFIGURATION)
      .mockResolvedValue(NEXT_CONFIGURATION);
    bridge.writeCredential.mockImplementation(async (input) => ({
      slot: input.slot,
      status: "stale-draft",
      reason: "catalog-unavailable",
      selection: input.selection!,
    }));
    const harness = onboardingHarness(bridge, {
      harvest: () => [{ value: "obviously-fake-key", dataset: { slot: "anthropic" } }],
      clear: vi.fn(),
    });
    await harness.controller.open();
    harness.controller.selectModel("claude-opus-4-7");

    harness.controller.saveModelKey();
    await vi.waitFor(() => expect(harness.controller.state().busy).toBe(false));
    await vi.waitFor(() => expect(harness.surface().configuration?.catalogRevision).toBe(8));

    expect({
      error: harness.controller.state().fixedError,
      writes: bridge.writeCredential.mock.calls.length,
      shownRevision: harness.surface().configuration?.catalogRevision,
      draft: {
        catalogRevision: harness.surface().draft?.catalogRevision,
        modelChoice: harness.surface().draft?.modelChoice,
      },
    }).toEqual({
      error: "configuration-unavailable",
      writes: 1,
      shownRevision: 8,
      draft: { catalogRevision: 8, modelChoice: "claude-sonnet-4-6" },
    });
    harness.controller.dispose();
  });

  it("moves a model the athlete chose onto the model list a refresh reads", async () => {
    const bridge = activationBridge(async () => ({ status: "configured", runtimeReady: true }));
    const nextTwoModels = { ...TWO_MODEL_CONFIGURATION, catalogRevision: 8 };
    bridge.llmConfiguration
      .mockResolvedValueOnce(TWO_MODEL_CONFIGURATION)
      .mockResolvedValue(nextTwoModels);
    const harness = onboardingHarness(bridge);
    await harness.controller.open();
    harness.controller.selectModel("claude-opus-4-7");

    await harness.controller.refresh(false);

    expect(harness.surface().draft).toMatchObject({
      catalogRevision: 8,
      provider: nextTwoModels.providers[0],
      modelChoice: "claude-opus-4-7",
    });
    harness.controller.dispose();
  });

  it("keeps the active coach ready when a draft Claude activation is refused", async () => {
    const bridge = activationBridge(async () => ({
      status: "refused",
      reason: "runtime-unavailable",
    }));
    const harness = onboardingHarness(bridge);
    await harness.controller.open();
    expect(harness.controller.state().claudeCliState).toBeNull();
    expect(bridge.claudeCliStatus).not.toHaveBeenCalled();

    harness.controller.selectProvider("claude-cli");

    await vi.waitFor(() => {
      expect(bridge.claudeCliStatus).toHaveBeenCalledOnce();
      expect(harness.controller.state()).toMatchObject({
        busy: false,
        fixedError: "model-runtime-unavailable",
      });
    });
    expect(harness.surface().readiness.provider).toBe(true);
    expect(harness.surface().configuration?.active).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      kind: "listed",
    });
    harness.controller.dispose();
  });

  it("reactivates a stored ChatGPT profile without forcing another login", async () => {
    let activated = false;
    const bridge = activationBridge(
      async () => {
        activated = true;
        return { status: "configured", runtimeReady: true };
      },
      async () => ({ state: "configured", runtimeReady: activated }),
    );
    const harness = onboardingHarness(bridge);
    await harness.controller.open();

    harness.controller.selectProvider("openai-codex");

    await vi.waitFor(() => {
      expect(harness.surface().readiness.provider).toBe(true);
    });
    expect(bridge.applyLlmSelection).toHaveBeenCalledWith({
      catalogRevision: 7,
      provider: "openai-codex",
      model: "gpt-5.5",
      endpoint: { mode: "automatic" },
    });
    expect(bridge.chatGptLogin).not.toHaveBeenCalled();
    harness.controller.dispose();
  });
});
