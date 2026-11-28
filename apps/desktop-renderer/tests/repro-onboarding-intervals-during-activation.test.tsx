import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  IntervalsCredentialMutationResult,
  OnboardingLlmSelectionResult,
} from "../src/onboarding/bridge";
import { useEnduragentStore } from "../src/state/store";
import {
  mountWizard,
  resetOnboardingStore,
  TEST_LLM_CONFIGURATION,
  testBridge,
} from "./onboarding-harness";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const PRIMARY_SIGN_IN = /^(Sign in with Intervals\.icu|Waiting for browser…)$/;

describe("repro onboarding C: Intervals sign-in during ChatGPT activation", () => {
  afterEach(() => resetOnboardingStore());

  it("keeps the first Intervals sign-in in charge after ChatGPT activation finishes", async () => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    bridge.llmConfiguration.mockResolvedValue({ ...TEST_LLM_CONFIGURATION, active: null });
    bridge.getSetupStatus = vi.fn(async () => ({
      schemaVersion: 1 as const,
      durableTrainingData: false,
    }));
    const activation = deferred<OnboardingLlmSelectionResult>();
    bridge.applyLlmSelection.mockImplementation(() => activation.promise);
    const firstSignIn = deferred<IntervalsCredentialMutationResult>();
    let signInOpen = false;
    bridge.signInWithIntervals.mockImplementation(async () => {
      if (signInOpen) throw new TypeError("desktop Intervals sign-in already running");
      signInOpen = true;
      return firstSignIn.promise;
    });
    const wizard = mountWizard({
      bridge,
      createOperationId: () => "synthetic-operation",
      afterPaint: (callback) => {
        callback();
        return () => {};
      },
    });
    await wizard.open();
    const connect = document.querySelector<HTMLButtonElement>('[data-setup-trigger="training"]')!;
    await user.click(connect);

    await act(async () => wizard.controller.startChatGptLogin());
    await act(async () => Promise.resolve());
    expect(useEnduragentStore.getState().onboarding.wizard.chatGptRuntimeState).toBe("activating");
    expect(screen.getAllByText("Activating coach…").length).toBeGreaterThan(0);
    const lockedDuringActivation = {
      connect: connect.disabled,
      importFiles: screen
        .getByRole("button", { name: "Import ride files instead" })
        .hasAttribute("disabled"),
    };
    await user.click(screen.getByRole("button", { name: "Sign in with Intervals.icu" }));

    await act(async () => activation.resolve({ status: "configured", runtimeReady: true }));

    await user.click(screen.getByRole("button", { name: PRIMARY_SIGN_IN }));
    await user.click(screen.getByRole("button", { name: PRIMARY_SIGN_IN }));

    expect({
      lockedDuringActivation,
      signInRequests: bridge.signInWithIntervals.mock.calls.length,
      cancelShown: screen.queryByRole("button", { name: "Cancel sign-in" }) !== null,
      falseConnectionError: (document.body.textContent ?? "").includes(
        "couldn’t confirm the sign-in with Intervals.icu",
      ),
    }).toEqual({
      lockedDuringActivation: { connect: true, importFiles: true },
      signInRequests: 1,
      cancelShown: true,
      falseConnectionError: false,
    });

    firstSignIn.resolve({
      outcome: "applied",
      current: { slot: "intervals-icu", state: "configured", runtimeState: "active" },
    });
    await act(async () => Promise.resolve());
    wizard.controller.dispose();
  });
});
