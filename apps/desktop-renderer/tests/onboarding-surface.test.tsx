import { randomUUID } from "node:crypto";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CredentialWriteResult,
  IntervalsCredentialMutationResult,
  OnboardingBridge,
} from "../src/onboarding/bridge";
import { createRideImportController } from "../src/ride-import";
import { useEnduragentStore } from "../src/state/store";
import {
  chooseLane,
  control,
  errorText,
  importResult,
  mountWizard,
  openApiKeyPanel,
  openTrainingPanel,
  panel,
  panelButton,
  passwordInput,
  primaryButton,
  resetOnboardingStore,
  retryButtons,
  rowState,
  saveModelKey,
  seedSecret,
  selectSetupOption,
  testBridge,
  TEST_LLM_CONFIGURATION,
  type UserEvent,
} from "./onboarding-harness";

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name });
}

async function chooseOption(user: UserEvent, id: string, value: string) {
  await selectSetupOption(user, id, value);
}

async function typeInto(user: UserEvent, id: string, value: string) {
  const element = control<HTMLInputElement>(id);
  await user.clear(element);
  await user.type(element, value);
}

async function answerIntake(user: UserEvent): Promise<void> {
  await chooseOption(user, "onboarding-injury-status", "none");
}

function enableCredentialDeletion(): void {
  useEnduragentStore.setState({
    settingsPorts: {
      credentials: {
        retry: vi.fn(),
        requestDelete: vi.fn(),
        cancelDelete: vi.fn(),
        confirmDelete: vi.fn(),
        setupOpened: vi.fn(),
        openSetup: vi.fn(),
      },
    } as never,
  });
}

type CredentialWriteRefusalReason = Extract<
  CredentialWriteResult,
  { readonly status: "refused" }
>["reason"];

const CREDENTIAL_REFUSAL_CASES = [
  {
    reason: "invalid-input",
    fixedError: "invalid-input",
    copy: "That key was not accepted. Check it and enter it again.",
  },
  {
    reason: "encryption-unavailable",
    fixedError: "encryption-unavailable",
    copy: "macOS encryption is unavailable. Make sure Keychain is available, then try again.",
  },
  {
    reason: "unsafe-backend",
    fixedError: "unsafe-backend",
    copy: "The app cannot safely store that key with the current storage backend.",
  },
  {
    reason: "storage-failed",
    fixedError: "storage-failed",
    copy: "The app could not confirm that key was saved securely. Check that secure storage is available and try again.",
  },
  {
    reason: "runtime-unavailable",
    fixedError: "model-runtime-unavailable",
    copy: "Your provider choice is saved, but it is not active yet. Try activating it again.",
  },
] as const satisfies ReadonlyArray<{
  readonly reason: CredentialWriteRefusalReason;
  readonly fixedError: CredentialWriteRefusalReason | "model-runtime-unavailable";
  readonly copy: string;
}>;

describe("mounted onboarding", () => {
  afterEach(() => {
    resetOnboardingStore();
  });

  it("presents the full-window setup gate without a bypass action", async () => {
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    const wizard = mountWizard({ bridge });
    await wizard.open();

    const page = document.querySelector('[data-setup-host="gate"]');
    expect(page).not.toBeNull();
    expect(control("setup-panel-title")).toHaveTextContent(
      "Get your coach running before you can chat",
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".onboarding-scrim")).toBeNull();
    expect(document.activeElement).toBe(control("setup-panel-title"));
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    expect(
      screen.queryByText(
        "Not medical advice, and not a substitute for a doctor or a certified coach.",
      ),
    ).toBeNull();
    expect(document.querySelectorAll('[data-setup-row="telegram"]')).toHaveLength(1);
    wizard.controller.dispose();
  });

  it("does not close the setup page on Escape", async () => {
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    const wizard = mountWizard({ bridge });
    await wizard.open();

    const page = document.querySelector('[data-setup-host="gate"]');
    if (!(page instanceof HTMLElement)) throw new TypeError("setup host missing");
    expect(fireEvent.keyDown(page, { key: "Escape" })).toBe(true);

    expect(page).toBeInTheDocument();
    expect(wizard.focusOpener).not.toHaveBeenCalled();
    wizard.controller.dispose();
  });

  it("does not trap Tab inside the setup page", async () => {
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    const wizard = mountWizard({ bridge });
    await wizard.open();

    const page = document.querySelector('[data-setup-host="gate"]');
    if (!(page instanceof HTMLElement)) throw new TypeError("setup host missing");
    const first = button("Change what powers your coach");
    expect(primaryButton()).toBeDisabled();

    first.focus();
    expect(fireEvent.keyDown(page, { key: "Tab" })).toBe(true);
    expect(document.activeElement).toBe(first);
    wizard.controller.dispose();
  });

  it("blocks direct and scheduled ChatGPT activation when credential mutations are locked", async () => {
    let mutationsBlocked = false;
    let scheduledActivation: (() => void) | undefined;
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    const wizard = mountWizard({
      bridge,
      credentialMutationsBlocked: () => mutationsBlocked,
      afterPaint(callback) {
        scheduledActivation = callback;
        return () => {
          if (scheduledActivation === callback) scheduledActivation = undefined;
        };
      },
    });
    await wizard.open();

    act(() => wizard.controller.startChatGptLogin());
    await waitFor(() => {
      expect(bridge.chatGptLogin).toHaveBeenCalledOnce();
      expect(wizard.controller.state()).toMatchObject({
        chatGptCredentialState: "stored",
        chatGptRuntimeState: "inactive",
      });
      expect(scheduledActivation).toBeTypeOf("function");
    });

    mutationsBlocked = true;
    const flushActivation = scheduledActivation;
    if (flushActivation === undefined) throw new Error("ChatGPT activation was not scheduled");
    act(() => flushActivation());
    act(() => wizard.controller.selectProvider("openai-codex"));

    expect(bridge.applyLlmSelection).not.toHaveBeenCalled();
    expect(wizard.controller.state().chatGptRuntimeState).toBe("inactive");
    wizard.controller.dispose();
  });

  it.each(CREDENTIAL_REFUSAL_CASES)(
    "keeps the athlete on the AI row and explains $reason refusals",
    async ({ reason, fixedError, copy }) => {
      const user = userEvent.setup();
      const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
      if (reason === "runtime-unavailable") {
        bridge.credentialStatuses
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
            { slot: "anthropic", state: "configured", runtimeState: "failed" },
          ]);
      }
      let credentialWriteCount = 0;
      bridge.writeCredential.mockImplementation(async ({ slot }) => {
        credentialWriteCount += 1;
        return { slot, status: "refused", reason };
      });
      const onComplete = vi.fn();
      const wizard = mountWizard({ bridge, onComplete });
      await wizard.open();
      await openApiKeyPanel(user);
      const secret = seedSecret("anthropic", randomUUID());

      await saveModelKey(user);

      await waitFor(() => {
        expect(wizard.controller.state().fixedError).toBe(fixedError);
      });
      expect(errorText()).toBe(copy);
      expect(panel("api-key")?.contains(document.querySelector("#onboarding-error"))).toBe(true);
      expect(rowState("ai")).toBe("pending");
      expect(secret.value).toBe("");
      expect(credentialWriteCount).toBe(1);
      expect(bridge.credentialStatuses).toHaveBeenCalledTimes(2);
      expect(onComplete).not.toHaveBeenCalled();
      wizard.controller.dispose();
    },
  );

  it("keeps the athlete on the AI row when credential durability remains uncertain", async () => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.writeCredential.mockImplementation(async ({ slot }) => ({
      slot,
      status: "uncertain",
      reason: "storage-uncertain",
    }));
    bridge.credentialStatuses
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ slot: "anthropic", state: "re-prompt", runtimeState: null }]);
    const onComplete = vi.fn();
    const wizard = mountWizard({ bridge, onComplete });
    await wizard.open();
    await openApiKeyPanel(user);
    const secret = seedSecret("anthropic", randomUUID());

    await saveModelKey(user);

    await waitFor(() => {
      expect(wizard.controller.state().fixedError).toBe("storage-uncertain");
    });
    expect(errorText()).toBe(
      "The app could not prove which saved key will survive a restart. Re-enter the key before continuing.",
    );
    expect(panel("api-key")?.contains(document.querySelector("#onboarding-error"))).toBe(true);
    expect(rowState("ai")).toBe("pending");
    expect(secret.value).toBe("");
    expect(onComplete).not.toHaveBeenCalled();
    wizard.controller.dispose();
  });

  it("explains a training-account mismatch under the intervals.icu row", async () => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.credentialStatuses.mockResolvedValue([
      { slot: "anthropic", state: "configured", runtimeState: "active" },
    ]);
    bridge.pasteIntervalsApiKeyFromClipboard.mockResolvedValue({
      outcome: "refused",
      reason: "training-account-mismatch",
      current: { slot: "intervals-icu", state: "missing", runtimeState: null },
    });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await openTrainingPanel(user);

    await user.click(panelButton("training", "Use copied API key"));

    await waitFor(() => {
      expect(wizard.controller.state().fixedError).toBe("training-account-mismatch");
    });
    expect(errorText()).toBe(
      "That intervals.icu key belongs to a different athlete than the training history already stored. Switching accounts is not supported yet.",
    );
    expect(panel("training")?.contains(document.querySelector("#onboarding-error"))).toBe(true);
    expect(bridge.pasteIntervalsApiKeyFromClipboard.mock.calls[0]).toEqual([]);
    expect(bridge.writeCredential).not.toHaveBeenCalled();
    expect(document.querySelector('input[data-slot="intervals-icu"]')).toBeNull();
    wizard.controller.dispose();
  });

  it("retries a saved provider choice with Save without rewriting the key", async () => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    bridge.credentialStatuses
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ slot: "anthropic", state: "configured", runtimeState: "failed" }])
      .mockResolvedValueOnce([{ slot: "anthropic", state: "configured", runtimeState: "active" }]);
    let credentialWriteCount = 0;
    bridge.writeCredential.mockImplementation(async ({ slot }) => {
      credentialWriteCount += 1;
      return { slot, status: "refused", reason: "runtime-unavailable" };
    });
    const onComplete = vi.fn();
    const wizard = mountWizard({ bridge, onComplete });
    await wizard.open();
    await openApiKeyPanel(user);
    const secret = seedSecret("anthropic", randomUUID());

    await saveModelKey(user);

    await waitFor(() => {
      expect(wizard.controller.state().fixedError).toBe("model-runtime-unavailable");
    });
    expect(errorText()).toBe(
      "Your provider choice is saved, but it is not active yet. Try activating it again.",
    );
    expect(retryButtons()).toHaveLength(0);
    expect(secret.value).toBe("");
    expect(bridge.credentialStatuses).toHaveBeenCalledTimes(2);

    await saveModelKey(user);

    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });
    expect(bridge.applyLlmSelection).toHaveBeenCalledWith({
      catalogRevision: 7,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      endpoint: { mode: "automatic" },
    });
    expect(bridge.credentialStatuses).toHaveBeenCalledTimes(3);
    expect(credentialWriteCount).toBe(1);
    expect(bridge.retryFailedCredentials).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    wizard.controller.dispose();
  });

  it("keeps Save activation recovery available when applying the provider fails", async () => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    bridge.credentialStatuses
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ slot: "anthropic", state: "configured", runtimeState: "failed" }]);
    bridge.applyLlmSelection.mockRejectedValue(new Error("private daemon failure"));
    bridge.writeCredential.mockImplementation(async ({ slot }) => ({
      slot,
      status: "refused",
      reason: "runtime-unavailable",
    }));
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await openApiKeyPanel(user);
    seedSecret("anthropic", randomUUID());

    await saveModelKey(user);
    await waitFor(() => {
      expect(wizard.controller.state().fixedError).toBe("model-runtime-unavailable");
    });

    await saveModelKey(user);

    await waitFor(() => {
      expect(wizard.controller.state().busy).toBe(false);
    });
    expect(wizard.controller.state().fixedError).toBe("model-runtime-unavailable");
    expect(errorText()).toBe(
      "Your provider choice is saved, but it is not active yet. Try activating it again.",
    );
    expect(retryButtons()).toHaveLength(0);
    expect(bridge.retryFailedCredentials).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("private daemon failure");
    wizard.controller.dispose();
  });

  it("offers intervals.icu activation recovery without reading another copied key", async () => {
    const user = userEvent.setup();
    const failedStatuses = [
      { slot: "intervals-icu", state: "configured", runtimeState: "failed" },
    ] as const;
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.credentialStatuses.mockResolvedValue([]);
    bridge.retryFailedCredentials.mockResolvedValue(failedStatuses);
    bridge.pasteIntervalsApiKeyFromClipboard.mockResolvedValue({
      outcome: "applied",
      current: failedStatuses[0],
    });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await openTrainingPanel(user);

    await user.click(panelButton("training", "Use copied API key"));

    await waitFor(() => {
      expect(wizard.controller.state().fixedError).toBe("intervals-runtime-unavailable");
    });
    expect(errorText()).toBe(
      "The copied API key couldn’t be activated. Copy it in Intervals.icu, then try again.",
    );
    expect(retryButtons()).toHaveLength(1);
    expect(bridge.writeCredential).not.toHaveBeenCalled();

    await user.click(button("Retry saved keys"));

    await waitFor(() => {
      expect(bridge.retryFailedCredentials).toHaveBeenCalledOnce();
    });
    await waitFor(() => {
      expect(wizard.controller.state().busy).toBe(false);
    });
    expect(retryButtons()).toHaveLength(1);
    expect(bridge.pasteIntervalsApiKeyFromClipboard).toHaveBeenCalledOnce();
    wizard.controller.dispose();
  });

  it("does not leak a late runtime-unavailable write into a reopened visit", async () => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    const pendingWrite = deferred<CredentialWriteResult>();
    let credentialWriteCount = 0;
    bridge.writeCredential.mockImplementation(() => {
      credentialWriteCount += 1;
      return pendingWrite.promise;
    });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await openApiKeyPanel(user);
    seedSecret("anthropic", randomUUID());

    await saveModelKey(user);
    await waitFor(() => {
      expect(credentialWriteCount).toBe(1);
    });

    act(() => {
      wizard.controller.close();
    });
    pendingWrite.resolve({ slot: "anthropic", status: "refused", reason: "runtime-unavailable" });
    await pendingWrite.promise;
    await wizard.open();

    expect(wizard.controller.state()).toMatchObject({
      step: "coach-keys",
      busy: false,
      fixedError: null,
    });
    expect(retryButtons()).toHaveLength(0);
    expect(credentialWriteCount).toBe(1);
    wizard.controller.dispose();
  });

  it("snapshots and clears the password before the write settles", async () => {
    const user = userEvent.setup();
    const value = randomUUID();
    const write = deferred<void>();
    let valueMatched = false;
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.writeCredential.mockImplementation(async ({ slot, value: written }) => {
      valueMatched = written === value;
      await write.promise;
      return { slot, status: "configured", runtimeReady: true };
    });
    bridge.credentialStatuses
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ slot: "anthropic", state: "configured", runtimeState: "active" }]);
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await openApiKeyPanel(user);
    const input = seedSecret("anthropic", value);

    await saveModelKey(user);

    await waitFor(() => {
      expect(valueMatched).toBe(true);
    });
    expect(input).toBeDisabled();
    expect(input.value).toBe("");
    expect(document.querySelector(".onboarding-action-status")).toBeNull();
    write.resolve();

    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });
    wizard.controller.dispose();
  });

  it("writes only the selected provider and attaches its model choice", async () => {
    const user = userEvent.setup();
    const openRouterKey = randomUUID();
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    bridge.credentialStatuses
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ slot: "openrouter", state: "configured", runtimeState: "active" }]);
    bridge.writeCredential.mockImplementation(async ({ slot, selection }) => ({
      slot,
      status: "configured",
      runtimeReady: selection !== undefined,
    }));
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await openApiKeyPanel(user);
    await chooseOption(user, "onboarding-llm-provider", "openrouter");
    seedSecret("openrouter", openRouterKey);

    await saveModelKey(user);

    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });
    expect(bridge.writeCredential).toHaveBeenCalledTimes(1);
    expect(bridge.writeCredential).toHaveBeenNthCalledWith(1, {
      slot: "openrouter",
      value: openRouterKey,
      selection: {
        catalogRevision: 7,
        provider: "openrouter",
        model: "deepseek/deepseek-v4-flash",
        endpoint: { mode: "automatic" },
      },
    });
    expect(bridge.applyLlmSelection).not.toHaveBeenCalled();
    wizard.controller.dispose();
  });

  it("applies a changed model for an active provider without a Desktop-owned key", async () => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    bridge.llmConfiguration.mockResolvedValue({
      ...TEST_LLM_CONFIGURATION,
      active: { provider: "anthropic", model: "claude-sonnet-4-6" },
    });
    bridge.credentialStatuses.mockResolvedValue([]);
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await openApiKeyPanel(user);
    await chooseOption(user, "onboarding-llm-model", "__custom__");
    await typeInto(user, "onboarding-custom-model", "athlete-selected-model");

    await saveModelKey(user);

    await waitFor(() => {
      expect(bridge.applyLlmSelection).toHaveBeenCalledOnce();
    });
    expect(bridge.writeCredential).not.toHaveBeenCalled();
    expect(bridge.applyLlmSelection).toHaveBeenCalledWith({
      catalogRevision: 7,
      provider: "anthropic",
      model: "athlete-selected-model",
      endpoint: { mode: "automatic" },
    });
    wizard.controller.dispose();
  });

  it("treats an active ChatGPT profile as ready without signing in again", async () => {
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.llmConfiguration.mockResolvedValue({
      ...TEST_LLM_CONFIGURATION,
      active: { provider: "openai-codex", model: "custom-chat-model" },
    });
    bridge.chatGptStatus.mockResolvedValue({ state: "configured", runtimeReady: true });
    const wizard = mountWizard({ bridge });
    await wizard.open();

    expect(rowState("ai")).toBe("ready");
    expect(bridge.chatGptLogin).not.toHaveBeenCalled();
    expect(panel("chatgpt")).toBeNull();
    wizard.controller.dispose();
  });

  it("applies an endpoint change for an already-active provider without the key again", async () => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    bridge.llmConfiguration.mockResolvedValue({
      ...TEST_LLM_CONFIGURATION,
      active: { provider: "openrouter", model: "deepseek/deepseek-v4-flash" },
    });
    bridge.credentialStatuses.mockResolvedValue([
      { slot: "openrouter", state: "configured", runtimeState: "active" },
    ]);
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await openApiKeyPanel(user);
    await chooseOption(user, "onboarding-endpoint-mode", "custom");
    await typeInto(user, "onboarding-custom-endpoint", "https://models.example.test/v1");

    await saveModelKey(user);

    await waitFor(() => {
      expect(bridge.applyLlmSelection).toHaveBeenCalledOnce();
    });
    expect(bridge.writeCredential).not.toHaveBeenCalled();
    expect(bridge.applyLlmSelection).toHaveBeenCalledWith({
      catalogRevision: 7,
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
      endpoint: { mode: "custom", value: "https://models.example.test/v1" },
    });
    wizard.controller.dispose();
  });

  it("freezes provider, model, and endpoint controls while applying a selection", async () => {
    const user = userEvent.setup();
    const pending = deferred<{ readonly status: "configured"; readonly runtimeReady: true }>();
    let active = false;
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    bridge.credentialStatuses.mockImplementation(async () => [
      {
        slot: "openrouter",
        state: "configured",
        runtimeState: active ? "active" : "stored-inactive",
      },
    ]);
    bridge.applyLlmSelection.mockImplementation(() => pending.promise);
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await openApiKeyPanel(user);
    await chooseOption(user, "onboarding-llm-provider", "openrouter");

    await saveModelKey(user);

    await waitFor(() => {
      expect(bridge.applyLlmSelection).toHaveBeenCalledOnce();
    });
    expect(control("onboarding-llm-provider")).toBeDisabled();
    expect(control("onboarding-llm-model")).toBeDisabled();
    expect(control("onboarding-endpoint-mode")).toBeDisabled();

    active = true;
    pending.resolve({ status: "configured", runtimeReady: true });
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });
    expect(bridge.applyLlmSelection).toHaveBeenCalledWith({
      catalogRevision: 7,
      provider: "openrouter",
      model: "deepseek/deepseek-v4-flash",
      endpoint: { mode: "automatic" },
    });
    wizard.controller.dispose();
  });

  it("does not save when Enter is handled by a selection control", async () => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await openApiKeyPanel(user);
    const provider = control<HTMLButtonElement>("onboarding-llm-provider");

    expect(fireEvent.keyDown(provider, { key: "Enter" })).toBe(true);

    expect(bridge.applyLlmSelection).not.toHaveBeenCalled();
    expect(wizard.controller.state().busy).toBe(false);
    wizard.controller.dispose();
  });

  it("saves the model key when Enter is pressed inside its credential field", async () => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    bridge.credentialStatuses.mockResolvedValue([
      { slot: "anthropic", state: "configured", runtimeState: "active" },
    ]);
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await openApiKeyPanel(user);

    expect(fireEvent.keyDown(passwordInput("anthropic"), { key: "Enter" })).toBe(false);

    await waitFor(() => {
      expect(bridge.applyLlmSelection).toHaveBeenCalledOnce();
    });
    wizard.controller.dispose();
  });

  it("connects Intervals only through the zero-argument clipboard action and focuses Delete", async () => {
    const user = userEvent.setup();
    const pending = deferred<IntervalsCredentialMutationResult>();
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    bridge.pasteIntervalsApiKeyFromClipboard.mockImplementation(() => pending.promise);
    const wizard = mountWizard({ bridge });
    await wizard.open();
    enableCredentialDeletion();
    await openTrainingPanel(user);
    const trainingPanel = panel("training");
    if (trainingPanel === null) throw new Error("Training panel did not open");

    expect(trainingPanel.querySelector('input[data-slot="intervals-icu"]')).toBeNull();
    expect(fireEvent.keyDown(trainingPanel, { key: "Enter" })).toBe(true);
    expect(bridge.pasteIntervalsApiKeyFromClipboard).not.toHaveBeenCalled();
    await user.click(panelButton("training", "Use copied API key"));

    await waitFor(() => {
      expect(bridge.pasteIntervalsApiKeyFromClipboard).toHaveBeenCalledOnce();
    });
    expect(bridge.pasteIntervalsApiKeyFromClipboard.mock.calls[0]).toEqual([]);
    expect(bridge.writeCredential).not.toHaveBeenCalled();
    pending.resolve({
      outcome: "applied",
      current: { slot: "intervals-icu", state: "configured", runtimeState: "active" },
    });
    await waitFor(() => {
      expect(rowState("training")).toBe("ready");
    });
    await waitFor(() => {
      expect(button("Delete the Intervals.icu connection")).toHaveFocus();
    });
    expect(panel("training")).toBeNull();
    wizard.controller.dispose();
  });

  it("retains a custom model and endpoint through provider switches and activation retry", async () => {
    const user = userEvent.setup();
    const secret = randomUUID();
    const selection = {
      catalogRevision: 7,
      provider: "openrouter" as const,
      model: "vendor/private-model",
      endpoint: { mode: "custom" as const, value: "https://models.example.test/v1" },
    };
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    bridge.credentialStatuses
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ slot: "openrouter", state: "configured", runtimeState: "failed" }])
      .mockResolvedValueOnce([{ slot: "openrouter", state: "configured", runtimeState: "active" }]);
    bridge.writeCredential.mockImplementation(async ({ slot }) => ({
      slot,
      status: "refused",
      reason: "runtime-unavailable",
    }));
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await openApiKeyPanel(user);
    await chooseOption(user, "onboarding-llm-provider", "openrouter");
    await chooseOption(user, "onboarding-llm-model", "__custom__");
    await typeInto(user, "onboarding-custom-model", selection.model);
    await chooseOption(user, "onboarding-endpoint-mode", "custom");
    await typeInto(user, "onboarding-custom-endpoint", selection.endpoint.value);

    await chooseOption(user, "onboarding-llm-provider", "anthropic");
    await chooseOption(user, "onboarding-llm-provider", "openrouter");

    expect(control("onboarding-llm-model")).toHaveTextContent("Other model…");
    expect(control<HTMLInputElement>("onboarding-custom-model").value).toBe(selection.model);
    expect(control("onboarding-endpoint-mode")).toHaveTextContent("Use a custom endpoint");
    expect(control<HTMLInputElement>("onboarding-custom-endpoint").value).toBe(
      selection.endpoint.value,
    );
    seedSecret("openrouter", secret);

    await saveModelKey(user);

    await waitFor(() => {
      expect(wizard.controller.state().fixedError).toBe("model-runtime-unavailable");
    });
    expect(bridge.writeCredential).toHaveBeenCalledWith({
      slot: "openrouter",
      value: secret,
      selection,
    });
    expect(passwordInput("openrouter").value).toBe("");
    expect(control<HTMLInputElement>("onboarding-custom-model").value).toBe(selection.model);
    expect(control<HTMLInputElement>("onboarding-custom-endpoint").value).toBe(
      selection.endpoint.value,
    );

    await saveModelKey(user);

    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });
    expect(bridge.applyLlmSelection).toHaveBeenCalledWith(selection);
    expect(bridge.writeCredential).toHaveBeenCalledTimes(1);
    wizard.controller.dispose();
  });

  it("blocks a non-loopback HTTP endpoint before invoking credential or runtime IPC", async () => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await openApiKeyPanel(user);
    await chooseOption(user, "onboarding-llm-provider", "openrouter");
    await chooseOption(user, "onboarding-endpoint-mode", "custom");
    await typeInto(user, "onboarding-custom-endpoint", "http://models.example.test/v1");
    seedSecret("openrouter", randomUUID());

    await saveModelKey(user);

    await waitFor(() => {
      expect(wizard.controller.state().fixedError).toBe("endpoint-invalid");
    });
    expect(errorText()).toBe("Enter a valid HTTPS endpoint, or a loopback HTTP endpoint.");
    expect(bridge.writeCredential).not.toHaveBeenCalled();
    expect(bridge.applyLlmSelection).not.toHaveBeenCalled();
    wizard.controller.dispose();
  });

  it("passes the ChatGPT lane's default model to sign-in", async () => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await chooseLane(user, "openai-codex");

    await user.click(button("Sign in with ChatGPT"));

    await waitFor(() => {
      expect(bridge.chatGptLogin).toHaveBeenCalledOnce();
    });
    expect(bridge.chatGptLogin).toHaveBeenCalledWith({
      operationId: expect.any(String),
      selection: {
        catalogRevision: 7,
        provider: "openai-codex",
        model: "gpt-5.5",
        endpoint: { mode: "automatic" },
      },
    });
    wizard.controller.dispose();
  });

  it.each([{ runtimeState: "active" }, { runtimeState: "stored-inactive" }] as const)(
    "recovers a selected provider from $runtimeState only after it is active",
    async (status) => {
      const user = userEvent.setup();
      const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
      bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
      bridge.credentialStatuses
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { slot: "anthropic", state: "configured", runtimeState: status.runtimeState },
        ])
        .mockResolvedValueOnce([
          { slot: "anthropic", state: "configured", runtimeState: "active" },
        ]);
      let credentialWriteCount = 0;
      bridge.writeCredential.mockImplementation(async ({ slot }) => {
        credentialWriteCount += 1;
        return { slot, status: "refused", reason: "runtime-unavailable" };
      });
      const wizard = mountWizard({ bridge });
      await wizard.open();
      await openApiKeyPanel(user);
      seedSecret("anthropic", randomUUID());

      await saveModelKey(user);

      await waitFor(() => {
        expect(rowState("ai")).toBe("ready");
      });
      expect(wizard.controller.state().fixedError).toBeNull();
      expect(document.body.textContent).not.toContain(
        "That key was saved, but it is not active yet.",
      );
      expect(retryButtons()).toHaveLength(0);
      expect(bridge.applyLlmSelection).toHaveBeenCalledOnce();
      expect(credentialWriteCount).toBe(1);
      wizard.controller.dispose();
    },
  );

  it("never writes an unrelated saved key when saving the selected provider", async () => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    bridge.credentialStatuses.mockResolvedValueOnce([]).mockResolvedValue([
      { slot: "anthropic", state: "configured", runtimeState: "active" },
      { slot: "openrouter", state: "configured", runtimeState: "failed" },
    ]);
    const writes: string[] = [];
    bridge.writeCredential.mockImplementation(async ({ slot }) => {
      writes.push(slot);
      return { slot, status: "configured", runtimeReady: true };
    });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await openApiKeyPanel(user);
    seedSecret("anthropic", randomUUID());

    await saveModelKey(user);

    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });
    expect(writes).toEqual(["anthropic"]);
    expect(retryButtons()).toHaveLength(0);
    wizard.controller.dispose();
  });

  it.each([
    { refreshedState: "re-prompt", description: "must be re-entered" },
    { refreshedState: "missing", description: "is reported missing" },
    { refreshedState: null, description: "is absent" },
  ] as const)("asks for the key again when the refreshed key $description", async (status) => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    bridge.credentialStatuses
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(
        status.refreshedState === null
          ? []
          : [{ slot: "anthropic", state: status.refreshedState, runtimeState: null }],
      );
    bridge.writeCredential.mockImplementation(async ({ slot }) => ({
      slot,
      status: "refused",
      reason: "runtime-unavailable",
    }));
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await openApiKeyPanel(user);
    seedSecret("anthropic", randomUUID());

    await saveModelKey(user);

    await waitFor(() => {
      expect(wizard.controller.state()).toMatchObject({
        fixedError: "credential-reenter-required",
        credentialStatus: { anthropic: status.refreshedState ?? "missing" },
      });
    });
    expect(errorText()).toBe("That saved key could not be used. Enter it again to continue.");
    expect(retryButtons()).toHaveLength(0);
    wizard.controller.dispose();
  });

  it.each([
    { state: "configured", runtimeState: "stored-inactive" },
    { state: "re-prompt", runtimeState: null },
  ] as const)("does not offer retry for an unrelated $state status", async (status) => {
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    bridge.credentialStatuses.mockResolvedValue([
      { slot: "anthropic", state: status.state, runtimeState: status.runtimeState },
    ]);
    const wizard = mountWizard({ bridge });

    await wizard.open();

    expect(retryButtons()).toHaveLength(0);
    wizard.controller.dispose();
  });

  it("uses fixed generic copy when a credential write throws", async () => {
    const user = userEvent.setup();
    const exceptionDetail = "write exception detail must stay private";
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.writeCredential.mockRejectedValue(new Error(exceptionDetail));
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await openApiKeyPanel(user);
    const secret = seedSecret("anthropic", randomUUID());

    await saveModelKey(user);

    await waitFor(() => {
      expect(wizard.controller.state().fixedError).toBe("credential-save-failed");
    });
    expect(errorText()).toBe("That key could not be saved. Try entering it again.");
    expect(document.body.textContent).not.toContain(exceptionDetail);
    expect(rowState("ai")).toBe("pending");
    expect(secret.value).toBe("");
    expect(bridge.credentialStatuses).toHaveBeenCalledTimes(2);
    wizard.controller.dispose();
  });

  it("keeps the active coach available when a draft key status cannot be refreshed", async () => {
    const user = userEvent.setup();
    const exceptionDetail = "status exception detail must stay private";
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.credentialStatuses
      .mockResolvedValueOnce([
        { slot: "anthropic", state: "configured", runtimeState: "active" },
        { slot: "intervals-icu", state: "configured", runtimeState: "active" },
      ])
      .mockRejectedValueOnce(new Error(exceptionDetail));
    bridge.writeCredential.mockImplementation(async ({ slot }) => ({
      slot,
      status: "refused",
      reason: "runtime-unavailable",
    }));
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await answerIntake(user);
    expect(primaryButton()).toBeEnabled();
    await openApiKeyPanel(user);
    const secret = seedSecret("anthropic", randomUUID());

    await saveModelKey(user);

    await waitFor(() => {
      expect(wizard.controller.state().fixedError).toBe("credential-status-unavailable");
    });
    expect(errorText()).toBe(
      "That key was saved, but its status could not be refreshed. Check the setup area again.",
    );
    expect(document.body.textContent).not.toContain(exceptionDetail);
    expect(rowState("ai")).toBe("pending");
    expect(primaryButton()).toBeEnabled();
    expect(secret.value).toBe("");
    expect(bridge.credentialStatuses).toHaveBeenCalledTimes(2);
    wizard.controller.dispose();
  });

  it("keeps training pending when clipboard metadata reports uncertain storage", async () => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.credentialStatuses.mockResolvedValue([
      { slot: "anthropic", state: "configured", runtimeState: "active" },
    ]);
    bridge.pasteIntervalsApiKeyFromClipboard.mockResolvedValue({
      outcome: "uncertain",
      reason: "storage-uncertain",
      current: { slot: "intervals-icu", state: "re-prompt", runtimeState: null },
    });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await answerIntake(user);
    await openTrainingPanel(user);

    await user.click(panelButton("training", "Use copied API key"));

    await waitFor(() => {
      expect(wizard.controller.state().fixedError).toBe("intervals-storage-uncertain");
    });
    expect(errorText()).toBe(
      "Enduragent couldn’t confirm whether the copied API key was saved. Reload credential status before trying again.",
    );
    expect(panel("training")).not.toBeNull();
    expect(rowState("training")).toBe("pending");
    expect(primaryButton()).toBeDisabled();
    expect(bridge.pasteIntervalsApiKeyFromClipboard.mock.calls[0]).toEqual([]);
    expect(bridge.credentialStatuses).toHaveBeenCalledOnce();
    expect(bridge.writeCredential).not.toHaveBeenCalled();
    wizard.controller.dispose();
  });

  it("accepts an active key when only the unrelated ChatGPT status refresh fails", async () => {
    const user = userEvent.setup();
    const exceptionDetail = "ChatGPT status detail must stay private";
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.writeCredential.mockImplementation(async ({ slot }) => ({
      slot,
      status: "configured",
      runtimeReady: true,
    }));
    bridge.credentialStatuses
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ slot: "anthropic", state: "configured", runtimeState: "active" }]);
    bridge.chatGptStatus
      .mockResolvedValueOnce({ state: "configured", runtimeReady: true })
      .mockRejectedValueOnce(new Error(exceptionDetail));
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await openApiKeyPanel(user);
    await chooseOption(user, "onboarding-llm-provider", "anthropic");
    seedSecret("anthropic", randomUUID());

    await saveModelKey(user);

    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });
    expect(wizard.controller.state().fixedError).toBeNull();
    expect(wizard.controller.state().chatGptRuntimeState).toBe("ready");
    expect(document.body.textContent).not.toContain(exceptionDetail);
    wizard.controller.dispose();
  });

  it("marks the AI row ready after a configured key write and refreshed active status", async () => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    bridge.credentialStatuses
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ slot: "anthropic", state: "configured", runtimeState: "active" }]);
    let credentialWriteCount = 0;
    bridge.writeCredential.mockImplementation(async ({ slot }) => {
      credentialWriteCount += 1;
      return { slot, status: "configured", runtimeReady: true };
    });
    const onComplete = vi.fn();
    const wizard = mountWizard({ bridge, onComplete });
    await wizard.open();
    await openApiKeyPanel(user);
    const secret = seedSecret("anthropic", randomUUID());

    await saveModelKey(user);

    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });
    expect(secret.value).toBe("");
    expect(credentialWriteCount).toBe(1);
    expect(bridge.credentialStatuses).toHaveBeenCalledTimes(2);
    expect(onComplete).not.toHaveBeenCalled();
    wizard.controller.dispose();
  });

  it("discloses where each secret is typed without starting sign-in, writing, or completing", async () => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    const stateBeforeReading = wizard.controller.state();

    await chooseLane(user, "openai-codex");
    expect(panel("chatgpt")?.textContent).toContain(
      "Opens OpenAI's sign-in page in your browser — you type your password there, not here.",
    );
    expect(panel("chatgpt")?.textContent).toContain("Needs a paid plan.");
    await chooseLane(user, "api-key");
    expect(panel("api-key")?.textContent).toContain(
      "Created in the provider's console, billed per use — usually cents per conversation.",
    );

    expect(bridge.chatGptLogin).not.toHaveBeenCalled();
    expect(bridge.writeCredential).not.toHaveBeenCalled();
    expect(wizard.controller.state()).toEqual(stateBeforeReading);
    wizard.controller.dispose();
  });

  it("runs ChatGPT sign-in through pending to a ready row", async () => {
    const user = userEvent.setup();
    const login = deferred<{ readonly status: "configured"; readonly runtimeReady: true }>();
    const bridge = testBridge(() => login.promise);
    bridge.chatGptStatus.mockResolvedValueOnce({ state: "absent", runtimeReady: false });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await chooseLane(user, "openai-codex");

    const signIn = button("Sign in with ChatGPT");
    expect(signIn.type).toBe("button");
    expect(signIn).toBeEnabled();
    await user.click(signIn);

    expect(bridge.chatGptLogin).toHaveBeenCalledTimes(1);
    expect(button("Waiting for browser…")).toBeDisabled();
    act(() => {
      wizard.controller.startChatGptLogin();
    });
    expect(bridge.chatGptLogin).toHaveBeenCalledTimes(1);

    login.resolve({ status: "configured", runtimeReady: true });
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });
    expect(panel("chatgpt")).toBeNull();
    expect(bridge.writeCredential).not.toHaveBeenCalled();
    wizard.controller.dispose();
  });

  it("renders the refusal state inside the ChatGPT panel", async () => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "refused", reason: "timed-out" }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await chooseLane(user, "openai-codex");

    await user.click(button("Sign in with ChatGPT"));

    await waitFor(() => {
      expect(panel("chatgpt")?.textContent).toContain(
        "ChatGPT sign-in timed out. Retry when you are ready.",
      );
    });
    expect(button("Sign in with ChatGPT")).toBeEnabled();
    wizard.controller.dispose();
  });

  it("owns drops whenever Setup is open and gates on returned imported counts", async () => {
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.importFiles
      .mockResolvedValueOnce(importResult({ total: 2, imported: 1, quarantined: 1 }))
      .mockResolvedValueOnce(importResult({ total: 2, imported: 0, quarantined: 2 }));
    const wizard = mountWizard({ bridge });
    await wizard.open();
    expect(wizard.controller.ownsDroppedImportFiles()).toBe(true);

    act(() => {
      wizard.controller.importDroppedFiles(["/synthetic/batch.fit"]);
    });
    await waitFor(() => {
      expect(bridge.importFiles).toHaveBeenCalledOnce();
    });
    await waitFor(() => {
      expect(wizard.controller.state().importedRideFileCount).toBe(1);
    });
    expect(document.body.textContent).toContain(
      "Local library import: 1 ride file imported. 1 ride file quarantined. Coaching access to activities and streams is available.",
    );
    expect(rowState("training")).toBe("pending");
    expect(useEnduragentStore.getState().onboarding.readiness.trainingData).toBe(true);

    act(() => {
      wizard.controller.importDroppedFiles(["/synthetic/quarantined.fit"]);
    });
    await waitFor(() => {
      expect(bridge.importFiles).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(document.body.textContent).toContain(
        "Local library import failed. 0 ride files imported. 2 ride files quarantined. No new ride files are available for coaching.",
      );
    });
    expect(wizard.controller.state().importedRideFileCount).toBe(1);
    expect(document.body.textContent).not.toContain("Import completed");

    act(() => {
      wizard.controller.close();
    });
    expect(wizard.controller.ownsDroppedImportFiles()).toBe(false);
    wizard.controller.dispose();
  });

  it("routes the ride file picker through the onboarding importer", async () => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.chooseImportFiles.mockResolvedValue(["/synthetic/chosen.fit"]);
    bridge.importFiles.mockResolvedValue(importResult({ total: 1, imported: 1, quarantined: 0 }));
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await openTrainingPanel(user);

    expect(panel("training")?.textContent).toContain(
      "In Intervals.icu, open Settings → Developer Settings, copy the API key, then return here. Enduragent reads it without showing it.",
    );
    await user.click(button("Import ride files instead"));

    await waitFor(() => {
      expect(bridge.chooseImportFiles).toHaveBeenCalledOnce();
    });
    await waitFor(() => {
      expect(bridge.importFiles).toHaveBeenCalledWith(["/synthetic/chosen.fit"], expect.anything());
    });
    await waitFor(() => {
      expect(wizard.controller.state().importedRideFileCount).toBe(1);
    });
    wizard.controller.dispose();
  });

  it.each([
    {
      source: "file-only",
      statuses: [],
      importRide: true,
      requiresProviderSync: false,
    },
    {
      source: "platform-only",
      statuses: [{ slot: "intervals-icu", state: "configured", runtimeState: "active" }] as const,
      importRide: false,
      requiresProviderSync: true,
    },
    {
      source: "mixed",
      statuses: [{ slot: "intervals-icu", state: "configured", runtimeState: "active" }] as const,
      importRide: true,
      requiresProviderSync: true,
    },
  ] as const)(
    "hands off the transient sync requirement for $source setup",
    async ({ statuses, importRide, requiresProviderSync }) => {
      const user = userEvent.setup();
      const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
      bridge.credentialStatuses.mockResolvedValue(statuses);
      bridge.importFiles.mockResolvedValue(importResult({ total: 1, imported: 1, quarantined: 0 }));
      const onComplete = vi.fn();
      const wizard = mountWizard({ bridge, onComplete });

      await wizard.open();
      if (importRide) {
        act(() => {
          wizard.controller.importDroppedFiles(["/synthetic/setup.fit"]);
        });
        await waitFor(() => {
          expect(wizard.controller.state().importedRideFileCount).toBe(1);
        });
      }
      await answerIntake(user);
      await waitFor(() => {
        expect(primaryButton()).toBeEnabled();
      });

      await user.click(primaryButton());

      await waitFor(() => {
        expect(onComplete).toHaveBeenCalledOnce();
      });
      expect(bridge.saveIntake).toHaveBeenCalledWith({
        swim_skill_floor: null,
        continuous_distance_capable: null,
        open_water_comfort: null,
        prior_bsi: false,
        clinician_cleared: null,
        injury_status: "none",
      });
      expect(onComplete).toHaveBeenCalledWith({
        providerConfigured: true,
        trainingDataConfigured: true,
        intakeSaved: true,
        requiresProviderSync,
      });
      wizard.controller.dispose();
    },
  );

  it("finishes on the injury answer alone once an injury history is recorded", async () => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.credentialStatuses.mockResolvedValue([
      { slot: "intervals-icu", state: "configured", runtimeState: "active" },
    ]);
    const wizard = mountWizard({ bridge });
    await wizard.open();

    await chooseOption(user, "onboarding-injury-status", "returning");

    expect(document.querySelector("#onboarding-clinician-cleared")).toBeNull();

    await waitFor(() => {
      expect(primaryButton()).toBeEnabled();
    });
    await user.click(primaryButton());

    await waitFor(() => {
      expect(bridge.saveIntake).toHaveBeenCalledOnce();
    });
    expect(bridge.saveIntake).toHaveBeenCalledWith({
      swim_skill_floor: null,
      continuous_distance_capable: null,
      open_water_comfort: null,
      prior_bsi: false,
      clinician_cleared: null,
      injury_status: "returning",
    });
    wizard.controller.dispose();
  });

  it("keeps the athlete on the screen when the intake write fails", async () => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.credentialStatuses.mockResolvedValue([
      { slot: "intervals-icu", state: "configured", runtimeState: "active" },
    ]);
    bridge.saveIntake.mockRejectedValue(new Error("intake detail must stay private"));
    const onComplete = vi.fn();
    const wizard = mountWizard({ bridge, onComplete });
    await wizard.open();
    await answerIntake(user);
    await waitFor(() => {
      expect(primaryButton()).toBeEnabled();
    });

    await user.click(primaryButton());

    await waitFor(() => {
      expect(wizard.controller.state().fixedError).toBe("intake-save-failed");
    });
    expect(errorText()).toBe("Your answers could not be saved. Please try again.");
    expect(onComplete).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("intake detail must stay private");
    wizard.controller.dispose();
  });

  it("refuses to finish while the provider gate is unmet", async () => {
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    bridge.credentialStatuses.mockResolvedValue([
      { slot: "intervals-icu", state: "configured", runtimeState: "active" },
    ]);
    const onComplete = vi.fn();
    const wizard = mountWizard({ bridge, onComplete });
    await wizard.open();
    act(() => {
      wizard.controller.setIntake("injuryStatus", "none");
    });

    act(() => {
      wizard.controller.finish();
    });

    await waitFor(() => {
      expect(wizard.controller.state().fixedError).toBe("credential-required");
    });
    expect(errorText()).toBe("Sign in with ChatGPT or add at least one model key to continue.");
    expect(bridge.saveIntake).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    wizard.controller.dispose();
  });

  it("refuses to finish while the training gate is unmet", async () => {
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.credentialStatuses.mockResolvedValue([]);
    const onComplete = vi.fn();
    const wizard = mountWizard({ bridge, onComplete });
    await wizard.open();
    act(() => {
      wizard.controller.setIntake("injuryStatus", "none");
    });

    act(() => {
      wizard.controller.finish();
    });

    await waitFor(() => {
      expect(wizard.controller.state().fixedError).toBe("training-data-required");
    });
    expect(errorText()).toBe("Connect intervals.icu or import at least one ride file.");
    expect(bridge.saveIntake).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    wizard.controller.dispose();
  });

  it("refuses to finish while the intake gate is unmet", async () => {
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.credentialStatuses.mockResolvedValue([
      { slot: "intervals-icu", state: "configured", runtimeState: "active" },
    ]);
    const onComplete = vi.fn();
    const wizard = mountWizard({ bridge, onComplete });
    await wizard.open();

    act(() => {
      wizard.controller.finish();
    });

    await waitFor(() => {
      expect(wizard.controller.state().fixedError).toBe("intake-incomplete");
    });
    expect(errorText()).toBe("Answer the required safety questions to continue.");
    expect(bridge.saveIntake).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
    wizard.controller.dispose();
  });

  it("does not start a dropped import while clipboard connection is in flight", async () => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    const pendingConnection = deferred<IntervalsCredentialMutationResult>();
    bridge.pasteIntervalsApiKeyFromClipboard.mockImplementation(() => pendingConnection.promise);
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await openTrainingPanel(user);

    await user.click(panelButton("training", "Use copied API key"));
    await waitFor(() => {
      expect(bridge.pasteIntervalsApiKeyFromClipboard).toHaveBeenCalledOnce();
    });
    act(() => {
      wizard.controller.importDroppedFiles(["/synthetic/during-submit.fit"]);
    });
    expect(bridge.importFiles).not.toHaveBeenCalled();

    pendingConnection.resolve({
      outcome: "applied",
      current: { slot: "intervals-icu", state: "configured", runtimeState: "active" },
    });
    await waitFor(() => {
      expect(wizard.controller.state().busy).toBe(false);
    });
    expect(bridge.writeCredential).not.toHaveBeenCalled();
    wizard.controller.dispose();
  });

  it("presents resident-routed import outcomes while Setup is open", async () => {
    const bridge = testBridge(async () => ({ status: "configured", runtimeReady: true }));
    bridge.importFiles.mockResolvedValue(importResult({ total: 2, imported: 1, quarantined: 1 }));
    const presentationChanges = vi.fn();
    const imports = createRideImportController(bridge as OnboardingBridge);
    const wizard = mountWizard({
      bridge,
      rideImports: imports,
      onRideImportPresentationChange: presentationChanges,
    });

    await wizard.open();
    expect(presentationChanges).toHaveBeenLastCalledWith(true);
    await act(async () => {
      await imports.importPaths("resident", ["/synthetic/outside-training.fit"]);
    });
    expect(document.body.textContent).toContain(
      "Local library import: 1 ride file imported. 1 ride file quarantined. Coaching access to activities and streams is available.",
    );

    act(() => {
      wizard.controller.close();
    });
    expect(presentationChanges).toHaveBeenLastCalledWith(false);
    wizard.controller.dispose();
  });
});
