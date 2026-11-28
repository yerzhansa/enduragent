import { describe, expect, it } from "vitest";
import {
  chatGptSignedIn,
  chatGptUiPhase,
  claudeCliReady,
  createOnboardingState,
  hasConfiguredModel,
  hasTrainingData,
  nextStep,
  previousStep,
  selectedProviderReady,
  toOnboardingCompletion,
  withCredentialStatuses,
  withChatGptActivationPending,
  withChatGptActivationResult,
  withChatGptLoginResult,
  withChatGptPending,
  withChatGptProgress,
  withChatGptStatus,
  withClaudeCliStatus,
  withImportedRideFileCount,
} from "../src/onboarding/machine";

describe("desktop onboarding machine", () => {
  it("keeps the three ordered steps and exact guards", () => {
    let state = createOnboardingState();
    expect(Object.keys(state).sort()).toEqual([
      "busy",
      "chatGptCredentialState",
      "chatGptLoginPhase",
      "chatGptOperationId",
      "chatGptRefusal",
      "chatGptRuntimeState",
      "claudeCliIdentity",
      "claudeCliState",
      "credentialRuntimeStatus",
      "credentialStatus",
      "fixedError",
      "importedRideFileCount",
      "step",
    ]);
    expect(nextStep(state)).toMatchObject({
      step: "coach-keys",
      fixedError: "credential-required",
    });
    state = withCredentialStatuses(state, [
      { slot: "anthropic", state: "configured", runtimeState: "active" },
    ]);
    state = nextStep(state);
    expect(state.step).toBe("training-data");
    expect(nextStep(state)).toMatchObject({
      step: "training-data",
      fixedError: "training-data-required",
    });
    state = withImportedRideFileCount(state, 1);
    state = nextStep(state);
    expect(state.step).toBe("ready");
  });

  it("requires a runtime-ready restored or newly configured ChatGPT lane", () => {
    let state = createOnboardingState([], { state: "configured", runtimeReady: false });
    expect(hasConfiguredModel(state)).toBe(false);
    expect(nextStep(state).fixedError).toBe("credential-required");
    state = withChatGptStatus(state, { state: "configured", runtimeReady: true });
    expect(nextStep(state).step).toBe("training-data");
    state = createOnboardingState();
    state = withChatGptPending(state, "operation-1");
    expect(state).toMatchObject({
      chatGptLoginPhase: "waiting-for-browser",
      chatGptOperationId: "operation-1",
      busy: true,
    });
    state = withChatGptProgress(state, {
      operationId: "operation-1",
      phase: "completing-sign-in",
    });
    expect(state.chatGptLoginPhase).toBe("completing-sign-in");
    state = withChatGptLoginResult(state, {
      status: "refused",
      operationId: "operation-1",
      reason: "callback-unavailable",
    });
    expect(state).toMatchObject({
      chatGptCredentialState: "absent",
      chatGptLoginPhase: "idle",
      chatGptRefusal: "callback-unavailable",
      busy: false,
    });
    state = withChatGptPending(state, "operation-2");
    state = withChatGptLoginResult(state, { status: "stored", operationId: "operation-2" });
    expect(state).toMatchObject({
      chatGptCredentialState: "stored",
      chatGptRuntimeState: "inactive",
      busy: false,
    });
    state = withChatGptActivationPending(state);
    expect(state.chatGptRuntimeState).toBe("activating");
    state = withChatGptActivationResult(state, true);
    expect(nextStep(state).step).toBe("training-data");
    state = withChatGptStatus(state, { state: "absent", runtimeReady: false });
    expect(state.chatGptCredentialState).toBe("absent");
  });

  it("keeps a rejected ChatGPT sign-in out of activation until a new sign-in is stored", () => {
    const expired = {
      state: "configured",
      runtimeReady: false,
      reason: "sign-in-expired",
    } as const;
    let state = createOnboardingState([], expired);
    expect(state.chatGptCredentialState).toBe("expired");
    expect(chatGptUiPhase(state)).toBe("sign-in-expired");
    expect(chatGptSignedIn(state)).toBe(false);
    expect(hasConfiguredModel(state)).toBe(false);
    expect(withChatGptActivationPending(state)).toBe(state);
    expect(withChatGptActivationResult(state, true)).toBe(state);
    state = withChatGptStatus(createOnboardingState(), expired);
    expect(chatGptUiPhase(state)).toBe("sign-in-expired");
    state = withChatGptPending(state, "operation-again");
    expect(chatGptUiPhase(state)).toBe("waiting-for-browser");
    state = withChatGptLoginResult(state, {
      status: "refused",
      operationId: "operation-again",
      reason: "cancelled",
    });
    expect(state.chatGptCredentialState).toBe("expired");
    expect(chatGptUiPhase(state)).toBe("login-failed");
    state = withChatGptPending(state, "operation-final");
    state = withChatGptLoginResult(state, { status: "stored", operationId: "operation-final" });
    expect(state.chatGptCredentialState).toBe("stored");
    expect(chatGptUiPhase(state)).toBe("signed-in");
  });

  it("requires the selected provider to match an active, healthy runtime", () => {
    const selection = { provider: "anthropic", model: "claude-sonnet-4-6" };
    const failed = createOnboardingState([
      { slot: "anthropic", state: "configured", runtimeState: "failed" },
    ]);

    expect(hasConfiguredModel(failed)).toBe(false);
    expect(selectedProviderReady(failed, selection, selection)).toBe(false);
    expect(
      selectedProviderReady(failed, selection, {
        provider: "openrouter",
        model: "deepseek/deepseek-v4-flash",
      }),
    ).toBe(false);

    const active = createOnboardingState([
      { slot: "anthropic", state: "configured", runtimeState: "active" },
    ]);
    expect(selectedProviderReady(active, selection, selection)).toBe(true);
    expect(
      selectedProviderReady(
        active,
        { provider: "anthropic", model: "athlete-selected-model" },
        selection,
      ),
    ).toBe(false);
  });

  it("rejects a failed training runtime but accepts imported ride data as the fallback", () => {
    let state = createOnboardingState([
      { slot: "intervals-icu", state: "configured", runtimeState: "failed" },
    ]);
    expect(hasTrainingData(state)).toBe(false);
    state = nextStep(state, true);
    expect(nextStep(state)).toMatchObject({
      step: "training-data",
      fixedError: "training-data-required",
    });

    state = withImportedRideFileCount(state, 1);
    expect(hasTrainingData(state)).toBe(true);
    expect(nextStep(state).step).toBe("ready");
    expect(toOnboardingCompletion(state).requiresProviderSync).toBe(false);
  });

  it("treats only a probe-ready Claude subscription lane as a configured model", () => {
    let state = createOnboardingState([], { state: "absent", runtimeReady: false }, null);
    expect(state.claudeCliState).toBeNull();
    expect(state.claudeCliIdentity).toBeNull();
    expect(nextStep(state).fixedError).toBe("credential-required");

    state = withClaudeCliStatus(state, { state: "not-logged-in" });
    expect(claudeCliReady(state)).toBe(false);
    expect(nextStep(state).fixedError).toBe("credential-required");

    state = withClaudeCliStatus(state, {
      state: "ready",
      email: "athlete@example.test",
      plan: "Max",
    });
    expect(claudeCliReady(state)).toBe(true);
    expect(state.claudeCliIdentity).toBe(
      "Signed in as athlete@example.test - Claude Max subscription",
    );
    expect(nextStep(state).step).toBe("training-data");

    state = withClaudeCliStatus(state, { state: "ready-api-key" });
    expect(claudeCliReady(state)).toBe(true);
    expect(state.claudeCliIdentity).toBe(
      "Using Anthropic API key billing - usage is charged to your API account.",
    );

    state = withClaudeCliStatus(state, null);
    expect(state.claudeCliState).toBeNull();
    expect(claudeCliReady(state)).toBe(false);
  });

  it("preserves configured metadata and successful imports while moving back", () => {
    let state = createOnboardingState([
      { slot: "openrouter", state: "configured", runtimeState: "active" },
      { slot: "intervals-icu", state: "configured", runtimeState: "active" },
    ]);
    state = nextStep(state);
    state = withImportedRideFileCount(state, 1);
    state = nextStep(state);
    state = previousStep(state);
    state = previousStep(state);
    expect(state.step).toBe("coach-keys");
    expect(state.credentialStatus.openrouter).toBe("configured");
    expect(state.importedRideFileCount).toBe(1);
    expect("secret" in state).toBe(false);
  });

  it("preserves an earlier successful import when a later batch imports nothing", () => {
    let state = withImportedRideFileCount(createOnboardingState(), 2);
    state = withImportedRideFileCount(state, 0);
    expect(state.importedRideFileCount).toBe(2);
    expect(() => withImportedRideFileCount(state, -1)).toThrow(TypeError);
  });

  it("derives provider sync only from the configured training platform", () => {
    const fileOnly = withImportedRideFileCount(createOnboardingState(), 1);
    expect(toOnboardingCompletion(fileOnly)).toEqual({
      providerConfigured: true,
      trainingDataConfigured: true,
      requiresProviderSync: false,
    });

    const platformOnly = createOnboardingState([
      { slot: "intervals-icu", state: "configured", runtimeState: "active" },
    ]);
    expect(toOnboardingCompletion(platformOnly).requiresProviderSync).toBe(true);

    const mixed = withImportedRideFileCount(platformOnly, 1);
    expect(toOnboardingCompletion(mixed).requiresProviderSync).toBe(true);
  });
});
