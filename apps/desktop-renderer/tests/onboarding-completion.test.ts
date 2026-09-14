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
  onboardingStatusRetryDelayMs,
  ONBOARDING_STATUS_COLD_START_TIMEOUT_MS,
  ONBOARDING_STATUS_LOAD_ATTEMPTS,
  type OnboardingSurfaceState,
} from "../src/onboarding/controller";
import type { CredentialDraftPort } from "../src/onboarding/credentials";
import type { OnboardingCompletion } from "../src/onboarding/machine";

const COLD_START_WINDOW_MS =
  ONBOARDING_STATUS_COLD_START_TIMEOUT_MS * ONBOARDING_STATUS_LOAD_ATTEMPTS +
  Array.from({ length: ONBOARDING_STATUS_LOAD_ATTEMPTS }, (_unused, attempt) =>
    onboardingStatusRetryDelayMs(attempt),
  ).reduce((total, delay) => total + delay, 0);

const completion = {
  providerConfigured: true,
  trainingDataConfigured: true,
  intakeSaved: true,
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
  active: { provider: "anthropic", model: "claude-sonnet-4-6" },
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
    credentialStatuses: vi.fn<OnboardingBridge["credentialStatuses"]>(async () => statuses),
    retryFailedCredentials: vi.fn<OnboardingBridge["retryFailedCredentials"]>(async () => statuses),
    writeCredential: vi.fn<OnboardingBridge["writeCredential"]>(async ({ slot }) => ({
      slot,
      status: "configured",
      runtimeReady: true,
    })),
    pasteIntervalsApiKeyFromClipboard: vi.fn<OnboardingBridge["pasteIntervalsApiKeyFromClipboard"]>(
      async () => ({
        outcome: "applied",
        current: { slot: "intervals-icu", state: "configured", runtimeState: "active" },
      }),
    ),
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
    saveIntake: vi.fn<OnboardingBridge["saveIntake"]>(async () => {}),
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

function authoritativeBridge() {
  return {
    ...activationBridge(async () => ({ status: "configured", runtimeReady: true })),
    getSetupStatus: vi.fn<NonNullable<OnboardingBridge["getSetupStatus"]>>(async () => ({
      schemaVersion: 1,
      intake: null,
      durableTrainingData: true,
    })),
  };
}

function readyAuthoritativeBridge() {
  const bridge = authoritativeBridge();
  bridge.getSetupStatus.mockResolvedValue({
    schemaVersion: 1,
    intake: expectedIntake("none"),
    durableTrainingData: true,
  });
  return bridge;
}

function expectedIntake(injuryStatus: "none" | "managing" | "returning") {
  return {
    swim_skill_floor: null,
    continuous_distance_capable: null,
    open_water_comfort: null,
    prior_bsi: false,
    clinician_cleared: null,
    injury_status: injuryStatus,
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

describe("settings intake persistence", () => {
  it("keeps a saved Settings edit in Settings while its replacement persists", async () => {
    const pending = deferred<void>();
    const bridge = readyAuthoritativeBridge();
    bridge.saveIntake.mockReturnValueOnce(pending.promise);
    const harness = onboardingHarness(bridge);
    await harness.controller.open();

    expect(harness.surface().completionRequired).toBe(false);

    harness.controller.setIntake("injuryStatus", "managing", { persistWhenComplete: true });

    expect(harness.surface().readiness.intake).toBe(false);
    expect(harness.surface().completionRequired).toBe(false);
    pending.resolve();
    await vi.waitFor(() => {
      expect(harness.surface().readiness.intake).toBe(true);
    });
    expect(harness.surface().completionRequired).toBe(false);
    expect(harness.onReady).not.toHaveBeenCalled();
    harness.controller.dispose();
  });

  it("holds an explicit recovery gate until setup completion is acknowledged", async () => {
    const bridge = readyAuthoritativeBridge();
    const harness = onboardingHarness(bridge);
    await harness.controller.open();

    harness.controller.requireCompletion();

    expect(harness.surface().completionRequired).toBe(true);
    harness.controller.finish();
    await vi.waitFor(() => {
      expect(harness.onReady).toHaveBeenCalledOnce();
    });
    expect(harness.surface().completionRequired).toBe(false);
    harness.controller.dispose();
  });

  it("persists a complete Settings answer without completing or navigating", async () => {
    const bridge = authoritativeBridge();
    const harness = onboardingHarness(bridge);
    await harness.controller.open();

    harness.controller.setIntake("injuryStatus", "none", { persistWhenComplete: true });

    await vi.waitFor(() => {
      expect(bridge.saveIntake).toHaveBeenCalledOnce();
      expect(harness.surface().readiness.intake).toBe(true);
    });
    expect(bridge.saveIntake).toHaveBeenCalledWith(expectedIntake("none"));
    expect(harness.controller.state().busy).toBe(false);
    expect(harness.onComplete).not.toHaveBeenCalled();
    expect(harness.onReady).not.toHaveBeenCalled();
    harness.controller.dispose();
  });

  it.each(["managing", "returning"] as const)(
    "persists a %s injury answer without a second question",
    async (injuryStatus) => {
      const bridge = authoritativeBridge();
      const harness = onboardingHarness(bridge);
      await harness.controller.open();

      harness.controller.setIntake("injuryStatus", injuryStatus, {
        persistWhenComplete: true,
      });

      await vi.waitFor(() => {
        expect(bridge.saveIntake).toHaveBeenCalledOnce();
      });
      expect(bridge.saveIntake).toHaveBeenCalledWith(expectedIntake(injuryStatus));
      expect(harness.onComplete).not.toHaveBeenCalled();
      expect(harness.onReady).not.toHaveBeenCalled();
      harness.controller.dispose();
    },
  );

  it("leaves Chat answers local until Start coaching saves and completes setup", async () => {
    const bridge = authoritativeBridge();
    const harness = onboardingHarness(bridge);
    await harness.controller.open();

    expect(harness.surface().completionRequired).toBe(true);

    harness.controller.setIntake("injuryStatus", "none");
    await Promise.resolve();
    expect(bridge.saveIntake).not.toHaveBeenCalled();
    expect(harness.surface().completionRequired).toBe(true);

    harness.controller.finish();

    await vi.waitFor(() => {
      expect(harness.onComplete).toHaveBeenCalledOnce();
    });
    expect(bridge.saveIntake).toHaveBeenCalledOnce();
    expect(bridge.saveIntake).toHaveBeenCalledWith(expectedIntake("none"));
    expect(harness.surface().completionRequired).toBe(false);
    expect(harness.onReady).toHaveBeenCalledOnce();
    harness.controller.dispose();
  });

  it("serializes rapid complete edits and only accepts the newest successful revision", async () => {
    const first = deferred<void>();
    const latest = deferred<void>();
    const bridge = authoritativeBridge();
    bridge.saveIntake
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => latest.promise);
    const harness = onboardingHarness(bridge);
    await harness.controller.open();

    harness.controller.setIntake("injuryStatus", "none", { persistWhenComplete: true });
    harness.controller.setIntake("injuryStatus", "managing", { persistWhenComplete: true });
    harness.controller.setIntake("injuryStatus", "returning", { persistWhenComplete: true });

    expect(bridge.saveIntake).toHaveBeenCalledOnce();
    expect(bridge.saveIntake).toHaveBeenNthCalledWith(1, expectedIntake("none"));
    first.resolve();

    await vi.waitFor(() => {
      expect(bridge.saveIntake).toHaveBeenCalledTimes(2);
    });
    expect(harness.surface().readiness.intake).toBe(false);
    expect(bridge.saveIntake).toHaveBeenNthCalledWith(2, expectedIntake("returning"));

    latest.resolve();
    await vi.waitFor(() => {
      expect(harness.surface().readiness.intake).toBe(true);
    });
    harness.controller.dispose();
  });

  it("does not persist an incomplete replacement queued behind a complete save", async () => {
    const pending = deferred<void>();
    const bridge = authoritativeBridge();
    bridge.saveIntake.mockImplementationOnce(() => pending.promise);
    const harness = onboardingHarness(bridge);
    await harness.controller.open();

    harness.controller.setIntake("injuryStatus", "none", { persistWhenComplete: true });
    harness.controller.setIntake("injuryStatus", null, { persistWhenComplete: true });
    pending.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(bridge.saveIntake).toHaveBeenCalledOnce();
    expect(harness.surface().readiness.intake).toBe(false);
    expect(harness.controller.state().fixedError).toBeNull();
    harness.controller.dispose();
  });

  it("suppresses stale failures and retries the current failed revision", async () => {
    const stale = deferred<void>();
    const current = deferred<void>();
    const bridge = authoritativeBridge();
    bridge.saveIntake
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => current.promise)
      .mockResolvedValueOnce();
    const harness = onboardingHarness(bridge);
    await harness.controller.open();

    harness.controller.setIntake("injuryStatus", "none", { persistWhenComplete: true });
    harness.controller.setIntake("injuryStatus", "returning", { persistWhenComplete: true });
    stale.reject(new Error("stale private detail"));

    await vi.waitFor(() => {
      expect(bridge.saveIntake).toHaveBeenCalledTimes(2);
    });
    expect(harness.controller.state().fixedError).toBeNull();

    current.reject(new Error("current private detail"));
    await vi.waitFor(() => {
      expect(harness.controller.state().fixedError).toBe("intake-save-failed");
    });
    expect(harness.surface().readiness.intake).toBe(false);

    harness.controller.retryIntakeSave();
    await vi.waitFor(() => {
      expect(bridge.saveIntake).toHaveBeenCalledTimes(3);
      expect(harness.controller.state().fixedError).toBeNull();
      expect(harness.surface().readiness.intake).toBe(true);
    });
    expect(bridge.saveIntake).toHaveBeenNthCalledWith(3, expectedIntake("returning"));
    harness.controller.dispose();
  });

  it("resumes the newest complete Settings save after refresh invalidates an older write", async () => {
    const stale = deferred<void>();
    const replacement = deferred<void>();
    const bridge = authoritativeBridge();
    bridge.getSetupStatus
      .mockResolvedValueOnce({ schemaVersion: 1, intake: null, durableTrainingData: true })
      .mockResolvedValueOnce({
        schemaVersion: 1,
        intake: expectedIntake("returning"),
        durableTrainingData: true,
      });
    bridge.saveIntake
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => replacement.promise);
    const harness = onboardingHarness(bridge);
    await harness.controller.open();
    harness.controller.setIntake("injuryStatus", "none", { persistWhenComplete: true });
    harness.controller.setIntake("injuryStatus", "returning", { persistWhenComplete: true });

    await harness.controller.refresh();

    expect(bridge.saveIntake).toHaveBeenCalledOnce();
    expect(harness.controller.state().intake).toEqual({ injuryStatus: "returning" });
    expect(harness.surface().readiness.intake).toBe(false);

    stale.reject(new Error("stale private detail"));
    await vi.waitFor(() => {
      expect(bridge.saveIntake).toHaveBeenCalledTimes(2);
    });
    expect(harness.controller.state().fixedError).toBeNull();
    expect(bridge.saveIntake).toHaveBeenNthCalledWith(2, expectedIntake("returning"));

    replacement.resolve();
    await vi.waitFor(() => {
      expect(harness.surface().readiness.intake).toBe(true);
    });
    expect(harness.onComplete).not.toHaveBeenCalled();
    expect(harness.onReady).not.toHaveBeenCalled();
    harness.controller.dispose();
  });

  it("accepts an authoritative matching draft on refresh without another write", async () => {
    const bridge = authoritativeBridge();
    bridge.getSetupStatus
      .mockResolvedValueOnce({ schemaVersion: 1, intake: null, durableTrainingData: true })
      .mockResolvedValueOnce({
        schemaVersion: 1,
        intake: expectedIntake("none"),
        durableTrainingData: true,
      });
    const harness = onboardingHarness(bridge);
    await harness.controller.open();
    harness.controller.setIntake("injuryStatus", "none", { persistWhenComplete: true });
    await vi.waitFor(() => {
      expect(harness.surface().readiness.intake).toBe(true);
    });
    await Promise.resolve();

    await harness.controller.refresh();

    expect(bridge.saveIntake).toHaveBeenCalledOnce();
    expect(harness.surface().readiness.intake).toBe(true);
    harness.controller.dispose();
  });

  it("keeps an open selector on its captured revision and adopts a newer revision after reopening", async () => {
    const bridge = readyAuthoritativeBridge();
    bridge.llmConfiguration
      .mockResolvedValueOnce(KEYLESS_CONFIGURATION)
      .mockResolvedValue({ ...KEYLESS_CONFIGURATION, catalogRevision: 8 });
    const harness = onboardingHarness(bridge);
    await harness.controller.open();
    harness.controller.selectProvider("claude-cli");

    expect(harness.surface().draft).toMatchObject({
      catalogRevision: 7,
      provider: { provider: "claude-cli" },
      modelChoice: "sonnet",
    });

    await harness.controller.refresh();

    expect(harness.surface().configuration?.catalogRevision).toBe(7);
    expect(harness.surface().draft).toMatchObject({
      catalogRevision: 7,
      provider: { provider: "claude-cli" },
      modelChoice: "sonnet",
    });

    harness.controller.close();
    await harness.controller.open();
    expect(harness.surface().configuration?.catalogRevision).toBe(8);
    harness.controller.selectProvider("claude-cli");
    expect(harness.surface().draft?.catalogRevision).toBe(8);
    harness.controller.dispose();
  });

  it.each(["close", "dispose"] as const)(
    "ignores late settlements and stale intake actions after %s",
    async (lifecycle) => {
      const pending = deferred<void>();
      const bridge = authoritativeBridge();
      bridge.saveIntake.mockImplementationOnce(() => pending.promise);
      const harness = onboardingHarness(bridge);
      await harness.controller.open();
      harness.controller.setIntake("injuryStatus", "none", { persistWhenComplete: true });

      harness.controller[lifecycle]();
      const closedState = harness.controller.state();
      harness.controller.setIntake("injuryStatus", "returning", {
        persistWhenComplete: true,
      });
      expect(harness.controller.state()).toBe(closedState);
      expect(bridge.saveIntake).toHaveBeenCalledOnce();

      pending.reject(new Error("late private detail"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(harness.controller.state().fixedError).toBeNull();
      expect(harness.surface().readiness.intake).toBe(false);
      expect(harness.onComplete).not.toHaveBeenCalled();
      expect(harness.onReady).not.toHaveBeenCalled();
      if (lifecycle !== "dispose") harness.controller.dispose();
    },
  );

  it("joins Finish to an active Settings save and completes exactly once", async () => {
    const pending = deferred<void>();
    const bridge = authoritativeBridge();
    bridge.saveIntake.mockImplementationOnce(() => pending.promise);
    const harness = onboardingHarness(bridge);
    await harness.controller.open();
    harness.controller.setIntake("injuryStatus", "none", { persistWhenComplete: true });

    harness.controller.finish();

    expect(harness.controller.state().busy).toBe(true);
    expect(bridge.saveIntake).toHaveBeenCalledOnce();
    pending.resolve();
    await vi.waitFor(() => {
      expect(harness.onComplete).toHaveBeenCalledOnce();
      expect(harness.onReady).toHaveBeenCalledOnce();
    });
    expect(bridge.saveIntake).toHaveBeenCalledOnce();

    harness.controller.finish();
    await Promise.resolve();
    expect(harness.onComplete).toHaveBeenCalledOnce();
    expect(harness.onReady).toHaveBeenCalledOnce();
    harness.controller.dispose();
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
          intake: {
            swim_skill_floor: null,
            continuous_distance_capable: null,
            open_water_comfort: null,
            prior_bsi: false,
            clinician_cleared: null,
            injury_status: "none",
          },
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
      harness.controller.setIntake("injuryStatus", "none");
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
      expect(bridge.pasteIntervalsApiKeyFromClipboard).not.toHaveBeenCalled();
      expect(bridge.retryFailedCredentials).not.toHaveBeenCalled();
      expect(bridge.chatGptLogin).not.toHaveBeenCalled();
      expect(bridge.applyLlmSelection).not.toHaveBeenCalled();
      expect(bridge.claudeCliRecheck).not.toHaveBeenCalled();
      expect(bridge.chooseImportFiles).not.toHaveBeenCalled();
      expect(bridge.importFiles).not.toHaveBeenCalled();
      expect(bridge.saveIntake).not.toHaveBeenCalled();
      expect(harness.controller.ownsDroppedImportFiles()).toBe(false);

      credentialStatusesHang = false;
      await harness.controller.refresh();

      expect(harness.surface().loadUnavailable).toBe(false);
      expect(harness.surface().readiness).toEqual({
        provider: true,
        trainingData: true,
        intake: true,
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
    harness.controller.setIntake("injuryStatus", "none");

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
    expect(bridge.saveIntake).not.toHaveBeenCalled();
    expect(harness.onComplete).not.toHaveBeenCalled();

    pending.resolve({ status: "configured", runtimeReady: true });
    await vi.waitFor(() => {
      expect(harness.controller.state().busy).toBe(false);
      expect(harness.surface().readiness.provider).toBe(true);
    });
    expect(harness.surface().configuration?.active).toEqual({
      provider: "claude-cli",
      model: "sonnet",
    });

    harness.controller.finish();

    await vi.waitFor(() => {
      expect(harness.onComplete).toHaveBeenCalledOnce();
    });
    expect(bridge.applyLlmSelection.mock.invocationCallOrder[0]).toBeLessThan(
      bridge.saveIntake.mock.invocationCallOrder[0]!,
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

  it("keeps the active coach ready when a draft Claude activation is refused", async () => {
    const bridge = activationBridge(async () => ({
      status: "refused",
      reason: "runtime-unavailable",
    }));
    const harness = onboardingHarness(bridge);
    await harness.controller.open();
    expect(harness.controller.state().claudeCliState).toBeNull();
    expect(bridge.claudeCliStatus).not.toHaveBeenCalled();
    harness.controller.setIntake("injuryStatus", "none");

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
