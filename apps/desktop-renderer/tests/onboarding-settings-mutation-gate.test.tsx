import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onboardingCredentialMutationsBlocked } from "../src/state/onboarding-slice";
import { useEnduragentStore } from "../src/state/store";
import { SetupPanel } from "../src/ui/onboarding/OnboardingWizard";
import { mountWizard, primaryButton, resetOnboardingStore, testBridge } from "./onboarding-harness";

function readyBridge() {
  const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
  bridge.getSetupStatus = vi.fn(async () => ({
    schemaVersion: 1 as const,
    durableTrainingData: true,
  }));
  return bridge;
}

function setSavingOwners(savingOwners: readonly string[]): void {
  useEnduragentStore.setState((state) => ({
    settings: { ...state.settings, savingOwners },
  }));
}

function setupTrigger(id: "ai" | "training"): HTMLButtonElement {
  const trigger = document.querySelector<HTMLButtonElement>(`[data-setup-trigger="${id}"]`);
  if (trigger === null) throw new Error(`Setup trigger not found: ${id}`);
  return trigger;
}

describe("onboarding settings mutation gate", () => {
  beforeEach(() => resetOnboardingStore());
  afterEach(() => resetOnboardingStore());

  it("finishes setup while Telegram saves", async () => {
    const user = userEvent.setup();
    const bridge = readyBridge();
    const onComplete = vi.fn();
    setSavingOwners(["telegram"]);
    const wizard = mountWizard({
      bridge,
      onComplete,
      credentialMutationsBlocked: () =>
        onboardingCredentialMutationsBlocked(useEnduragentStore.getState()),
    });
    await wizard.open();

    await waitFor(() => expect(primaryButton()).toBeEnabled());
    expect(screen.getByText("2 of 2 required ready")).toBeVisible();
    await user.click(primaryButton());

    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    wizard.controller.dispose();
  });

  it("keeps required Chat controls available only for the exact Telegram owner", async () => {
    setSavingOwners(["telegram"]);
    const wizard = mountWizard({ bridge: readyBridge() });
    await wizard.open();

    expect(setupTrigger("ai")).toBeEnabled();
    expect(setupTrigger("training")).toBeEnabled();

    act(() => setSavingOwners(["telegram-reconcile"]));
    expect(setupTrigger("ai")).toBeDisabled();
    expect(setupTrigger("training")).toBeDisabled();

    act(() => setSavingOwners(["telegram"]));
    wizard.rendered.rerender(<SetupPanel placement="settings" />);
    expect(setupTrigger("ai")).toBeDisabled();
    expect(setupTrigger("training")).toBeDisabled();
    wizard.controller.dispose();
  });

  it("blocks onboarding credential mutations while a global reset is uncertain", async () => {
    useEnduragentStore.setState((state) => ({
      settings: {
        ...state.settings,
        credentials: { status: "closed", resetUncertain: true },
      },
    }));

    expect(onboardingCredentialMutationsBlocked(useEnduragentStore.getState())).toBe(true);
    const wizard = mountWizard({ bridge: readyBridge() });
    await wizard.open();

    expect(setupTrigger("ai")).toBeDisabled();
    expect(setupTrigger("training")).toBeDisabled();
    wizard.controller.dispose();
  });

  it("still blocks setup completion when another settings mutation is active", async () => {
    const bridge = readyBridge();
    const onComplete = vi.fn();
    setSavingOwners(["session"]);
    const wizard = mountWizard({
      bridge,
      onComplete,
      credentialMutationsBlocked: () =>
        onboardingCredentialMutationsBlocked(useEnduragentStore.getState()),
    });
    await wizard.open();

    expect(primaryButton()).toBeDisabled();
    act(() => wizard.controller.finish());
    await act(async () => Promise.resolve());

    expect(onComplete).not.toHaveBeenCalled();
    wizard.controller.dispose();
  });
});
