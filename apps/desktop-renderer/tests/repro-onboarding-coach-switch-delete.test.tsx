import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OnboardingLlmConfiguration } from "../src/onboarding/bridge";
import { setupDisposition } from "../src/state/onboarding-slice";
import { useEnduragentStore } from "../src/state/store";
import {
  mountWizard,
  resetOnboardingStore,
  TEST_LLM_CONFIGURATION,
  testBridge,
} from "./onboarding-harness";

function configuration(active: OnboardingLlmConfiguration["active"]): OnboardingLlmConfiguration {
  return { ...TEST_LLM_CONFIGURATION, active };
}

describe("repro onboarding A: Coach switch then key delete", () => {
  afterEach(() => resetOnboardingStore());

  it("keeps a working coach out of the Setup gate after the old key is deleted", async () => {
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    bridge.getSetupStatus = vi.fn(async () => ({
      schemaVersion: 1 as const,
      durableTrainingData: true,
    }));
    bridge.llmConfiguration.mockResolvedValue(
      configuration({ provider: "anthropic", model: "claude-sonnet-4-6" }),
    );
    bridge.credentialStatuses.mockResolvedValue([
      { slot: "anthropic", state: "configured", runtimeState: "active" },
      { slot: "openrouter", state: "configured", runtimeState: "stored-inactive" },
    ]);
    const wizard = mountWizard({ bridge, placement: "settings" });
    await wizard.open();
    expect(useEnduragentStore.getState().onboarding.readiness).toEqual({
      provider: true,
      trainingData: true,
    });
    expect(setupDisposition(useEnduragentStore.getState())).toBe("satisfied");

    bridge.llmConfiguration.mockResolvedValue(
      configuration({ provider: "openrouter", model: "deepseek/deepseek-v4-flash" }),
    );
    bridge.credentialStatuses.mockResolvedValue([
      { slot: "openrouter", state: "configured", runtimeState: "active" },
    ]);

    await act(async () => wizard.controller.refresh());

    const state = useEnduragentStore.getState();
    expect(state.onboarding.loadUnavailable).toBe(false);
    expect({
      active: state.onboarding.configuration?.active ?? null,
      readiness: state.onboarding.readiness,
      disposition: setupDisposition(state),
    }).toEqual({
      active: { provider: "openrouter", model: "deepseek/deepseek-v4-flash" },
      readiness: { provider: true, trainingData: true },
      disposition: "satisfied",
    });
    wizard.controller.dispose();
  });
  async function mountOnAnthropic() {
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    bridge.llmConfiguration.mockResolvedValue(
      configuration({ provider: "anthropic", model: "claude-sonnet-4-6" }),
    );
    bridge.credentialStatuses.mockResolvedValue([
      { slot: "anthropic", state: "configured", runtimeState: "active" },
      { slot: "openrouter", state: "configured", runtimeState: "stored-inactive" },
    ]);
    const wizard = mountWizard({ bridge, placement: "settings" });
    await wizard.open();
    bridge.llmConfiguration.mockResolvedValue(
      configuration({ provider: "openrouter", model: "deepseek/deepseek-v4-flash" }),
    );
    bridge.credentialStatuses.mockResolvedValue([
      { slot: "anthropic", state: "configured", runtimeState: "stored-inactive" },
      { slot: "openrouter", state: "configured", runtimeState: "active" },
    ]);
    return wizard;
  }

  it("follows the coach when the athlete has not edited Setup's choice", async () => {
    const wizard = await mountOnAnthropic();
    await act(async () => wizard.controller.refresh());
    expect(useEnduragentStore.getState().onboarding.draft?.provider.provider).toBe("openrouter");
    wizard.controller.dispose();
  });

  it("keeps a choice the athlete edited in Setup across a refresh", async () => {
    const wizard = await mountOnAnthropic();
    act(() => wizard.controller.selectModel("claude-opus-4-6"));
    await act(async () => wizard.controller.refresh());
    const onboarding = useEnduragentStore.getState().onboarding;
    expect({
      active: onboarding.configuration?.active?.provider,
      draft: onboarding.draft?.provider.provider,
      model: onboarding.draft?.modelChoice,
    }).toEqual({ active: "openrouter", draft: "anthropic", model: "claude-opus-4-6" });
    wizard.controller.dispose();
  });

  it("leaves focus alone on a refresh that the athlete did not ask for", async () => {
    const wizard = await mountOnAnthropic();
    const before = useEnduragentStore.getState().onboarding.focusSeq;
    await act(async () => wizard.controller.refresh(false));
    expect(useEnduragentStore.getState().onboarding.focusSeq).toBe(before);
    await act(async () => wizard.controller.refresh());
    expect(useEnduragentStore.getState().onboarding.focusSeq).toBeGreaterThan(before);
    wizard.controller.dispose();
  });
});
