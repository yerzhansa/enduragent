import type { CoachClient } from "@enduragent/coach-client";
import type { RuntimeConfigSnapshot, SpendSummary } from "@enduragent/coach-contract";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopCoachClientProvider } from "../src/coach-client.js";
import type {
  CredentialDeleteResult,
  CredentialRecoveryStatus,
  CredentialResetResult,
  OnboardingLlmConfiguration,
  OnboardingLlmSelection,
  OnboardingLlmSelectionResult,
} from "../src/onboarding/bridge.js";
import type {
  ChatGptStatus,
  ClaudeCliStatus,
  CredentialSlotStatus,
} from "../src/onboarding/machine.js";
import { createOnboardingState } from "../src/onboarding/machine.js";
import {
  createOnboardingController,
  onboardingCredentialMutationActive,
  type OnboardingController,
} from "../src/onboarding/controller.js";
import { createAthleteSettingsController } from "../src/settings/athlete-controller.js";
import { createCredentialSettingsController } from "../src/settings/credential-controller.js";
import { createProviderModelSettingsController } from "../src/settings/provider-model-controller.js";
import { createSessionSettingsController } from "../src/settings/session-controller.js";
import {
  createTelegramSettingsController,
  type TelegramControlStatus,
} from "../src/settings/telegram-controller.js";
import { createSpendMeterController } from "../src/spend-meter/controller.js";
import { createOnboardingViewAdapter } from "../src/state/adapters/onboarding.js";
import {
  createAthleteSettingsAdapter,
  createCoachSettingsAdapter,
  createConversationSettingsAdapter,
  createCredentialSettingsAdapter,
} from "../src/state/adapters/settings.js";
import { createSpendSettingsAdapter } from "../src/state/adapters/spend.js";
import { createTelegramSettingsAdapter } from "../src/state/adapters/telegram.js";
import { createUpdateSettingsAdapter } from "../src/state/adapters/update.js";
import { credentialDrafts } from "../src/state/credential-drafts.js";
import { CLOSED_PANE, EMPTY_SETTINGS_SURFACE } from "../src/state/settings-slice.js";
import { READY_ONBOARDING, setupReady } from "../src/state/onboarding-slice.js";
import { useEnduragentStore } from "../src/state/store.js";
import type { DesktopUpdateState } from "../src/update/controller.js";
import { createDesktopUpdateController } from "../src/update/controller.js";
import { CONVERSATION_FIELDS } from "../src/ui/settings/copy.js";
import { SettingsView } from "../src/ui/settings/SettingsView.js";
import { testBridge } from "./onboarding-harness.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function snapshot(overrides: Partial<RuntimeConfigSnapshot> = {}): RuntimeConfigSnapshot {
  return {
    schemaVersion: 3,
    llm: { provider: "anthropic", model: "synthetic-model", credential_configured: true },
    intervals: {
      athlete_id: "i1",
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
    ...overrides,
  };
}

function llmConfiguration(): OnboardingLlmConfiguration {
  return {
    schemaVersion: 1,
    providers: [
      {
        provider: "anthropic",
        defaultModel: "synthetic-model",
        models: [
          { value: "synthetic-model", label: "Synthetic" },
          { value: "synthetic-fast", label: "Synthetic fast", hint: "cheap" },
        ],
      },
      {
        provider: "openrouter",
        defaultModel: "vendor/synthetic",
        models: [{ value: "vendor/synthetic", label: "Vendor synthetic" }],
      },
    ],
    active: { provider: "anthropic", model: "synthetic-model" },
  };
}

function spendSummary(overrides: Partial<SpendSummary> = {}): SpendSummary {
  return {
    localDate: "1998-07-06",
    timezone: "UTC",
    dailyCapUsd: 0.5,
    knownSpendUsd: 0.6,
    generationCount: 2,
    pricedGenerationCount: 1,
    unpricedGenerationCount: 1,
    malformedLineCount: 0,
    spendComplete: false,
    capStatus: "reached",
    cacheReadTokens: 400,
    knownCacheReadSavingsUsd: 0,
    cacheSavingsComplete: false,
    routes: [
      {
        provider: "openrouter",
        model: "anthropic/synthetic",
        generationCount: 2,
        pricedGenerationCount: 1,
        unpricedGenerationCount: 1,
        providerReportedGenerationCount: 1,
        knownSpendUsd: 0.6,
        cacheReadTokens: 400,
        cacheReadSavingsUsd: null,
        caching: "unavailable",
        disclosure: "caching unavailable on this route",
      },
    ],
    ...overrides,
  } as SpendSummary;
}

function telegramStatus(overrides: Partial<TelegramControlStatus> = {}): TelegramControlStatus {
  return {
    channel: { desiredState: "disabled", state: "disabled" },
    bot: { state: "unconfigured" },
    pairing: { state: "unpaired" },
    credentialConfigured: false,
    gapWarning: { state: "clear" },
    ...overrides,
  };
}

interface HarnessOptions {
  readonly runtime?: () => RuntimeConfigSnapshot;
  readonly configureRuntime?: (params: unknown) => Promise<unknown>;
  readonly applyLlmSelection?: (
    selection: OnboardingLlmSelection,
  ) => Promise<OnboardingLlmSelectionResult>;
  readonly llm?: () => OnboardingLlmConfiguration;
  readonly credentialStatuses?: readonly CredentialSlotStatus[];
  readonly loadCredentialStatuses?: () => Promise<readonly CredentialSlotStatus[]>;
  readonly chatGptStatus?: ChatGptStatus;
  readonly claudeCliStatus?: () => Promise<ClaudeCliStatus>;
  readonly deleteCredential?: () => Promise<CredentialDeleteResult>;
  readonly credentialRecoveryStatus?: () => Promise<CredentialRecoveryStatus>;
  readonly resetAllCredentials?: () => Promise<CredentialResetResult>;
  readonly onDeleted?: () => Promise<void> | void;
  readonly onReconciled?: () => Promise<void> | void;
  readonly updateState?: DesktopUpdateState;
  readonly spend?: () => Promise<SpendSummary>;
  readonly telegram?: TelegramControlStatus;
  readonly codexAgentSupported?: boolean;
}

function createHarness(options: HarnessOptions = {}) {
  const store = useEnduragentStore;
  const calls: { readonly method: string; readonly params: unknown }[] = [];
  const runtime = options.runtime ?? (() => snapshot());
  const client = {
    call: vi.fn(async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === "getRuntimeConfig") return runtime();
      if (method === "configureRuntime") {
        return options.configureRuntime === undefined
          ? {
              schemaVersion: 3,
              status: "applied",
              applied: { llm: true, intervals: true, session: true },
            }
          : await options.configureRuntime(params);
      }
      if (method === "getSpendSummary") {
        return options.spend === undefined ? spendSummary() : await options.spend();
      }
      if (method === "setDailySpendCap") {
        const cap = (params as { readonly dailyCapUsd: number }).dailyCapUsd;
        return spendSummary({ dailyCapUsd: cap, capStatus: "unknown" });
      }
      throw new TypeError(`unexpected rpc ${method}`);
    }),
  } as unknown as CoachClient;
  const clients: DesktopCoachClientProvider = {
    getClient: async () => client,
    reconnect: async () => client,
    close: async () => {},
  };

  const restartToUpdate = vi.fn(
    async (): Promise<DesktopUpdateState> => ({ status: "installing", version: "9.9.9" }),
  );
  const checkForUpdates = vi.fn(async (): Promise<DesktopUpdateState> => ({ status: "current" }));
  const applyLlmSelection = vi.fn(
    options.applyLlmSelection ??
      (async (): Promise<OnboardingLlmSelectionResult> => ({
        status: "configured",
        runtimeReady: true,
      })),
  );
  const deleteCredential = vi.fn(
    options.deleteCredential ??
      (async (): Promise<CredentialDeleteResult> => ({
        credential: "openrouter",
        status: "deleted",
        cleanupPending: false,
      })),
  );
  const resetAllCredentials = vi.fn(
    options.resetAllCredentials ??
      (async (): Promise<CredentialResetResult> => ({
        status: "reset",
        keyCleanupPending: false,
      })),
  );
  const openSetup = vi.fn();
  const onDeleted = vi.fn(options.onDeleted ?? (async () => {}));
  const onReconciled = vi.fn(options.onReconciled ?? (async () => {}));

  const coachAdapter = createCoachSettingsAdapter({
    publish: (state) => store.getState().patchSettings({ coach: state }),
  });
  const credentialAdapter = createCredentialSettingsAdapter({
    publish: (state) => store.getState().patchSettings({ credentials: state }),
  });
  const athleteAdapter = createAthleteSettingsAdapter({
    publish: (state) => store.getState().patchSettings({ athlete: state }),
  });
  const conversationAdapter = createConversationSettingsAdapter({
    publish: (state) => store.getState().patchSettings({ conversation: state }),
  });
  const telegramAdapter = createTelegramSettingsAdapter({
    publish: (state) => store.getState().patchSettings({ telegram: state }),
  });
  const spendAdapter = createSpendSettingsAdapter({
    read: () => store.getState().settings.spend,
    publish: (next) => store.getState().patchSettings({ spend: next }),
  });
  const updateAdapter = createUpdateSettingsAdapter({
    publish: (next) => store.getState().patchSettings({ update: next }),
  });

  const conversationController = createSessionSettingsController({
    clients,
    beginMutation: () => store.getState().beginSettingsMutation("session"),
    view: conversationAdapter.view,
  });
  const credentialController = createCredentialSettingsController({
    clients,
    loadStatuses:
      options.loadCredentialStatuses ??
      (async () =>
        options.credentialStatuses ?? [
          { slot: "anthropic", state: "configured", runtimeState: "active" },
          { slot: "openrouter", state: "configured", runtimeState: "stored-inactive" },
        ]),
    loadChatGptStatus: async () =>
      options.chatGptStatus ?? { state: "absent", runtimeReady: false },
    loadRecoveryStatus:
      options.credentialRecoveryStatus ??
      (async (): Promise<CredentialRecoveryStatus> => ({
        state: "ready",
        unverifiedEnvelopes: 0,
      })),
    resetAllCredentials,
    ...(options.claudeCliStatus === undefined
      ? {}
      : { loadClaudeCliStatus: options.claudeCliStatus }),
    deleteCredential,
    openSetup,
    onDeleted,
    onReconciled,
    credentialMutationsBlocked: () =>
      onboardingCredentialMutationActive(store.getState().onboarding),
    beginMutation: () => store.getState().beginSettingsMutation("credential"),
    view: credentialAdapter.view,
  });
  const athleteController = createAthleteSettingsController({
    clients,
    openSetup,
    beginMutation: () => store.getState().beginSettingsMutation("athlete"),
    view: athleteAdapter.view,
  });
  const coachController = createProviderModelSettingsController({
    load: async () => (options.llm ?? llmConfiguration)(),
    apply: applyLlmSelection,
    openSetup,
    beginMutation: () => store.getState().beginSettingsMutation("provider-model"),
    ...(options.codexAgentSupported === undefined
      ? {}
      : { codexAgentSupported: options.codexAgentSupported }),
    view: coachAdapter.view,
  });
  const appliedTelegram = (current: TelegramControlStatus) =>
    ({ outcome: "applied", current }) as const;
  const loadTelegramStatus = vi.fn(async () => options.telegram ?? telegramStatus());
  const pasteTelegramToken = vi.fn(async () =>
    appliedTelegram(
      telegramStatus({
        bot: { state: "ready", username: "synthetic_bot" },
        credentialConfigured: true,
      }),
    ),
  );
  const scheduleTelegramPoll = vi.fn(() => 1);
  const cancelTelegramPoll = vi.fn();
  const telegramController = createTelegramSettingsController({
    bridge: {
      status: loadTelegramStatus,
      pasteTokenFromClipboard: pasteTelegramToken,
      enable: async () =>
        appliedTelegram(
          telegramStatus({
            channel: { desiredState: "enabled", state: "starting" },
            bot: { state: "ready", username: "synthetic_bot" },
            pairing: { state: "paired" },
            credentialConfigured: true,
          }),
        ),
      disable: async () => appliedTelegram(telegramStatus()),
      remove: async () => appliedTelegram(telegramStatus()),
      reconcile: async () => appliedTelegram(telegramStatus()),
      removeWebhook: async () => appliedTelegram(telegramStatus()),
      beginPairing: async () => appliedTelegram(telegramStatus()),
      cancelPairing: async () => appliedTelegram(telegramStatus()),
      acknowledgeGapWarning: async () => appliedTelegram(telegramStatus()),
      listAllowedSenders: async () => ({ senders: [] }),
      addAllowedSender: async () => ({ outcome: "applied", current: { senders: [] } }),
      removeAllowedSender: async () => ({ outcome: "applied", current: { senders: [] } }),
    },
    beginMutation: () => store.getState().beginSettingsMutation("telegram"),
    view: telegramAdapter.view,
    setInterval: scheduleTelegramPoll as unknown as typeof globalThis.setInterval,
    clearInterval: cancelTelegramPoll as unknown as typeof globalThis.clearInterval,
  });
  const spendController = createSpendMeterController({
    clients,
    view: spendAdapter.view,
    setInterval: (() => 0) as unknown as typeof globalThis.setInterval,
    clearInterval: (() => {}) as unknown as typeof globalThis.clearInterval,
  });
  const updateController = createDesktopUpdateController({
    bridge: {
      getUpdateState: async () => options.updateState ?? { status: "idle" },
      checkForUpdates,
      restartToUpdate,
      onUpdateState: () => () => {},
    },
    view: updateAdapter.view,
  });
  store.getState().bindSettingsPorts({
    panes: {
      activate() {
        void coachController.activate();
        void credentialController.activate();
        void athleteController.activate();
        void conversationController.activate();
      },
      close() {
        coachController.close();
        credentialController.close();
        athleteController.close();
        conversationController.close();
      },
    },
    coach: coachAdapter.port,
    credentials: credentialAdapter.port,
    athlete: athleteAdapter.port,
    conversation: conversationAdapter.port,
    telegram: telegramAdapter.port,
    spend: spendAdapter.port,
    update: updateAdapter.port,
    units: { set: vi.fn() },
    openSetup,
  });
  void telegramController.activate();

  return {
    calls,
    applyLlmSelection,
    deleteCredential,
    resetAllCredentials,
    restartToUpdate,
    checkForUpdates,
    openSetup,
    onDeleted,
    onReconciled,
    pasteTelegramToken,
    loadTelegramStatus,
    scheduleTelegramPoll,
    cancelTelegramPoll,
    telegramController,
    spendController,
    startUpdate: () => updateController.start(),
    dispose() {
      coachController.dispose();
      credentialController.dispose();
      athleteController.dispose();
      conversationController.dispose();
      telegramController.dispose();
      spendController.dispose();
      updateController.dispose();
      store.getState().bindSettingsPorts(null);
    },
  };
}

let harness: ReturnType<typeof createHarness> | undefined;

beforeEach(() => {
  const configuration = llmConfiguration();
  const provider = configuration.providers[0]!;
  const statuses = [
    { slot: "anthropic", state: "configured", runtimeState: "active" },
    { slot: "openrouter", state: "configured", runtimeState: "stored-inactive" },
    { slot: "intervals-icu", state: "configured", runtimeState: "active" },
  ] as const;
  useEnduragentStore.setState({
    activeView: "settings",
    settings: EMPTY_SETTINGS_SURFACE,
    settingsPorts: null,
    chatActions: null,
    onboarding: {
      ...READY_ONBOARDING,
      wizard: createOnboardingState(statuses),
      statuses,
      configuration,
      draft: {
        provider,
        modelChoice: provider.defaultModel,
        customModel: "",
        endpointMode: "automatic",
        customEndpoint: "",
      },
    },
    onboardingActions: {
      requireCompletion() {},
      selectProvider(selected: string) {
        useEnduragentStore.setState((state) => {
          const selectedProvider = state.onboarding.configuration?.providers.find(
            (entry) => entry.provider === selected,
          );
          if (selectedProvider === undefined) return state;
          return {
            onboarding: {
              ...state.onboarding,
              draft: {
                provider: selectedProvider,
                modelChoice: selectedProvider.defaultModel,
                customModel: "",
                endpointMode: "automatic",
                customEndpoint: "",
              },
            },
          };
        });
      },
      selectModel() {},
      setCustomModel() {},
      setEndpointMode() {},
      setCustomEndpoint() {},
    } as unknown as OnboardingController,
  });
});

afterEach(() => {
  harness?.dispose();
  harness = undefined;
  useEnduragentStore.setState({
    activeView: "chat",
    settings: EMPTY_SETTINGS_SURFACE,
    settingsPorts: null,
  });
});

async function renderSettings(options: HarnessOptions = {}) {
  harness = createHarness(options);
  render(<SettingsView />);
  await screen.findByRole("button", { name: "Save coach route" });
  await waitFor(() => {
    expect(useEnduragentStore.getState().settings.coach.status).toBe("ready");
    expect(useEnduragentStore.getState().settings.conversation.status).toBe("ready");
    expect(useEnduragentStore.getState().settings.credentials.status).toBe("ready");
  });
  return harness;
}

describe("settings setup inventory", () => {
  it("reloads a stale credential inventory before confirming an Intervals deletion", async () => {
    const user = userEvent.setup();
    let intervalsConnected = false;
    const loadCredentialStatuses = vi.fn(
      async (): Promise<readonly CredentialSlotStatus[]> => [
        { slot: "anthropic", state: "configured", runtimeState: "active" },
        ...(intervalsConnected
          ? ([{ slot: "intervals-icu", state: "configured", runtimeState: "active" }] as const)
          : []),
      ],
    );
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.credentialStatuses.mockImplementation(loadCredentialStatuses);
    bridge.pasteIntervalsApiKeyFromClipboard.mockImplementation(async () => {
      intervalsConnected = true;
      return {
        outcome: "applied",
        current: { slot: "intervals-icu", state: "configured", runtimeState: "active" },
      };
    });
    const onboardingView = createOnboardingViewAdapter({
      publish: (next) => useEnduragentStore.getState().setOnboarding(next),
    });
    const onboarding = createOnboardingController({
      bridge,
      credentials: credentialDrafts,
      view: onboardingView.view,
      focusOpener: vi.fn(),
      onComplete: vi.fn(),
    });
    useEnduragentStore.getState().bindOnboardingActions(onboarding);

    try {
      await act(async () => onboarding.open());
      await renderSettings({
        runtime: () =>
          snapshot({
            intervals: {
              athlete_id: "i1",
              credential_configured: intervalsConnected,
              managedByEnvironment: { athleteId: false },
            },
          }),
        loadCredentialStatuses,
      });

      expect(useEnduragentStore.getState().settings.credentials).toMatchObject({
        status: "ready",
        entries: expect.not.arrayContaining([
          expect.objectContaining({ credential: "intervals-icu" }),
        ]),
      });
      expect(loadCredentialStatuses).toHaveBeenCalledTimes(2);

      await user.click(screen.getByRole("button", { name: "Connect Intervals.icu" }));
      await user.click(screen.getByRole("button", { name: "Use copied API key" }));
      const remove = await screen.findByRole("button", {
        name: "Delete the Intervals.icu connection",
      });
      await waitFor(() => expect(remove).toHaveFocus());
      expect(useEnduragentStore.getState().settings.credentials).toMatchObject({
        status: "ready",
        entries: expect.not.arrayContaining([
          expect.objectContaining({ credential: "intervals-icu" }),
        ]),
      });
      expect(loadCredentialStatuses).toHaveBeenCalledTimes(2);

      await user.click(remove);

      expect(await screen.findByText("Delete the Intervals.icu connection?")).toBeInTheDocument();
      const cancel = screen.getByRole("button", { name: "Cancel" });
      await waitFor(() => expect(cancel).toHaveFocus());
      expect(loadCredentialStatuses).toHaveBeenCalledTimes(3);
    } finally {
      onboarding.dispose();
      onboardingView.dispose();
      useEnduragentStore.getState().bindOnboardingActions(null);
    }
  });

  it("renders setup first without standalone Credentials or Application setup actions", async () => {
    await renderSettings();
    const settings = screen.getByRole("region", { name: "Settings" });
    const setup = settings.querySelector('[data-setup-host="settings"]');
    expect(setup).not.toBeNull();
    expect(within(setup as HTMLElement).getByRole("heading", { level: 2 })).toHaveTextContent(
      "Setup",
    );
    expect(setup?.nextElementSibling?.textContent).toBe("Channels");
    const aiRow = setup?.querySelector<HTMLElement>('[data-setup-row="ai"]');
    const trainingRow = setup?.querySelector<HTMLElement>('[data-setup-row="training"]');
    expect(aiRow).not.toBeNull();
    expect(trainingRow).not.toBeNull();
    expect(
      within(aiRow as HTMLElement).getByRole("button", { name: "Change what powers your coach" })
        .className,
    ).toContain("border-transparent");
    expect(
      within(trainingRow as HTMLElement).getByRole("button", {
        name: "Delete the Intervals.icu connection",
      }).className,
    ).toContain("text-destructive");
    expect(
      within(aiRow as HTMLElement).getByRole("button", {
        name: "Delete the Anthropic credential",
      }).className,
    ).toMatch(/destructive/u);
    expect(
      within(trainingRow as HTMLElement).queryByRole("button", {
        name: "Change Intervals.icu",
      }),
    ).toBeNull();
    expect(setup?.querySelector('[data-setup-row="saved-anthropic"]')).toBeNull();
    expect(setup?.querySelector('[data-setup-row="saved-openrouter"]')).not.toBeNull();
    expect(screen.queryByRole("region", { name: "Credentials" })).toBeNull();
    expect(
      within(screen.getByRole("region", { name: "Application" })).queryByRole("button", {
        name: "Open setup",
      }),
    ).toBeNull();
  });

  it("opens the chooser for an inactive saved key without changing active readiness", async () => {
    const user = userEvent.setup();
    await renderSettings();
    const inactive = document.querySelector<HTMLElement>('[data-setup-row="saved-openrouter"]');
    expect(inactive).not.toBeNull();

    expect(
      within(inactive as HTMLElement).getByRole("button", {
        name: "Change the OpenRouter credential",
      }).className,
    ).toContain("border-transparent");

    await user.click(
      within(inactive as HTMLElement).getByRole("button", {
        name: "Change the OpenRouter credential",
      }),
    );

    await waitFor(() =>
      expect(document.querySelector('[data-setup-panel="api-key"]')).not.toBeNull(),
    );
    expect(document.querySelector('[data-setup-menu="ai"]')).toBeNull();
    expect(screen.getByLabelText("Provider")).toHaveTextContent("OpenRouter");
    expect(useEnduragentStore.getState().onboarding.configuration?.active).toEqual({
      provider: "anthropic",
      model: "synthetic-model",
    });
    expect(setupReady(useEnduragentStore.getState())).toBe(true);
  });
});

describe("Telegram settings surface", () => {
  it("warns that an uncertain primary claim may become visible after restart", async () => {
    await renderSettings({
      telegram: telegramStatus({
        bot: { state: "ready", username: "synthetic_bot" },
        pairing: { state: "failed", errorCode: "telegram-pairing-storage-uncertain" },
        credentialConfigured: true,
      }),
    });

    expect(
      await screen.findByText(
        "The primary Telegram user may have been saved, but Enduragent could not verify storage. Restart Enduragent and check Telegram before pairing again.",
      ),
    ).toBeInTheDocument();
  });
});

describe("settings mutation lock", () => {
  it("disables other panes and blocks leaving Settings while one pane saves", async () => {
    const user = userEvent.setup();
    const pending = deferred<unknown>();
    const subject = await renderSettings({
      configureRuntime: () => pending.promise,
    });

    await user.clear(screen.getByLabelText("Idle reset (minutes)"));
    await user.type(screen.getByLabelText("Idle reset (minutes)"), "45");
    await user.click(screen.getByRole("button", { name: "Save conversation settings" }));

    await waitFor(() => {
      expect(useEnduragentStore.getState().settings.savingOwners).toEqual(["session"]);
    });
    expect(screen.getByRole("region", { name: "Settings" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Save athlete ID" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: /Provider/u })).toBeDisabled();
    expect(
      within(screen.getByRole("region", { name: "Application" })).queryByRole("button", {
        name: "Open setup",
      }),
    ).toBeNull();

    act(() => {
      useEnduragentStore.getState().setActiveView("chat");
    });
    expect(useEnduragentStore.getState().activeView).toBe("settings");

    await act(async () => {
      pending.resolve({
        schemaVersion: 3,
        status: "applied",
        applied: { llm: true, intervals: true, session: true },
      });
      await pending.promise;
    });
    await waitFor(() => {
      expect(useEnduragentStore.getState().settings.savingOwners).toEqual([]);
    });
    expect(screen.getByRole("region", { name: "Settings" })).not.toHaveAttribute("aria-busy");
    expect(subject.calls.some((call) => call.method === "configureRuntime")).toBe(true);
  });

  it("holds the update action until the active settings mutation settles", async () => {
    const user = userEvent.setup();
    const pending = deferred<unknown>();
    const subject = await renderSettings({
      configureRuntime: () => pending.promise,
      updateState: { status: "downloaded", version: "1998.7.7" },
    });
    await act(async () => {
      await subject.startUpdate();
    });

    const updateAction = await screen.findByRole("button", {
      name: "Restart to update to version 1998.7.7",
    });
    expect(updateAction).toBeEnabled();

    await user.clear(screen.getByLabelText("Idle reset (minutes)"));
    await user.type(screen.getByLabelText("Idle reset (minutes)"), "45");
    await user.click(screen.getByRole("button", { name: "Save conversation settings" }));

    await waitFor(() => {
      expect(useEnduragentStore.getState().settings.savingOwners).toEqual(["session"]);
    });
    expect(updateAction).toBeDisabled();
    await user.click(updateAction);
    expect(subject.restartToUpdate).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve({
        schemaVersion: 3,
        status: "applied",
        applied: { llm: true, intervals: true, session: true },
      });
      await pending.promise;
    });
    await waitFor(() => {
      expect(updateAction).toBeEnabled();
    });

    await user.click(updateAction);
    await waitFor(() => {
      expect(subject.restartToUpdate).toHaveBeenCalledTimes(1);
    });
  });
});

describe("conversation settings", () => {
  it("sends only the dirty fields", async () => {
    const user = userEvent.setup();
    const subject = await renderSettings();

    await user.clear(screen.getByLabelText("Idle reset (minutes)"));
    await user.type(screen.getByLabelText("Idle reset (minutes)"), "45");
    await user.click(screen.getByRole("button", { name: "Save conversation settings" }));

    await waitFor(() => {
      expect(subject.calls.filter((call) => call.method === "configureRuntime")).toHaveLength(1);
    });
    expect(subject.calls.find((call) => call.method === "configureRuntime")?.params).toEqual({
      session: { idleMinutes: 45 },
    });
  });

  it("keeps the timezone field editable and saves the zone in one runtime mutation", async () => {
    const user = userEvent.setup();
    const subject = await renderSettings();

    const timezone = screen.getByLabelText("Timezone");
    expect(timezone).toBeEnabled();
    await user.clear(timezone);
    await user.type(timezone, "Asia/Qyzylorda");
    await user.click(screen.getByRole("button", { name: "Save conversation settings" }));

    await waitFor(() => {
      expect(useEnduragentStore.getState().settings.conversation.status).toBe("saved");
    });
    expect(subject.calls.find((call) => call.method === "configureRuntime")?.params).toEqual({
      session: { timezone: "Asia/Qyzylorda" },
    });
    expect(subject.calls.filter((call) => call.method === "configureRuntime")).toHaveLength(1);
  });

  it("keeps a managed field read-only", async () => {
    await renderSettings({
      runtime: () =>
        snapshot({
          session: {
            ...snapshot().session,
            managedByEnvironment: {
              ...snapshot().session.managedByEnvironment,
              timezone: true,
            },
          },
        }),
    });

    expect(screen.getByLabelText("Timezone")).toBeDisabled();
    expect(
      screen.getAllByText("Managed by an environment variable. Change it outside Enduragent."),
    ).not.toHaveLength(0);
  });

  it("shows the training credential as verifying while owner verification is pending", async () => {
    await renderSettings({
      runtime: () =>
        snapshot({
          intervals: {
            athlete_id: "i1",
            credential_configured: true,
            credential_verification_pending: true,
            managedByEnvironment: { athleteId: false },
          },
        }),
    });

    const note = await screen.findByText(/Verifying the connected training account/u);
    expect(note).toHaveAttribute("id", "athlete-id-verifying");
    expect(screen.getByLabelText("Athlete ID").getAttribute("aria-describedby")).toContain(
      "athlete-id-verifying",
    );
  });

  it("warns the athlete about the session-lifecycle side effects", async () => {
    await renderSettings();

    const resetHour = CONVERSATION_FIELDS.find((field) => field.field === "dailyResetHour");
    const retention = CONVERSATION_FIELDS.find(
      (field) => field.field === "resetArchiveRetentionDays",
    );
    expect(resetHour?.help).toContain("may make your next message start a fresh conversation");
    expect(retention?.help).toContain("changes apply only to future pruning");

    expect(
      screen.getByText(/may make your next message start a fresh conversation/u),
    ).toHaveAttribute("id", "conversation-dailyResetHour-help");
    expect(screen.getByText(/changes apply only to future pruning/u)).toHaveAttribute(
      "id",
      "conversation-resetArchiveRetentionDays-help",
    );
    expect(screen.getByLabelText("Daily reset hour")).toHaveAttribute(
      "aria-describedby",
      "conversation-dailyResetHour-help",
    );
    expect(screen.getByLabelText("Archive retention (days)")).toHaveAttribute(
      "aria-describedby",
      "conversation-resetArchiveRetentionDays-help",
    );
  });
});

describe("settings lifecycle", () => {
  it("keeps the resident Telegram controller active when Settings unmounts and remounts", async () => {
    harness = createHarness();
    const view = render(<SettingsView />);
    await screen.findByRole("button", { name: "Save coach route" });
    await waitFor(() => {
      expect(useEnduragentStore.getState().settings.conversation.status).toBe("ready");
      expect(useEnduragentStore.getState().settings.coach.status).toBe("ready");
      expect(useEnduragentStore.getState().settings.athlete.status).toBe("ready");
      expect(useEnduragentStore.getState().settings.credentials.status).toBe("ready");
      expect(useEnduragentStore.getState().settings.telegram.status).toBe("ready");
    });
    const loads = harness.calls.filter((call) => call.method === "getRuntimeConfig").length;
    const telegram = useEnduragentStore.getState().settings.telegram;
    expect(loads).toBeGreaterThan(0);
    expect(harness.loadTelegramStatus).toHaveBeenCalledOnce();
    expect(harness.scheduleTelegramPoll).toHaveBeenCalledOnce();

    view.unmount();

    const settings = useEnduragentStore.getState().settings;
    expect(settings.coach).toEqual(CLOSED_PANE);
    expect(settings.credentials).toEqual(CLOSED_PANE);
    expect(settings.athlete).toEqual(CLOSED_PANE);
    expect(settings.conversation).toEqual(CLOSED_PANE);
    expect(settings.telegram).toBe(telegram);
    expect(harness.telegramController.state()).toBe(telegram);
    expect(harness.cancelTelegramPoll).not.toHaveBeenCalled();

    render(<SettingsView />);
    await waitFor(() => {
      expect(useEnduragentStore.getState().settings.conversation.status).toBe("ready");
    });
    expect(
      harness.calls.filter((call) => call.method === "getRuntimeConfig").length,
    ).toBeGreaterThan(loads);
    expect(useEnduragentStore.getState().settings.telegram).toBe(telegram);
    expect(harness.loadTelegramStatus).toHaveBeenCalledOnce();
    expect(harness.scheduleTelegramPoll).toHaveBeenCalledOnce();
    expect(harness.cancelTelegramPoll).not.toHaveBeenCalled();

    harness.dispose();
    expect(harness.cancelTelegramPoll).toHaveBeenCalledWith(1);
    harness = undefined;
  });
});

describe("credential deletion", () => {
  it("does not offer full reset for verified credentials without repair", async () => {
    await renderSettings();

    expect(screen.queryByRole("button", { name: "Remove all credentials" })).toBeNull();
  });

  it("offers inline removal when saved credentials are unverified", async () => {
    const user = userEvent.setup();
    const subject = await renderSettings({
      credentialRecoveryStatus: async () => ({ state: "ready", unverifiedEnvelopes: 1 }),
    });

    await user.click(screen.getByRole("button", { name: "Remove all credentials" }));

    const confirmation = screen.getByRole("group", { name: "Remove all credentials?" });
    await waitFor(() =>
      expect(within(confirmation).getByRole("button", { name: "Cancel" })).toHaveFocus(),
    );
    expect(subject.resetAllCredentials).not.toHaveBeenCalled();

    await user.click(within(confirmation).getByRole("button", { name: "Remove all credentials" }));
    await waitFor(() => expect(subject.resetAllCredentials).toHaveBeenCalledOnce());
  });

  it("offers explicit full reset after an uncertain per-slot deletion", async () => {
    const user = userEvent.setup();
    const subject = await renderSettings({
      deleteCredential: async () => ({
        slot: "openrouter",
        status: "uncertain",
        reason: "storage-uncertain",
      }),
    });

    await user.click(screen.getByRole("button", { name: "Delete the OpenRouter credential" }));
    await user.click(
      screen.getByRole("button", { name: "Confirm deletion of the OpenRouter credential" }),
    );
    await screen.findByText(
      "Credential deletion could not be confirmed because secure storage could not be verified. Restart Enduragent and reload before trying again.",
    );

    expect(screen.getByRole("button", { name: "Delete the Anthropic credential" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete the OpenRouter credential" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Delete the Intervals.icu connection" }),
    ).toBeDisabled();
    const reset = screen.getByRole("button", { name: "Remove all credentials" });
    expect(reset).toBeEnabled();

    await user.click(reset);
    const confirmation = screen.getByRole("group", { name: "Remove all credentials?" });
    await waitFor(() =>
      expect(within(confirmation).getByRole("button", { name: "Cancel" })).toHaveFocus(),
    );
    await user.click(within(confirmation).getByRole("button", { name: "Remove all credentials" }));

    await waitFor(() => expect(subject.resetAllCredentials).toHaveBeenCalledOnce());
  });

  it("cross-locks setup changes while deletion is confirmed and pending", async () => {
    const user = userEvent.setup();
    const deletion = deferred<CredentialDeleteResult>();
    const subject = await renderSettings({ deleteCredential: () => deletion.promise });

    await user.click(screen.getByRole("button", { name: "Delete the OpenRouter credential" }));
    expect(screen.getByRole("button", { name: "Change what powers your coach" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Delete the Intervals.icu connection" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Change the OpenRouter credential" })).toBeDisabled();

    await user.click(
      screen.getByRole("button", { name: "Confirm deletion of the OpenRouter credential" }),
    );
    await waitFor(() => expect(subject.deleteCredential).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Change what powers your coach" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Delete the Intervals.icu connection" }),
    ).toBeDisabled();

    act(() =>
      deletion.resolve({
        credential: "openrouter",
        status: "refused",
        reason: "storage-failed",
      }),
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Change what powers your coach" })).toBeEnabled();
      expect(
        screen.getByRole("button", { name: "Delete the Intervals.icu connection" }),
      ).toBeEnabled();
      expect(
        screen.getByRole("button", { name: "Change the OpenRouter credential" }),
      ).toBeEnabled();
    });
  });

  it("cross-locks delete and saved-key changes while onboarding mutates credentials", async () => {
    await renderSettings();

    act(() => {
      useEnduragentStore.setState((state) => ({
        onboarding: {
          ...state.onboarding,
          wizard: { ...state.onboarding.wizard, busy: true },
        },
      }));
    });

    expect(screen.getByRole("button", { name: "Delete the Anthropic credential" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete the OpenRouter credential" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Delete the Intervals.icu connection" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Change the OpenRouter credential" })).toBeDisabled();

    act(() => {
      useEnduragentStore.setState((state) => ({
        onboarding: {
          ...state.onboarding,
          wizard: { ...state.onboarding.wizard, busy: false },
        },
      }));
    });
    expect(screen.getByRole("button", { name: "Delete the Anthropic credential" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Delete the OpenRouter credential" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Change the OpenRouter credential" })).toBeEnabled();
  });

  it("confirms in two steps and restores focus when cancelled", async () => {
    const user = userEvent.setup();
    const subject = await renderSettings();

    const remove = screen.getByRole("button", { name: "Delete the OpenRouter credential" });
    await user.click(remove);

    expect(screen.getByText("Delete the OpenRouter credential?")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    });
    expect(subject.deleteCredential).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Delete the OpenRouter credential" }),
      ).toHaveFocus();
    });
    expect(screen.getByText("Credential deletion cancelled.")).toBeInTheDocument();
  });

  it("deletes on the second confirmation and announces the outcome", async () => {
    const user = userEvent.setup();
    const subject = await renderSettings();

    await user.click(screen.getByRole("button", { name: "Delete the OpenRouter credential" }));
    await user.click(
      screen.getByRole("button", { name: "Confirm deletion of the OpenRouter credential" }),
    );

    await waitFor(() => {
      expect(subject.deleteCredential).toHaveBeenCalledWith({ credential: "openrouter" });
    });
    await waitFor(() => {
      expect(screen.getByText("Credential deleted locally.")).toBeInTheDocument();
    });
  });

  it("returns focus to the matching setup action after active deletion", async () => {
    const user = userEvent.setup();
    await renderSettings();

    await user.click(screen.getByRole("button", { name: "Delete the Anthropic credential" }));
    await user.click(
      screen.getByRole("button", { name: "Confirm deletion of the Anthropic credential" }),
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Change what powers your coach" })).toHaveFocus();
    });
  });

  it("restores focus to the Intervals Delete action when confirmation is escaped", async () => {
    const user = userEvent.setup();
    await renderSettings();

    const remove = screen.getByRole("button", {
      name: "Delete the Intervals.icu connection",
    });
    await user.click(remove);
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());

    await user.keyboard("{Escape}");

    await waitFor(() => expect(remove).toHaveFocus());
    expect(screen.queryByText("Delete the Intervals.icu connection?")).toBeNull();
  });

  it("opens and focuses first-time Intervals setup after deletion without lowering durable readiness", async () => {
    const user = userEvent.setup();
    let intervalsConfigured = true;
    const subject = await renderSettings({
      runtime: () =>
        snapshot({
          intervals: {
            athlete_id: "i1",
            credential_configured: intervalsConfigured,
            managedByEnvironment: { athleteId: false },
          },
        }),
      deleteCredential: async () => {
        intervalsConfigured = false;
        return {
          credential: "intervals-icu",
          status: "deleted",
          cleanupPending: false,
        };
      },
      onDeleted: () => {
        useEnduragentStore.setState((state) => ({
          onboarding: {
            ...state.onboarding,
            wizard: {
              ...state.onboarding.wizard,
              credentialStatus: {
                ...state.onboarding.wizard.credentialStatus,
                "intervals-icu": "missing",
              },
            },
          },
        }));
      },
    });

    await user.click(screen.getByRole("button", { name: "Delete the Intervals.icu connection" }));
    await user.click(screen.getByRole("button", { name: "Delete connection" }));

    await waitFor(() => {
      expect(subject.deleteCredential).toHaveBeenCalledWith({ credential: "intervals-icu" });
      expect(subject.onDeleted).toHaveBeenCalledOnce();
      expect(screen.getByRole("heading", { name: "Connect Intervals.icu" })).toHaveFocus();
    });
    expect(screen.getByRole("button", { name: "Connect Intervals.icu" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(useEnduragentStore.getState().onboarding.readiness.trainingData).toBe(true);
    expect(setupReady(useEnduragentStore.getState())).toBe(true);
    expect(useEnduragentStore.getState().settings.credentials).toMatchObject({
      status: "deleted",
      focus: null,
    });
  });

  it("globally locks credentials and clears an open provider secret after uncertain deletion", async () => {
    const user = userEvent.setup();
    await renderSettings({
      deleteCredential: async () => ({
        slot: "openrouter",
        status: "uncertain",
        reason: "storage-uncertain",
      }),
    });

    await user.click(screen.getByRole("button", { name: "Change the OpenRouter credential" }));
    const secret = await screen.findByLabelText("OpenRouter API key");
    await user.type(secret, "synthetic-openrouter-secret");
    expect(secret).toHaveValue("synthetic-openrouter-secret");

    await user.click(screen.getByRole("button", { name: "Delete the OpenRouter credential" }));
    await user.click(
      screen.getByRole("button", { name: "Confirm deletion of the OpenRouter credential" }),
    );

    const feedback = await screen.findByText(
      "Credential deletion could not be confirmed because secure storage could not be verified. Restart Enduragent and reload before trying again.",
    );
    expect(feedback).toHaveAttribute("role", "status");
    expect(feedback.textContent?.toLowerCase()).not.toContain("credential deleted");
    expect(feedback.textContent?.toLowerCase()).not.toContain("remains stored");
    expect(feedback.textContent?.toLowerCase()).not.toContain("was not deleted");
    await waitFor(() => expect(feedback.parentElement).toHaveFocus());
    await waitFor(() => {
      expect(document.querySelector('[data-setup-panel="api-key"]')).toBeNull();
      expect(secret).toHaveValue("");
      expect(useEnduragentStore.getState().onboarding.draft?.provider.provider).toBe("anthropic");
    });
    expect(screen.getByRole("button", { name: "Change what powers your coach" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete the Anthropic credential" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Change the OpenRouter credential" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete the OpenRouter credential" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Delete the Intervals.icu connection" }),
    ).toBeDisabled();
    expect(setupReady(useEnduragentStore.getState())).toBe(false);

    await user.click(screen.getByRole("button", { name: "Reload credential status" }));
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Change the OpenRouter credential" }),
      ).toBeEnabled();
      expect(screen.getByRole("button", { name: "Change what powers your coach" })).toHaveFocus();
      expect(
        screen.getByRole("button", { name: "Delete the Intervals.icu connection" }),
      ).toBeEnabled();
    });
    expect(setupReady(useEnduragentStore.getState())).toBe(true);
  });

  it("fails closed and requires reload when the delete bridge rejects", async () => {
    const user = userEvent.setup();
    const subject = await renderSettings({
      deleteCredential: async () => {
        throw new Error("synthetic bridge rejection");
      },
    });

    await user.click(screen.getByRole("button", { name: "Delete the OpenRouter credential" }));
    await user.click(
      screen.getByRole("button", { name: "Confirm deletion of the OpenRouter credential" }),
    );

    const feedback = await screen.findByText(
      "Credential deletion could not be confirmed because secure storage could not be verified. Restart Enduragent and reload before trying again.",
    );
    await waitFor(() => expect(feedback.parentElement).toHaveFocus());
    expect(useEnduragentStore.getState().settings.credentials).toMatchObject({
      status: "error",
      kind: "delete",
      reason: "storage-uncertain",
      repairCredential: "openrouter",
    });
    expect(screen.getByRole("button", { name: "Change what powers your coach" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Delete the Intervals.icu connection" }),
    ).toBeDisabled();
    expect(setupReady(useEnduragentStore.getState())).toBe(false);

    await user.click(screen.getByRole("button", { name: "Reload credential status" }));
    await waitFor(() => {
      expect(subject.onReconciled).toHaveBeenCalledOnce();
      expect(screen.getByRole("button", { name: "Change what powers your coach" })).toBeEnabled();
    });
    expect(setupReady(useEnduragentStore.getState())).toBe(true);
  });

  it("fails closed when deletion leaves saved and active runtime state diverged", async () => {
    const user = userEvent.setup();
    const subject = await renderSettings({
      deleteCredential: async () => ({
        credential: "anthropic",
        status: "refused",
        reason: "runtime-state-diverged",
      }),
    });

    await user.click(screen.getByRole("button", { name: "Delete the Anthropic credential" }));
    await user.click(
      screen.getByRole("button", { name: "Confirm deletion of the Anthropic credential" }),
    );

    const feedback = await screen.findByText(
      "The saved and active credential states could not be reconciled. Reconnect and reload before trying again.",
    );
    await waitFor(() => expect(feedback.parentElement).toHaveFocus());
    expect(useEnduragentStore.getState().settings.credentials).toMatchObject({
      status: "error",
      kind: "delete",
      reason: "runtime-state-diverged",
      repairCredential: "anthropic",
    });
    expect(screen.getByRole("button", { name: "Change what powers your coach" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Delete the Intervals.icu connection" }),
    ).toBeDisabled();
    expect(setupReady(useEnduragentStore.getState())).toBe(false);

    await user.click(screen.getByRole("button", { name: "Reload credential status" }));
    await waitFor(() => {
      expect(subject.onReconciled).toHaveBeenCalledOnce();
      expect(screen.getByRole("button", { name: "Change what powers your coach" })).toBeEnabled();
    });
    expect(setupReady(useEnduragentStore.getState())).toBe(true);
  });

  it("keeps Intervals secrets out of the DOM and preserves repair feedback after uncertainty", async () => {
    const user = userEvent.setup();
    await renderSettings({
      deleteCredential: async () => ({
        slot: "intervals-icu",
        status: "uncertain",
        reason: "storage-uncertain",
      }),
    });

    expect(screen.queryByLabelText("Intervals.icu API key")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Delete the Intervals.icu connection" }));
    expect(screen.getByText("Delete the Intervals.icu connection?")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Your saved API key and imported connection will be removed. Your synced rides and past chats stay on this Mac.",
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete connection" }));

    const feedback = await screen.findByText(
      "Credential deletion could not be confirmed because secure storage could not be verified. Restart Enduragent and reload before trying again.",
    );
    await waitFor(() => {
      expect(feedback.parentElement).toHaveFocus();
      expect(document.querySelector('[data-setup-panel="training"]')).toBeNull();
    });
    expect(screen.queryByLabelText("Intervals.icu API key")).toBeNull();
    expect(screen.getByRole("button", { name: "Change what powers your coach" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete the Anthropic credential" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Change the OpenRouter credential" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete the OpenRouter credential" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Delete the Intervals.icu connection" }),
    ).toBeDisabled();
    expect(setupReady(useEnduragentStore.getState())).toBe(false);

    await user.click(screen.getByRole("button", { name: "Reload credential status" }));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Setup" })).toHaveFocus();
      expect(
        screen.getByRole("button", { name: "Change the OpenRouter credential" }),
      ).toBeEnabled();
      expect(
        screen.getByRole("button", { name: "Delete the Intervals.icu connection" }),
      ).toBeEnabled();
    });
    expect(setupReady(useEnduragentStore.getState())).toBe(true);
  });

  it("keeps the repair lock and feedback through pending and failed reloads", async () => {
    const user = userEvent.setup();
    const pendingReload = deferred<readonly CredentialSlotStatus[]>();
    const statuses = [
      { slot: "anthropic", state: "configured", runtimeState: "active" },
      { slot: "openrouter", state: "configured", runtimeState: "stored-inactive" },
    ] as const;
    const loadCredentialStatuses = vi
      .fn<() => Promise<readonly CredentialSlotStatus[]>>()
      .mockResolvedValueOnce(statuses)
      .mockImplementationOnce(() => pendingReload.promise)
      .mockResolvedValueOnce(statuses);
    await renderSettings({
      loadCredentialStatuses,
      deleteCredential: async () => ({
        slot: "openrouter",
        status: "uncertain",
        reason: "storage-uncertain",
      }),
    });

    await user.click(screen.getByRole("button", { name: "Delete the OpenRouter credential" }));
    await user.click(
      screen.getByRole("button", { name: "Confirm deletion of the OpenRouter credential" }),
    );
    const message =
      "Credential deletion could not be confirmed because secure storage could not be verified. Restart Enduragent and reload before trying again.";
    const feedback = await screen.findByText(message);
    const reload = screen.getByRole("button", { name: "Reload credential status" });

    await user.click(reload);
    await waitFor(() => {
      expect(loadCredentialStatuses).toHaveBeenCalledTimes(2);
      expect(reload).toBeDisabled();
      expect(feedback.parentElement).toHaveFocus();
    });
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change what powers your coach" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Delete the Intervals.icu connection" }),
    ).toBeDisabled();
    expect(setupReady(useEnduragentStore.getState())).toBe(false);

    act(() => pendingReload.reject(new Error("synthetic reload failure")));
    await waitFor(() => {
      expect(useEnduragentStore.getState().settings.credentials).toMatchObject({
        status: "error",
        kind: "load",
        repairCredential: "openrouter",
      });
      expect(screen.getByRole("button", { name: "Reload credential status" })).toBeEnabled();
      expect(screen.getByText(message).parentElement).toHaveFocus();
    });
    expect(screen.getByRole("button", { name: "Change what powers your coach" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Delete the Intervals.icu connection" }),
    ).toBeDisabled();
    expect(setupReady(useEnduragentStore.getState())).toBe(false);

    await user.click(screen.getByRole("button", { name: "Reload credential status" }));
    await waitFor(() => {
      expect(loadCredentialStatuses).toHaveBeenCalledTimes(3);
      expect(screen.getByRole("button", { name: "Change what powers your coach" })).toBeEnabled();
      expect(
        screen.getByRole("button", { name: "Delete the Intervals.icu connection" }),
      ).toBeEnabled();
    });
    expect(setupReady(useEnduragentStore.getState())).toBe(true);
  });

  it("keeps repair locked when readiness reconciliation fails", async () => {
    const user = userEvent.setup();
    const reconcileReadiness = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("synthetic readiness refresh failure"))
      .mockResolvedValueOnce();
    const subject = await renderSettings({
      deleteCredential: async () => ({
        slot: "openrouter",
        status: "uncertain",
        reason: "storage-uncertain",
      }),
      onReconciled: reconcileReadiness,
    });

    await user.click(screen.getByRole("button", { name: "Delete the OpenRouter credential" }));
    await user.click(
      screen.getByRole("button", { name: "Confirm deletion of the OpenRouter credential" }),
    );
    await user.click(await screen.findByRole("button", { name: "Reload credential status" }));

    await waitFor(() => {
      expect(subject.onReconciled).toHaveBeenCalledOnce();
      expect(useEnduragentStore.getState().settings.credentials).toMatchObject({
        status: "error",
        kind: "load",
        repairCredential: "openrouter",
      });
    });
    expect(screen.getByRole("button", { name: "Change what powers your coach" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Delete the Intervals.icu connection" }),
    ).toBeDisabled();
    expect(setupReady(useEnduragentStore.getState())).toBe(false);

    await user.click(screen.getByRole("button", { name: "Reload credential status" }));
    await waitFor(() => {
      expect(subject.onReconciled).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("button", { name: "Change what powers your coach" })).toBeEnabled();
      expect(
        screen.getByRole("button", { name: "Delete the Intervals.icu connection" }),
      ).toBeEnabled();
    });
    expect(setupReady(useEnduragentStore.getState())).toBe(true);
  });

  it("preserves repair across navigation until re-entry reload succeeds", async () => {
    const user = userEvent.setup();
    const reentryReload = deferred<readonly CredentialSlotStatus[]>();
    const statuses = [
      { slot: "anthropic", state: "configured", runtimeState: "active" },
      { slot: "openrouter", state: "configured", runtimeState: "stored-inactive" },
    ] as const;
    const loadCredentialStatuses = vi
      .fn<() => Promise<readonly CredentialSlotStatus[]>>()
      .mockResolvedValueOnce(statuses)
      .mockImplementationOnce(() => reentryReload.promise);
    harness = createHarness({
      loadCredentialStatuses,
      deleteCredential: async () => ({
        slot: "openrouter",
        status: "uncertain",
        reason: "storage-uncertain",
      }),
    });
    const firstVisit = render(<SettingsView />);
    await waitFor(() => {
      expect(useEnduragentStore.getState().settings.credentials.status).toBe("ready");
    });

    await user.click(screen.getByRole("button", { name: "Delete the OpenRouter credential" }));
    await user.click(
      screen.getByRole("button", { name: "Confirm deletion of the OpenRouter credential" }),
    );
    await screen.findByRole("button", { name: "Reload credential status" });
    firstVisit.unmount();

    expect(useEnduragentStore.getState().settings.credentials).toEqual({
      status: "closed",
      repairCredential: "openrouter",
    });
    expect(setupReady(useEnduragentStore.getState())).toBe(false);

    render(<SettingsView />);
    await waitFor(() => expect(loadCredentialStatuses).toHaveBeenCalledTimes(2));
    expect(useEnduragentStore.getState().settings.credentials).toMatchObject({
      status: "loading",
      repairCredential: "openrouter",
    });
    expect(screen.getByRole("button", { name: "Change what powers your coach" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Delete the Intervals.icu connection" }),
    ).toBeDisabled();
    expect(
      screen.getByText(
        "Credential deletion could not be confirmed because secure storage could not be verified. Restart Enduragent and reload before trying again.",
      ).parentElement,
    ).toHaveFocus();
    expect(setupReady(useEnduragentStore.getState())).toBe(false);

    act(() => reentryReload.resolve(statuses));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Change what powers your coach" })).toBeEnabled();
      expect(
        screen.getByRole("button", { name: "Delete the Intervals.icu connection" }),
      ).toBeEnabled();
    });
    expect(harness.onReconciled).toHaveBeenCalledOnce();
    expect(setupReady(useEnduragentStore.getState())).toBe(true);
  });
});

describe("keyless provider status", () => {
  it("shows the signed-in identity with no credential value and no delete control", async () => {
    await renderSettings({
      runtime: () =>
        snapshot({
          llm: { provider: "claude-cli", model: "sonnet", credential_configured: true },
        }),
      credentialStatuses: [],
      claudeCliStatus: async () => ({
        state: "ready",
        email: "athlete@example.test",
        plan: "Max",
        version: "2.1.0",
      }),
    });

    const row = document.querySelector<HTMLElement>('[data-provider="claude-cli"]');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("Claude subscription");
    expect(row?.textContent).toContain("Claude Code CLI");
    expect(row?.textContent).toContain(
      "Signed in as athlete@example.test - Claude Max subscription",
    );
    expect(row?.textContent).not.toContain("2.1.0");
    expect(within(row as HTMLElement).queryByRole("button")).toBeNull();
  });

  it("renders api-key billing honestly and never as a subscription", async () => {
    await renderSettings({
      runtime: () =>
        snapshot({
          llm: { provider: "claude-cli", model: "sonnet", credential_configured: true },
        }),
      credentialStatuses: [],
      claudeCliStatus: async () => ({ state: "ready-api-key" }),
    });

    const row = document.querySelector<HTMLElement>('[data-provider="claude-cli"]');
    expect(row?.querySelector("[data-provider-identity]")?.textContent).toBe(
      "Using Anthropic API key billing - usage is charged to your API account.",
    );
  });

  it("keeps credential-backed providers free of status rows", async () => {
    await renderSettings();

    expect(document.querySelector('[data-provider="claude-cli"]')).toBeNull();
  });
});

describe("coach route", () => {
  it("saves a custom model through the sentinel option", async () => {
    const user = userEvent.setup();
    const subject = await renderSettings();

    await user.click(screen.getByRole("combobox", { name: /^Model$/u }));
    await user.click(await screen.findByRole("option", { name: "Other model…" }));
    const custom = await screen.findByLabelText("Custom model name");
    await waitFor(() => {
      expect(custom).toHaveFocus();
    });
    await user.type(custom, "vendor/experimental");
    await user.click(screen.getByRole("button", { name: "Save coach route" }));

    await waitFor(() => {
      expect(subject.applyLlmSelection).toHaveBeenCalledWith({
        provider: "anthropic",
        model: "vendor/experimental",
        endpoint: { mode: "automatic" },
      });
    });
    expect(await screen.findByText("Coach settings saved.")).toBeInTheDocument();
  });

  it("focuses the setup area when the provider needs a credential", async () => {
    const user = userEvent.setup();
    const subject = await renderSettings({
      applyLlmSelection: async () => ({ status: "refused", reason: "credential-required" }),
    });

    await user.click(screen.getByRole("combobox", { name: /Provider/u }));
    await user.click(await screen.findByRole("option", { name: "OpenRouter" }));
    await user.click(screen.getByRole("button", { name: "Save coach route" }));

    const openSetup = await within(screen.getByRole("region", { name: "Coach" })).findByRole(
      "button",
      { name: "Review setup" },
    );
    await user.click(openSetup);
    expect(subject.openSetup).toHaveBeenCalledTimes(1);
  });

  it("keeps the route active when the active provider is outside the catalogue", async () => {
    await renderSettings({
      llm: () => ({
        ...llmConfiguration(),
        active: { provider: "codex-agent", model: "synthetic-codex" },
      }),
    });

    const coach = within(screen.getByRole("region", { name: "Coach" }));
    expect(coach.getByText("Codex agent (experimental) → synthetic-codex")).toBeInTheDocument();
    expect(coach.getByText("Active")).toHaveAttribute("data-state", "active");
    expect(
      coach.getByText("Currently active: Codex agent (experimental) · synthetic-codex"),
    ).toBeInTheDocument();
    expect(coach.queryByText("Not configured")).toBeNull();
  });

  it("requires a supported provider change for an active Windows Codex-agent profile", async () => {
    const user = userEvent.setup();
    const subject = await renderSettings({
      codexAgentSupported: false,
      llm: () => ({
        ...llmConfiguration(),
        active: { provider: "codex-agent", model: "synthetic-codex" },
      }),
    });

    const coach = within(screen.getByRole("region", { name: "Coach" }));
    expect(coach.getByText("Change required")).toHaveAttribute("data-state", "failed");
    expect(coach.getByRole("alert")).toHaveTextContent("Codex agent isn’t supported on Windows");
    expect(coach.getByRole("alert")).toHaveTextContent(
      "credentials, athlete data, conversations, and other settings stay unchanged",
    );

    await user.click(coach.getByRole("combobox", { name: /Provider/u }));
    await user.click(await screen.findByRole("option", { name: "Anthropic" }));
    await user.click(coach.getByRole("button", { name: "Save coach route" }));
    await screen.findByText("Coach settings saved.");

    expect(subject.applyLlmSelection).toHaveBeenCalledWith({
      provider: "anthropic",
      model: "synthetic-model",
      endpoint: { mode: "automatic" },
    });
    expect(subject.deleteCredential).not.toHaveBeenCalled();
    expect(coach.getByText("Active")).toHaveAttribute("data-state", "active");
    expect(coach.queryByText("Change required")).toBeNull();
  });

  it("marks the route not configured when no provider is active", async () => {
    await renderSettings({ llm: () => ({ ...llmConfiguration(), active: null }) });

    const coach = within(screen.getByRole("region", { name: "Coach" }));
    expect(coach.getByText("Not configured")).toBeInTheDocument();
    expect(coach.getByText("Not active")).toHaveAttribute("data-state", "failed");
    expect(
      coach.getByText("Active coach settings are unavailable or not configured."),
    ).toBeInTheDocument();
  });

  it("stacks the provider label title above its active-route detail", async () => {
    await renderSettings();

    expect(screen.getByRole("combobox", { name: /Provider/u })).toHaveTextContent("Anthropic");
    const label = document.querySelector<HTMLElement>("#coach-provider-label");
    expect(label).not.toBeNull();
    expect(label).toHaveClass("settings-label", "flex", "min-w-0", "flex-1", "flex-col");
    expect(label?.querySelector(".settings-row-title")?.textContent).toBe("Provider");
    expect(label?.querySelector(".settings-row-detail")?.textContent).toMatch(
      /^Currently active: /u,
    );
  });
});

describe("application section", () => {
  it("does not offer desktop release notes", async () => {
    await renderSettings();

    const application = within(screen.getByRole("region", { name: "Application" }));
    expect(application.queryByText("What’s new")).toBeNull();
    expect(application.queryByRole("button", { name: "What’s new" })).toBeNull();
  });

  it("runs the update action the state calls for", async () => {
    const user = userEvent.setup();
    const subject = await renderSettings({
      updateState: { status: "downloaded", version: "1998.7.7" },
    });
    await act(async () => {
      await subject.startUpdate();
    });

    const action = await screen.findByRole("button", {
      name: "Restart to update to version 1998.7.7",
    });
    await user.click(action);

    await waitFor(() => {
      expect(subject.restartToUpdate).toHaveBeenCalledTimes(1);
    });
    expect(subject.checkForUpdates).not.toHaveBeenCalled();
  });

  it.each([
    ["download", "Update download timed out. Quit and reopen Enduragent to try again."],
    ["check", "Updates could not start. Quit and reopen Enduragent to try again."],
  ] as const)(
    "explains %s recovery without offering an inert update retry",
    async (stage, announcement) => {
      const subject = await renderSettings({
        updateState: { status: "restart-required", stage },
      });
      await act(async () => {
        await subject.startUpdate();
      });

      const application = within(screen.getByRole("region", { name: "Application" }));
      expect(application.getByRole("status")).toHaveTextContent(announcement);
      expect(application.queryByRole("button", { name: /update/u })).toBeNull();
      expect(subject.checkForUpdates).not.toHaveBeenCalled();
      expect(subject.restartToUpdate).not.toHaveBeenCalled();
    },
  );
});

describe("spending", () => {
  it("publishes the cap warning for the chat surface and saves a new cap", async () => {
    const user = userEvent.setup();
    const subject = await renderSettings();
    act(() => {
      subject.spendController.start();
    });
    await waitFor(() => {
      expect(useEnduragentStore.getState().settings.spend.summary).not.toBeNull();
    });

    expect(useEnduragentStore.getState().settings.spend.warning).toBe(
      "You’ve reached today’s $0.50 spend cap. You can keep chatting; this is a warning, not a block.",
    );
    expect(screen.getByText("$0.60+ / $0.50")).toBeInTheDocument();

    const cap = screen.getByLabelText("Daily cap (USD)");
    await user.clear(cap);
    await user.type(cap, "0.75");
    await user.click(screen.getByRole("button", { name: "Save cap" }));

    await waitFor(() => {
      expect(subject.calls.filter((call) => call.method === "setDailySpendCap")).toEqual([
        { method: "setDailySpendCap", params: { dailyCapUsd: 0.75 } },
      ]);
    });
    await waitFor(() => {
      expect(useEnduragentStore.getState().settings.spend.warning).toBeNull();
    });
  });

  it("keeps a cap edit in progress across a refresh and reconciles the committed cap", async () => {
    const user = userEvent.setup();
    const pending = [
      spendSummary(),
      spendSummary({ knownSpendUsd: 0.2 }),
      spendSummary({ dailyCapUsd: 0.75 }),
      spendSummary({ dailyCapUsd: 0.5 }),
    ];
    const subject = await renderSettings({
      spend: async () => pending.shift() ?? spendSummary(),
    });
    act(() => {
      subject.spendController.start();
    });
    await waitFor(() => {
      expect(useEnduragentStore.getState().settings.spend.summary).not.toBeNull();
    });

    const cap = screen.getByLabelText("Daily cap (USD)") as HTMLInputElement;
    expect(cap.value).toBe("0.5");
    await user.clear(cap);
    await user.type(cap, "0.75");
    const draft = cap.value;
    expect(Number(draft)).toBe(0.75);
    expect(useEnduragentStore.getState().settings.spend.capDirty).toBe(true);

    await act(async () => {
      await subject.spendController.refresh();
    });
    expect(useEnduragentStore.getState().settings.spend.summary?.knownSpendUsd).toBe(0.2);
    expect(cap.value).toBe(draft);
    expect(useEnduragentStore.getState().settings.spend.capDirty).toBe(true);

    await act(async () => {
      await subject.spendController.refresh();
    });
    expect(Number(cap.value)).toBe(0.75);
    expect(useEnduragentStore.getState().settings.spend.capDirty).toBe(false);

    await act(async () => {
      await subject.spendController.refresh();
    });
    expect(cap.value).toBe("0.5");
    expect(useEnduragentStore.getState().settings.spend.capDirty).toBe(false);
  });
});
