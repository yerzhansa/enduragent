import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  onboardingStatusRetryDelayMs,
  ONBOARDING_STATUS_COLD_START_TIMEOUT_MS,
  ONBOARDING_STATUS_LOAD_ATTEMPTS,
  ONBOARDING_STATUS_RETRY_BASE_DELAY_MS,
} from "../src/onboarding/status-read";
import { setupReady } from "../src/state/onboarding-slice";
import { useEnduragentStore } from "../src/state/store";
import { SetupPanel } from "../src/ui/onboarding/OnboardingWizard";
import {
  control,
  mountWizard,
  readyTelegramSettings,
  resetOnboardingStore,
  setTelegramSettings,
  testBridge,
} from "./onboarding-harness";

const COLD_START_WINDOW_MS =
  ONBOARDING_STATUS_COLD_START_TIMEOUT_MS * ONBOARDING_STATUS_LOAD_ATTEMPTS +
  Array.from({ length: ONBOARDING_STATUS_LOAD_ATTEMPTS }, (_unused, attempt) =>
    onboardingStatusRetryDelayMs(attempt),
  ).reduce((total, delay) => total + delay, 0);

function readinessBadge(): HTMLElement {
  const badge = document.querySelector<HTMLElement>("[data-setup-readiness]");
  if (badge === null) throw new TypeError("setup readiness badge missing");
  return badge;
}

function readinessDot(): HTMLElement {
  const dot = readinessBadge().querySelector<HTMLElement>("[data-setup-readiness-dot]");
  if (dot === null) throw new TypeError("setup readiness dot missing");
  return dot;
}

describe("authoritative setup readiness", () => {
  afterEach(() => resetOnboardingStore());

  it("accepts durable local rides without a training credential", async () => {
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.getSetupStatus = vi.fn(async () => ({
      schemaVersion: 1 as const,
      durableTrainingData: true,
    }));
    const wizard = mountWizard({ bridge });

    await wizard.open();

    expect(document.querySelector('[data-setup-row="injury-status"]')).toBeNull();
    expect(useEnduragentStore.getState().onboarding.readiness).toEqual({
      provider: true,
      trainingData: true,
    });
    expect(setupReady(useEnduragentStore.getState())).toBe(true);
    expect(readinessBadge()).toHaveTextContent("2 of 2 required ready");
    expect(readinessBadge()).toHaveAttribute("data-state", "ready");
    expect(readinessBadge()).toHaveAttribute("role", "status");
    expect(readinessBadge()).toHaveAttribute("aria-live", "polite");
    expect(readinessBadge()).toHaveAttribute("aria-atomic", "true");
    expect(readinessBadge()).toHaveClass("border-ok/35", "bg-ok/10", "text-ok");
    expect(readinessDot()).toHaveAttribute("data-setup-readiness-dot", "ready");
    expect(readinessDot()).toHaveClass("bg-ok", "ring-ok/10");
    wizard.controller.dispose();
  });

  it.each([
    {
      providerReady: true,
      durableTrainingData: true,
      expectedCount: 2,
      expectedReady: true,
    },
    {
      providerReady: true,
      durableTrainingData: false,
      expectedCount: 1,
      expectedReady: false,
    },
    {
      providerReady: false,
      durableTrainingData: true,
      expectedCount: 1,
      expectedReady: false,
    },
    {
      providerReady: false,
      durableTrainingData: false,
      expectedCount: 0,
      expectedReady: false,
    },
  ])(
    "re-evaluates retained training data after an Intervals deletion refresh when provider ready is $providerReady and durable data is $durableTrainingData",
    async ({ providerReady, durableTrainingData, expectedCount, expectedReady }) => {
      const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
      bridge.chatGptStatus.mockResolvedValue({
        state: providerReady ? "configured" : "absent",
        runtimeReady: providerReady,
      });
      bridge.credentialStatuses
        .mockResolvedValueOnce([
          { slot: "intervals-icu", state: "configured", runtimeState: "active" },
        ])
        .mockResolvedValueOnce([]);
      bridge.getSetupStatus = vi
        .fn()
        .mockResolvedValueOnce({
          schemaVersion: 1 as const,
          durableTrainingData: false,
        })
        .mockResolvedValueOnce({
          schemaVersion: 1 as const,
          durableTrainingData,
        });
      const wizard = mountWizard({ bridge });
      await wizard.open();

      expect(useEnduragentStore.getState().onboarding.readiness.trainingData).toBe(true);
      expect(readinessBadge()).toHaveTextContent(
        `${Number(providerReady) + 1} of 2 required ready`,
      );

      await act(async () => wizard.controller.refresh());

      expect(
        useEnduragentStore
          .getState()
          .onboarding.statuses.some((status) => status.slot === "intervals-icu"),
      ).toBe(false);
      expect(useEnduragentStore.getState().onboarding.readiness.trainingData).toBe(
        durableTrainingData,
      );
      expect(setupReady(useEnduragentStore.getState())).toBe(expectedReady);
      expect(readinessBadge()).toHaveTextContent(`${expectedCount} of 2 required ready`);
      expect(readinessBadge()).toHaveAttribute("data-state", expectedReady ? "ready" : "pending");
      expect(readinessBadge()).toHaveClass(
        expectedReady ? "border-ok/35" : "border-line-2",
        expectedReady ? "bg-ok/10" : "bg-surface",
        expectedReady ? "text-ok" : "text-ink-2",
      );
      expect(readinessDot()).toHaveAttribute(
        "data-setup-readiness-dot",
        expectedReady ? "ready" : "pending",
      );
      expect(readinessDot()).toHaveClass(
        expectedReady ? "bg-ok" : "bg-warn",
        expectedReady ? "ring-ok/10" : "ring-warn/10",
      );
      wizard.controller.dispose();
    },
  );

  it("fails closed while the durable setup read is still loading", async () => {
    let resolve!: (value: { schemaVersion: 1; durableTrainingData: boolean }) => void;
    const pending = new Promise<{
      schemaVersion: 1;
      durableTrainingData: boolean;
    }>((settle) => {
      resolve = settle;
    });
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.getSetupStatus = vi.fn(async () => pending);
    const wizard = mountWizard({ bridge });

    let opening!: Promise<void>;
    act(() => {
      opening = wizard.controller.open();
    });
    expect(useEnduragentStore.getState().onboarding.loading).toBe(true);
    expect(setupReady(useEnduragentStore.getState())).toBe(false);

    resolve({ schemaVersion: 1, durableTrainingData: true });
    await act(async () => opening);
    expect(setupReady(useEnduragentStore.getState())).toBe(true);
    wizard.controller.dispose();
  });

  it("keeps Chat readiness and required controls unchanged while Telegram is deleted", async () => {
    const configuredTelegram = {
      channel: { desiredState: "disabled" as const, state: "disabled" as const },
      bot: { state: "ready" as const, username: "synthetic_coach_bot" },
      pairing: { state: "unpaired" as const },
      credentialConfigured: true,
      gapWarning: { state: "clear" as const },
    };
    const unconfiguredTelegram = {
      channel: { desiredState: "disabled" as const, state: "disabled" as const },
      bot: { state: "unconfigured" as const },
      pairing: { state: "unpaired" as const },
      credentialConfigured: false,
      gapWarning: { state: "clear" as const },
    };
    setTelegramSettings(readyTelegramSettings(configuredTelegram));
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.getSetupStatus = vi.fn(async () => ({
      schemaVersion: 1 as const,
      durableTrainingData: true,
    }));
    const wizard = mountWizard({ bridge });
    await wizard.open();

    act(() => {
      const telegram = readyTelegramSettings(configuredTelegram);
      useEnduragentStore.setState({
        settings: {
          ...useEnduragentStore.getState().settings,
          telegram: { ...telegram, status: "working", operation: "remove" },
          savingOwners: ["telegram"],
        },
      });
    });
    expect(useEnduragentStore.getState().onboarding.readiness).toEqual({
      provider: true,
      trainingData: true,
    });
    expect(setupReady(useEnduragentStore.getState())).toBe(true);
    expect(screen.getByRole("button", { name: "Start coaching" })).toBeEnabled();
    expect(document.querySelector('[data-setup-trigger="ai"]')).toBeEnabled();
    expect(document.querySelector('[data-setup-trigger="training"]')).toBeEnabled();
    expect(document.querySelector("[data-setup-readiness]")).toHaveTextContent(
      "2 of 2 required ready",
    );

    act(() => {
      useEnduragentStore.setState({
        settings: {
          ...useEnduragentStore.getState().settings,
          telegram: readyTelegramSettings(unconfiguredTelegram),
          savingOwners: [],
        },
      });
    });
    await act(async () => wizard.controller.refresh());
    expect(useEnduragentStore.getState().onboarding.readiness).toEqual({
      provider: true,
      trainingData: true,
    });
    expect(setupReady(useEnduragentStore.getState())).toBe(true);
    expect(screen.getByRole("button", { name: "Start coaching" })).toBeEnabled();
    expect(document.querySelector("[data-setup-readiness]")).toHaveTextContent(
      "2 of 2 required ready",
    );

    act(() => {
      useEnduragentStore.setState({
        settings: { ...useEnduragentStore.getState().settings, savingOwners: ["credential"] },
      });
    });
    expect(screen.getByRole("button", { name: "Start coaching" })).toBeDisabled();

    act(() => {
      useEnduragentStore.setState({
        settings: { ...useEnduragentStore.getState().settings, savingOwners: ["telegram"] },
      });
    });
    wizard.rendered.rerender(<SetupPanel placement="settings" />);
    expect(screen.queryByRole("button", { name: "Start coaching" })).toBeNull();
    expect(screen.queryByText("Everything stays on this Mac.")).toBeNull();
    expect(document.querySelector("[data-setup-readiness]")).toBeNull();
    wizard.controller.dispose();
  });

  it("keeps setup controls inert and committed Chat readiness while status refreshes", async () => {
    let resolveRefresh!: (value: { schemaVersion: 1; durableTrainingData: boolean }) => void;
    const refresh = new Promise<{
      schemaVersion: 1;
      durableTrainingData: boolean;
    }>((settle) => {
      resolveRefresh = settle;
    });
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    const getSetupStatus = vi
      .fn()
      .mockResolvedValueOnce({
        schemaVersion: 1 as const,
        durableTrainingData: true,
      })
      .mockImplementationOnce(async () => refresh);
    bridge.getSetupStatus = getSetupStatus;
    const wizard = mountWizard({ bridge });
    await wizard.open();

    let refreshing!: Promise<void>;
    act(() => {
      refreshing = wizard.controller.refresh();
    });

    expect(setupReady(useEnduragentStore.getState())).toBe(true);
    expect(readinessBadge()).toHaveTextContent("2 of 2 required ready");
    expect(readinessBadge()).toHaveAttribute("data-state", "ready");
    expect(control<HTMLButtonElement>("setup-panel-title").closest("section")).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(document.querySelector<HTMLButtonElement>('[data-setup-trigger="ai"]')).toBeDisabled();
    expect(
      document.querySelector<HTMLButtonElement>('[data-setup-trigger="training"]'),
    ).toBeDisabled();

    resolveRefresh({ schemaVersion: 1, durableTrainingData: true });
    await act(async () => refreshing);
    expect(setupReady(useEnduragentStore.getState())).toBe(true);
    wizard.controller.dispose();
  });

  it("keeps committed Chat readiness when a status refresh becomes unavailable", async () => {
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.getSetupStatus = vi.fn(async () => ({
      schemaVersion: 1 as const,
      durableTrainingData: true,
    }));
    const wizard = mountWizard({ bridge });
    await wizard.open();
    bridge.llmConfiguration.mockRejectedValueOnce(new TypeError("synthetic catalogue failure"));

    await act(async () => wizard.controller.refresh());

    expect(useEnduragentStore.getState().onboarding.loadUnavailable).toBe(true);
    expect(setupReady(useEnduragentStore.getState())).toBe(true);
    wizard.controller.dispose();
  });

  it("retries a cold start before it calls setup status unavailable, and recovers through Retry", async () => {
    vi.useFakeTimers();
    try {
      const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
      let setupReadFails = true;
      bridge.getSetupStatus = vi.fn(async () => {
        if (setupReadFails) throw new TypeError("synthetic setup read failure");
        return { schemaVersion: 1 as const, durableTrainingData: true };
      });
      const wizard = mountWizard({ bridge });

      await act(async () => {
        const opening = wizard.controller.open();
        await vi.advanceTimersByTimeAsync(COLD_START_WINDOW_MS);
        await opening;
      });

      expect(bridge.getSetupStatus).toHaveBeenCalledTimes(ONBOARDING_STATUS_LOAD_ATTEMPTS);
      expect(useEnduragentStore.getState().onboarding.loadUnavailable).toBe(true);
      expect(setupReady(useEnduragentStore.getState())).toBe(false);
      expect(
        screen.getByText(
          "Setup status couldn’t be loaded. Check that Enduragent is running, then try again.",
        ),
      ).toBeInTheDocument();
      expect(document.querySelector("[data-setup-readiness]")).toBeNull();
      expect(document.querySelector("[data-setup-card]")).toBeNull();
      expect(document.querySelector("[data-setup-row]")).toBeNull();
      expect(document.querySelector('[data-setup-trigger="ai"]')).toBeNull();
      expect(document.querySelector('[data-setup-trigger="training"]')).toBeNull();
      expect(screen.queryByRole("button", { name: "Start coaching" })).toBeNull();
      expect(screen.queryByText("Loading saved credentials…")).toBeNull();

      wizard.rendered.rerender(<SetupPanel placement="settings" />);

      expect(document.querySelector("[data-setup-card]")).not.toBeNull();
      expect(document.querySelector('[data-setup-trigger="ai"]')).toBeNull();
      expect(document.querySelector('[data-setup-trigger="training"]')).toBeNull();
      expect(screen.queryByRole("button", { name: "Start coaching" })).toBeNull();

      setupReadFails = false;
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Retry setup status" }));
        await vi.advanceTimersByTimeAsync(COLD_START_WINDOW_MS);
      });

      expect(useEnduragentStore.getState().onboarding.loadUnavailable).toBe(false);
      expect(setupReady(useEnduragentStore.getState())).toBe(true);
      expect(bridge.getSetupStatus).toHaveBeenCalledTimes(ONBOARDING_STATUS_LOAD_ATTEMPTS + 1);
      expect(screen.queryByRole("button", { name: "Retry setup status" })).toBeNull();
      expect(document.querySelector<HTMLButtonElement>('[data-setup-trigger="ai"]')).toBeEnabled();
      expect(
        document.querySelector<HTMLButtonElement>('[data-setup-trigger="training"]'),
      ).toBeEnabled();
      wizard.controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reaches the configured state with no user input when the daemon answers late", async () => {
    vi.useFakeTimers();
    try {
      const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
      let daemonStarting = true;
      const getSetupStatus = vi.fn(async () => {
        if (daemonStarting) throw new TypeError("coach daemon is still starting");
        return { schemaVersion: 1 as const, durableTrainingData: true };
      });
      bridge.getSetupStatus = getSetupStatus;
      const wizard = mountWizard({ bridge });

      const opening = act(async () => {
        await wizard.controller.open();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ONBOARDING_STATUS_RETRY_BASE_DELAY_MS);
      });

      expect(useEnduragentStore.getState().onboarding.loadUnavailable).toBe(false);
      expect(document.querySelector('[data-setup-row="ai"]')).toHaveAttribute("data-state", "none");
      expect(document.querySelector('[data-setup-row="training"]')).toHaveAttribute(
        "data-state",
        "none",
      );
      expect(document.body.textContent).not.toContain("Connect or import ride files.");
      expect(document.body.textContent).not.toContain("Required — Enduragent doesn't include one");
      expect(readinessBadge()).toHaveTextContent("Checking setup…");
      expect(readinessBadge()).not.toHaveTextContent("0 of 2 required ready");

      daemonStarting = false;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(COLD_START_WINDOW_MS);
      });
      await opening;

      expect(useEnduragentStore.getState().onboarding.loadUnavailable).toBe(false);
      expect(setupReady(useEnduragentStore.getState())).toBe(true);
      expect(readinessBadge()).toHaveTextContent("2 of 2 required ready");
      expect(screen.queryByRole("button", { name: "Retry setup status" })).toBeNull();
      expect(getSetupStatus.mock.calls.length).toBeGreaterThan(1);
      wizard.controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains unsaved provider drafts across an unavailable refresh and retry", async () => {
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.getSetupStatus = vi.fn(async () => ({
      schemaVersion: 1 as const,
      durableTrainingData: true,
    }));
    const wizard = mountWizard({ bridge });
    await wizard.open();
    wizard.controller.selectProvider("openrouter");
    wizard.controller.selectModel("__custom__");
    wizard.controller.setCustomModel("vendor/unsaved-model");
    const draftBeforeFailure = useEnduragentStore.getState().onboarding.draft;
    bridge.llmConfiguration.mockRejectedValueOnce(new TypeError("synthetic catalogue failure"));

    await act(async () => wizard.controller.refresh());

    expect(useEnduragentStore.getState().onboarding.loadUnavailable).toBe(true);
    expect(useEnduragentStore.getState().onboarding.draft).toEqual(draftBeforeFailure);

    await act(async () => wizard.controller.refresh());

    expect(useEnduragentStore.getState().onboarding.loadUnavailable).toBe(false);
    expect(useEnduragentStore.getState().onboarding.draft).toEqual(draftBeforeFailure);
    wizard.controller.dispose();
  });

  it("blocks every credential mutation while repair is required without changing readiness", async () => {
    let repairRequired = false;
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.getSetupStatus = vi.fn(async () => ({
      schemaVersion: 1 as const,
      durableTrainingData: true,
    }));
    const wizard = mountWizard({
      bridge,
      credentialMutationsBlocked: () => repairRequired,
    });
    await wizard.open();
    expect(setupReady(useEnduragentStore.getState())).toBe(true);

    repairRequired = true;
    wizard.controller.saveModelKey();
    wizard.controller.connectTrainingData();
    wizard.controller.retrySavedKeys();
    wizard.controller.startChatGptLogin();
    wizard.controller.retryChatGptActivation();
    wizard.controller.chooseImportFiles();
    wizard.controller.importDroppedFiles(["/tmp/synthetic.fit"]);
    wizard.controller.finish();

    await act(async () => Promise.resolve());
    expect(bridge.writeCredential).not.toHaveBeenCalled();
    expect(bridge.signInWithIntervals).not.toHaveBeenCalled();
    expect(bridge.retryFailedCredentials).not.toHaveBeenCalled();
    expect(bridge.chatGptLogin).not.toHaveBeenCalled();
    expect(bridge.applyLlmSelection).not.toHaveBeenCalled();
    expect(bridge.chooseImportFiles).not.toHaveBeenCalled();
    expect(bridge.importFiles).not.toHaveBeenCalled();
    expect(wizard.controller.ownsDroppedImportFiles()).toBe(false);
    expect(setupReady(useEnduragentStore.getState())).toBe(true);
    wizard.controller.dispose();
  });

  it.each([
    [false, true, "provider"],
    [true, false, "trainingData"],
  ] as const)("stays locked when provider=%s training=%s", async (provider, training, missing) => {
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.chatGptStatus.mockResolvedValue({
      state: provider ? "configured" : "absent",
      runtimeReady: provider,
    });
    bridge.getSetupStatus = vi.fn(async () => ({
      schemaVersion: 1 as const,
      durableTrainingData: training,
    }));
    const wizard = mountWizard({ bridge });
    await wizard.open();

    expect(useEnduragentStore.getState().onboarding.readiness[missing]).toBe(false);
    expect(setupReady(useEnduragentStore.getState())).toBe(false);
    expect(readinessBadge()).toHaveTextContent("1 of 2 required ready");
    expect(readinessBadge()).toHaveAttribute("data-state", "pending");
    expect(readinessBadge()).toHaveClass("border-line-2", "bg-surface", "text-ink-2");
    expect(readinessDot()).toHaveAttribute("data-setup-readiness-dot", "pending");
    expect(readinessDot()).toHaveClass("bg-warn", "ring-warn/10");
    wizard.controller.dispose();
  });
});
