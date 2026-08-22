import { randomUUID } from "node:crypto";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buttonVariants } from "../src/components/ui/button.js";
import { cn } from "../src/lib/utils.js";
import type { OnboardingLlmConfiguration } from "../src/onboarding/bridge.js";
import type { CredentialSettingsPort } from "../src/state/settings-slice.js";
import { useEnduragentStore } from "../src/state/store.js";
import {
  API_KEY_PANEL_HINT,
  FOOTER_NOTE,
  RETRY_INTAKE_SAVE_LABEL,
  SETUP_MENU_LABEL,
} from "../src/ui/onboarding/copy.js";
import {
  chooseLane,
  claudeCliNoteText,
  control,
  importResult,
  laneItems,
  laneMenu,
  mountWizard,
  openApiKeyPanel,
  openLaneMenu,
  openTrainingPanel,
  panel,
  passwordInput,
  primaryButton,
  readyTelegramSettings,
  resetOnboardingStore,
  rowState,
  rowSubtitle,
  seedSecret,
  selectSetupOption,
  setTelegramSettings,
  setupCard,
  setupRow,
  testBridge,
  TEST_LLM_CONFIGURATION,
  type TestBridge,
} from "./onboarding-harness.js";

const CLAUDE_CONFIGURATION: OnboardingLlmConfiguration = {
  ...TEST_LLM_CONFIGURATION,
  providers: [
    ...TEST_LLM_CONFIGURATION.providers,
    {
      provider: "claude-cli",
      defaultModel: "sonnet",
      models: [{ value: "sonnet", label: "Claude Sonnet" }],
    },
  ],
  active: { provider: "claude-cli", model: "sonnet" },
};

function coldBridge(): TestBridge {
  const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
  bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
  return bridge;
}

function claudeReadyBridge(): TestBridge {
  const bridge = coldBridge();
  bridge.llmConfiguration.mockResolvedValue(CLAUDE_CONFIGURATION);
  bridge.claudeCliStatus.mockResolvedValue({
    state: "ready",
    email: "athlete@example.test",
    plan: "Max",
  });
  bridge.claudeCliRecheck.mockResolvedValue({ state: "ready" });
  return bridge;
}

function readyEverythingBridge(): TestBridge {
  const bridge = claudeReadyBridge();
  bridge.credentialStatuses.mockResolvedValue([
    { slot: "intervals-icu", state: "configured", runtimeState: "active" },
  ]);
  return bridge;
}

function claudeSignedOutBridge(): TestBridge {
  const bridge = coldBridge();
  bridge.llmConfiguration.mockResolvedValue({ ...CLAUDE_CONFIGURATION, active: null });
  bridge.claudeCliStatus.mockResolvedValue({ state: "not-logged-in" });
  return bridge;
}

function rowIds(): readonly string[] {
  return Array.from(setupCard().children)
    .map((child) => (child as HTMLElement).dataset.setupRow ?? "")
    .filter((id) => id !== "");
}

function trigger(id: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-setup-trigger="${id}"]`);
  if (element === null) throw new Error(`Trigger not found: ${id}`);
  return element;
}

function buttonNames(host: HTMLElement | null): readonly string[] {
  return Array.from(
    host?.querySelectorAll('button:not([role="combobox"])') ?? [],
    (entry) => entry.textContent ?? "",
  );
}

function bindCredentialPort(): CredentialSettingsPort {
  const port = {
    retry: vi.fn(),
    requestDelete: vi.fn(),
    cancelDelete: vi.fn(),
    confirmDelete: vi.fn(),
    setupOpened: vi.fn(),
    openSetup: vi.fn(),
  } satisfies CredentialSettingsPort;
  act(() => {
    useEnduragentStore.setState({ settingsPorts: { credentials: port } as never });
  });
  return port;
}

async function completeIntake(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await selectSetupOption(user, "onboarding-injury-status", "none");
}

describe("setup card", () => {
  afterEach(() => {
    resetOnboardingStore();
  });

  it("renders one bordered card whose rows are dividers, not gaps", async () => {
    const wizard = mountWizard({ bridge: coldBridge() });
    await wizard.open();

    const card = setupCard();
    expect(card.className).toContain("[&>*+*]:border-t");
    expect(card.className).toContain("[&>*+*]:border-line");
    expect(card.className).toContain("[&>*:first-child]:rounded-t-xl");
    expect(card.className).toContain("[&>*:last-child]:rounded-b-xl");
    expect(card.className).not.toContain("overflow-hidden");
    expect(setupRow("ai").parentElement).toBe(card);
    expect(setupRow("training").parentElement).toBe(card);
    expect(setupRow("injury-status").parentElement).toBe(card);
    wizard.controller.dispose();
  });

  it("hides inactive credential loading feedback on the gate but keeps it in Settings", async () => {
    const gate = mountWizard({ bridge: coldBridge() });
    await gate.open();

    expect(screen.queryByText("Loading saved credentials…")).toBeNull();
    expect(document.querySelector("[data-credential-feedback]")).toBeNull();
    gate.controller.dispose();
    gate.rendered.unmount();
    resetOnboardingStore();

    const settings = mountWizard({ bridge: coldBridge(), placement: "settings" });
    await settings.open();

    expect(screen.getByText("Loading saved credentials…")).toBeInTheDocument();
    expect(document.querySelector("[data-credential-feedback]")).not.toBeNull();
    settings.controller.dispose();
  });

  it("keeps credential repair feedback and its reload action on the gate", async () => {
    const user = userEvent.setup();
    const wizard = mountWizard({ bridge: coldBridge() });
    await wizard.open();
    const port = bindCredentialPort();

    act(() => {
      useEnduragentStore.setState({
        settings: {
          ...useEnduragentStore.getState().settings,
          credentials: {
            status: "error",
            kind: "load",
            announcement: "That saved key could not be reloaded.",
            repairCredential: "anthropic",
            recoveryAvailable: false,
            focus: null,
          },
        },
      });
    });

    expect(screen.getByText("That saved key could not be reloaded.")).toBeInTheDocument();
    const reload = screen.getByRole("button", { name: "Reload credential status" });
    expect(reload).toBeEnabled();
    await user.click(reload);
    expect(port.retry).toHaveBeenCalledOnce();
    wizard.controller.dispose();
  });

  it("keeps reload enabled when credential repair survives Settings cleanup", async () => {
    const user = userEvent.setup();
    const wizard = mountWizard({ bridge: coldBridge() });
    await wizard.open();
    const port = bindCredentialPort();

    act(() => {
      useEnduragentStore.setState({
        settings: {
          ...useEnduragentStore.getState().settings,
          credentials: { status: "closed", repairCredential: "openrouter" },
        },
      });
    });

    expect(
      screen.getByText("Saved credential status needs to be reloaded before setup can continue."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Loading saved credentials…")).toBeNull();
    const reload = screen.getByRole("button", { name: "Reload credential status" });
    expect(reload).toBeEnabled();
    await user.click(reload);
    expect(port.retry).toHaveBeenCalledOnce();
    wizard.controller.dispose();
  });

  it("keeps every sub-panel a sibling row inside the same card", async () => {
    const user = userEvent.setup();
    const wizard = mountWizard({ bridge: coldBridge() });
    await wizard.open();
    await openApiKeyPanel(user);
    await openTrainingPanel(user);

    const card = setupCard();
    expect(panel("api-key")?.parentElement).toBe(card);
    expect(panel("training")?.parentElement).toBe(card);
    expect(setupRow("ai").nextElementSibling).toBe(panel("api-key"));
    expect(setupRow("training").nextElementSibling).toBe(panel("training"));
    wizard.controller.dispose();
  });

  it("labels the AI trigger Choose when nothing is set and Change when a lane is ready", async () => {
    const cold = mountWizard({ bridge: coldBridge() });
    await cold.open();
    expect(
      screen.getByRole("button", { name: "Choose what powers your coach" }),
    ).toBeInTheDocument();
    expect(rowState("ai")).toBe("pending");
    expect(setupRow("ai").textContent).toContain("AI that powers your coach");
    expect(rowSubtitle("ai")).toBe("Required — Enduragent doesn't include one");
    cold.controller.dispose();
    cold.rendered.unmount();
    resetOnboardingStore();

    const warm = mountWizard({ bridge: claudeReadyBridge() });
    await warm.open();
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });
    const change = screen.getByRole("button", { name: "Change what powers your coach" });
    expect(change.className).toBe(
      screen.getByRole("button", { name: "Connect Intervals.icu" }).className,
    );
    warm.controller.dispose();
  });

  it("shows an active off-catalogue provider as ready in Settings until replacement", async () => {
    const user = userEvent.setup();
    const bridge = readyEverythingBridge();
    bridge.llmConfiguration.mockResolvedValue({
      ...CLAUDE_CONFIGURATION,
      active: { provider: "codex-agent", model: "synthetic-codex" },
    });
    const wizard = mountWizard({ bridge, placement: "settings" });
    await wizard.open();

    expect(rowState("ai")).toBe("ready");
    expect(setupRow("ai").textContent).toContain("Codex agent (experimental)");
    expect(rowSubtitle("ai")).toBe("Connected · powers your coach");
    expect(screen.getByRole("button", { name: "Change what powers your coach" })).toBeEnabled();

    await openLaneMenu(user);
    expect(laneItems().map((item) => item.dataset.lane)).not.toContain("codex-agent");
    const apiKeyLane = document.querySelector<HTMLElement>('[data-lane="api-key"]');
    expect(apiKeyLane).not.toBeNull();
    await user.click(apiKeyLane as HTMLElement);
    await waitFor(() => {
      expect(panel("api-key")).not.toBeNull();
    });
    expect(rowState("ai")).toBe("pending");
    await user.click(control("onboarding-llm-provider"));
    expect(screen.queryByRole("option", { name: "Codex agent (experimental)" })).toBeNull();
    await user.keyboard("{Escape}");
    wizard.controller.dispose();
  });

  it("does not treat an active Codex-agent profile as ready when Windows excludes it", async () => {
    const bridge = readyEverythingBridge();
    bridge.llmConfiguration.mockResolvedValue({
      ...CLAUDE_CONFIGURATION,
      active: { provider: "codex-agent", model: "synthetic-codex" },
    });
    const wizard = mountWizard({
      bridge,
      placement: "settings",
      codexAgentSupported: false,
    });
    await wizard.open();

    expect(rowState("ai")).toBe("pending");
    expect(useEnduragentStore.getState().onboarding.readiness.provider).toBe(false);
    expect(setupRow("ai").textContent).toContain("Required — Enduragent doesn't include one");
    expect(screen.getByRole("button", { name: "Choose what powers your coach" })).toBeEnabled();
    wizard.controller.dispose();
  });

  it("keeps the completion footer on the gate and omits it from Settings", async () => {
    const chat = mountWizard({ bridge: readyEverythingBridge() });
    await chat.open();

    const primary = screen.getByRole("button", { name: "Start coaching" });
    expect(primary).toBeInTheDocument();
    expect(setupCard().contains(primary)).toBe(false);
    expect(screen.getByText("Everything stays on this Mac.")).toBeInTheDocument();
    expect(
      screen.queryByText(
        "Not medical advice, and not a substitute for a doctor or a certified coach.",
      ),
    ).toBeNull();

    chat.controller.dispose();
    chat.rendered.unmount();
    resetOnboardingStore();

    const settings = mountWizard({ bridge: readyEverythingBridge(), placement: "settings" });
    await settings.open();

    expect(screen.queryByRole("button", { name: "Start coaching" })).toBeNull();
    expect(screen.queryByText("Everything stays on this Mac.")).toBeNull();
    settings.controller.dispose();
  });

  it("autosaves Settings intake and offers a retry only after a save error", async () => {
    const user = userEvent.setup();
    const bridge = readyEverythingBridge();
    bridge.saveIntake
      .mockRejectedValueOnce(new Error("private storage detail"))
      .mockResolvedValueOnce();
    const wizard = mountWizard({ bridge, placement: "settings" });
    await wizard.open();

    expect(screen.queryByRole("button", { name: RETRY_INTAKE_SAVE_LABEL })).toBeNull();
    await selectSetupOption(user, "onboarding-injury-status", "none");

    const retry = await screen.findByRole("button", { name: RETRY_INTAKE_SAVE_LABEL });
    expect(retry.className).toContain("underline");
    expect(retry.className).toContain("text-ink-2");
    expect(retry.className).not.toContain("text-danger");
    expect(document.querySelector("#onboarding-error")?.textContent).toBe(
      "Your answers could not be saved. Please try again.",
    );
    expect(bridge.saveIntake).toHaveBeenCalledOnce();

    await user.click(retry);
    await waitFor(() => {
      expect(bridge.saveIntake).toHaveBeenCalledTimes(2);
      expect(wizard.controller.state().fixedError).toBeNull();
    });
    expect(screen.queryByRole("button", { name: RETRY_INTAKE_SAVE_LABEL })).toBeNull();
    wizard.controller.dispose();
  });

  it("outlines AI changes in the gate and gives connected Intervals only Delete", async () => {
    bindCredentialPort();
    const wizard = mountWizard({ bridge: readyEverythingBridge() });
    await wizard.open();
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
      expect(rowState("training")).toBe("ready");
    });

    expect(trigger("ai").className).toContain("border-input");
    expect(document.querySelector('[data-setup-trigger="training"]')).toBeNull();
    const remove = screen.getByRole("button", { name: "Delete the Intervals.icu connection" });
    expect(remove).toHaveTextContent("Delete");
    expect(remove.className).toBe(cn(buttonVariants({ variant: "destructive", size: "sm" })));
    expect(setupRow("training").querySelectorAll("button")).toHaveLength(2);
    wizard.controller.dispose();
  });

  it("opens a menu of the offered lanes with the current one ticked", async () => {
    const user = userEvent.setup();
    const wizard = mountWizard({ bridge: claudeReadyBridge() });
    await wizard.open();
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });

    await openLaneMenu(user);

    expect(laneItems().map((item) => item.dataset.lane)).toEqual([
      "claude-cli",
      "openai-codex",
      "api-key",
    ]);
    expect(laneItems().filter((item) => item.getAttribute("aria-checked") === "true").length).toBe(
      1,
    );
    expect(
      laneItems()
        .find((item) => item.dataset.lane === "claude-cli")
        ?.getAttribute("aria-checked"),
    ).toBe("true");
    wizard.controller.dispose();
  });

  it("turns a chosen not-ready lane into a pending row with its panel beneath it", async () => {
    const user = userEvent.setup();
    const wizard = mountWizard({ bridge: claudeReadyBridge() });
    await wizard.open();
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });

    await chooseLane(user, "openai-codex");

    expect(rowState("ai")).toBe("pending");
    expect(rowSubtitle("ai")).toBe("Powers your coach · sign in to finish");
    expect(primaryButton()).toBeDisabled();
    expect(setupRow("ai").nextElementSibling).toBe(panel("chatgpt"));
    wizard.controller.dispose();
  });

  it("selects an already configured ChatGPT lane without asking the athlete to sign in again", async () => {
    const user = userEvent.setup();
    const bridge = claudeReadyBridge();
    bridge.chatGptStatus.mockResolvedValue({ state: "configured", runtimeReady: true });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });

    await chooseLane(user, "openai-codex");

    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });
    expect(panel("chatgpt")).toBeNull();
    expect(bridge.chatGptLogin).not.toHaveBeenCalled();
    wizard.controller.dispose();
  });

  it("closes ChatGPT setup after a stored profile is activated", async () => {
    const user = userEvent.setup();
    const bridge = claudeReadyBridge();
    bridge.chatGptStatus
      .mockResolvedValueOnce({ state: "configured", runtimeReady: false })
      .mockResolvedValueOnce({ state: "configured", runtimeReady: true });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });

    await chooseLane(user, "openai-codex");

    await waitFor(() => {
      expect(bridge.applyLlmSelection).toHaveBeenCalledOnce();
      expect(rowState("ai")).toBe("ready");
      expect(panel("chatgpt")).toBeNull();
    });
    expect(bridge.chatGptLogin).not.toHaveBeenCalled();
    wizard.controller.dispose();
  });

  it("reactivates the selected stored ChatGPT profile", async () => {
    const user = userEvent.setup();
    const bridge = claudeReadyBridge();
    bridge.llmConfiguration.mockResolvedValue({
      ...CLAUDE_CONFIGURATION,
      active: { provider: "openai-codex", model: "gpt-5.5" },
    });
    bridge.chatGptStatus
      .mockResolvedValueOnce({ state: "configured", runtimeReady: false })
      .mockResolvedValueOnce({ state: "configured", runtimeReady: true });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    expect(rowState("ai")).toBe("pending");

    await chooseLane(user, "openai-codex");

    await waitFor(() => {
      expect(bridge.applyLlmSelection).toHaveBeenCalledOnce();
      expect(rowState("ai")).toBe("ready");
      expect(panel("chatgpt")).toBeNull();
    });
    expect(bridge.chatGptLogin).not.toHaveBeenCalled();
    wizard.controller.dispose();
  });

  it("keeps ChatGPT recovery visible when stored-profile activation fails", async () => {
    const user = userEvent.setup();
    const bridge = claudeReadyBridge();
    bridge.chatGptStatus.mockResolvedValue({ state: "configured", runtimeReady: false });
    bridge.applyLlmSelection.mockResolvedValue({
      status: "refused",
      reason: "runtime-unavailable",
    });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });

    await chooseLane(user, "openai-codex");

    await waitFor(() => {
      expect(wizard.controller.state().chatGptRuntimeState).toBe("failed");
    });
    expect(wizard.controller.state().fixedError).toBeNull();
    expect(panel("chatgpt")).not.toBeNull();
    expect(panel("chatgpt")?.textContent).toContain(
      "Signed in, but the coach could not be activated. Retry without signing in again.",
    );
    expect(screen.getByRole("button", { name: "Retry activation" })).toBeEnabled();
    wizard.controller.dispose();
  });

  it("retries a ready stored ChatGPT profile when it is chosen again", async () => {
    const user = userEvent.setup();
    const bridge = claudeReadyBridge();
    bridge.chatGptStatus.mockResolvedValue({ state: "configured", runtimeReady: true });
    bridge.applyLlmSelection
      .mockResolvedValueOnce({ status: "refused", reason: "runtime-unavailable" })
      .mockResolvedValueOnce({ status: "configured", runtimeReady: true });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });

    await chooseLane(user, "openai-codex");

    await waitFor(() => {
      expect(wizard.controller.state().chatGptRuntimeState).toBe("failed");
    });
    expect(wizard.controller.state().fixedError).toBeNull();
    expect(panel("chatgpt")).not.toBeNull();

    await chooseLane(user, "openai-codex");

    await waitFor(() => {
      expect(bridge.applyLlmSelection).toHaveBeenCalledTimes(2);
      expect(rowState("ai")).toBe("ready");
    });
    expect(wizard.controller.state().fixedError).toBeNull();
    wizard.controller.dispose();
  });

  it("offers one sign-in button and a way back from the ChatGPT panel", async () => {
    const user = userEvent.setup();
    const bridge = claudeReadyBridge();
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });
    await chooseLane(user, "openai-codex");

    const chatgpt = panel("chatgpt");
    expect(chatgpt).not.toBeNull();
    expect(chatgpt?.querySelectorAll("input")).toHaveLength(0);
    expect(chatgpt?.textContent).toContain(
      "Opens OpenAI's sign-in page in your browser — you type your password there, not here.",
    );
    expect(
      Array.from(chatgpt?.querySelectorAll("button") ?? [], (entry) => entry.textContent),
    ).toEqual(["Cancel", "Sign in with ChatGPT"]);
    expect(screen.getByRole("button", { name: "Cancel ChatGPT setup" }).parentElement).toHaveClass(
      "justify-end",
    );
    expect(
      screen.getByRole("button", { name: "Cancel ChatGPT setup" }).parentElement
        ?.previousElementSibling,
    ).toHaveTextContent(
      "Opens OpenAI's sign-in page in your browser — you type your password there, not here.",
    );

    await user.click(screen.getByRole("button", { name: "Cancel ChatGPT setup" }));

    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });
    expect(panel("chatgpt")).toBeNull();
    expect(bridge.chatGptLogin).not.toHaveBeenCalled();
    wizard.controller.dispose();
  });

  it("asks for exactly a provider and a key, with model choices demoted to Advanced", async () => {
    const user = userEvent.setup();
    const wizard = mountWizard({ bridge: coldBridge() });
    await wizard.open();
    await openApiKeyPanel(user);

    expect(screen.getByLabelText("Provider")).toBe(control("onboarding-llm-provider"));
    expect(screen.getByLabelText("Anthropic API key")).toBe(passwordInput("anthropic"));
    const advanced = control("onboarding-llm-model").closest("details");
    expect(advanced).not.toBeNull();
    expect(advanced?.hasAttribute("open")).toBe(false);
    await selectSetupOption(user, "onboarding-llm-provider", "openrouter");
    expect(control("onboarding-endpoint-mode").closest("details")).toBe(
      control("onboarding-llm-model").closest("details"),
    );
    await selectSetupOption(user, "onboarding-llm-provider", "anthropic");

    seedSecret("anthropic", randomUUID());
    await user.click(screen.getByRole("button", { name: "Save API key" }));

    await waitFor(() => {
      expect(wizard.controller.state().busy).toBe(false);
    });
    expect(wizard.rendered).toBeDefined();
    wizard.controller.dispose();
  });

  it("connects Intervals.icu from copied metadata without rendering a secret field", async () => {
    const user = userEvent.setup();
    const wizard = mountWizard({ bridge: coldBridge() });
    await wizard.open();

    await openTrainingPanel(user);

    expect(laneMenu()).toBeNull();
    expect(setupRow("training").nextElementSibling).toBe(panel("training"));
    expect(panel("training")?.querySelectorAll("input")).toHaveLength(0);
    expect(screen.getByRole("heading", { name: "Connect Intervals.icu" })).toHaveFocus();
    expect(panel("training")).toHaveTextContent(
      "In Intervals.icu, open Settings → Developer Settings, copy the API key, then return here. Enduragent reads it without showing it.",
    );
    expect(buttonNames(panel("training"))).toEqual([
      "Cancel",
      "Use copied API key",
      "Import ride files instead",
    ]);
    wizard.controller.dispose();
  });

  it("keeps saved-key recovery without exposing clipboard replacement", async () => {
    const user = userEvent.setup();
    const bridge = claudeReadyBridge();
    bridge.credentialStatuses.mockResolvedValue([
      { slot: "intervals-icu", state: "configured", runtimeState: "failed" },
    ]);
    bridge.retryFailedCredentials.mockResolvedValue([
      { slot: "intervals-icu", state: "configured", runtimeState: "active" },
    ]);
    const wizard = mountWizard({ bridge });
    await wizard.open();

    await user.click(screen.getByRole("button", { name: "Retry saved keys" }));

    await waitFor(() => {
      expect(rowState("training")).toBe("ready");
      expect(panel("training")).toBeNull();
    });
    expect(screen.queryByRole("button", { name: "Use copied API key" })).toBeNull();
    expect(bridge.retryFailedCredentials).toHaveBeenCalledOnce();
    wizard.controller.dispose();
  });

  it("gives every input a visible label", async () => {
    const user = userEvent.setup();
    const wizard = mountWizard({ bridge: coldBridge() });
    await wizard.open();
    await openApiKeyPanel(user);
    await openTrainingPanel(user);
    await selectSetupOption(user, "onboarding-injury-status", "returning");
    await selectSetupOption(user, "onboarding-llm-model", "__custom__");

    const controls = Array.from(
      document.querySelectorAll<HTMLElement>(
        '.setup-panel input:not([aria-hidden="true"]), .setup-panel select, .setup-panel textarea, .setup-panel [role="combobox"]',
      ),
    );
    expect(controls.length).toBeGreaterThan(4);
    for (const element of controls) {
      const id = element.getAttribute("id") ?? "";
      const label = document.querySelector(`label[for="${id}"]`);
      expect(label?.textContent?.trim() ?? "").not.toBe("");
    }
    wizard.controller.dispose();
  });

  it("keeps the info affordance inline in a row title and its popup outside the card", async () => {
    const user = userEvent.setup();
    const wizard = mountWizard({ bridge: coldBridge() });
    await wizard.open();
    const title = setupRow("ai").querySelector("[data-setup-row-title]");
    const trigger = title?.querySelector<HTMLElement>("[data-info-tip]");
    expect(trigger).not.toBeNull();
    expect(trigger).toHaveClass("size-6");

    await user.hover(trigger as HTMLElement);

    await waitFor(() => {
      expect(document.querySelector("[data-info-tip-popup]")).not.toBeNull();
    });
    const popup = document.querySelector("[data-info-tip-popup]") as HTMLElement;
    expect(setupCard().contains(popup)).toBe(false);
    wizard.controller.dispose();
  });

  it("opens info details from the keyboard without moving focus", async () => {
    const user = userEvent.setup();
    const wizard = mountWizard({ bridge: coldBridge() });
    await wizard.open();
    const trigger = setupRow("ai").querySelector<HTMLElement>("[data-info-tip]");
    if (trigger === null) throw new TypeError("info trigger missing");

    trigger.focus();
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(document.querySelector("[data-info-tip-popup]")).not.toBeNull();
    });
    const popup = document.querySelector<HTMLElement>("[data-info-tip-popup]");
    if (popup === null) throw new TypeError("info popup missing");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAttribute("aria-controls", popup.id);
    expect(document.activeElement).toBe(trigger);
    wizard.controller.dispose();
  });

  it("keeps Start coaching disabled until every requirement is met", async () => {
    const user = userEvent.setup();
    const bridge = readyEverythingBridge();
    const onComplete = vi.fn();
    const wizard = mountWizard({ bridge, onComplete });
    await wizard.open();
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });
    expect(rowState("training")).toBe("ready");
    expect(primaryButton()).toBeDisabled();
    expect(document.querySelector("[data-setup-readiness]")).toHaveTextContent(
      "2 of 3 required ready",
    );

    await selectSetupOption(user, "onboarding-injury-status", "none");

    await waitFor(() => {
      expect(rowState("injury-status")).toBe("ready");
      expect(primaryButton()).toBeEnabled();
      expect(document.querySelector("[data-setup-readiness]")).toHaveTextContent(
        "3 of 3 required ready",
      );
    });
    expect(bridge.saveIntake).not.toHaveBeenCalled();
    await user.click(primaryButton());

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledOnce();
    });
    expect(bridge.saveIntake).toHaveBeenCalledOnce();
    wizard.controller.dispose();
  });

  it("stays disabled when only the intake is complete", async () => {
    const user = userEvent.setup();
    const wizard = mountWizard({ bridge: coldBridge() });
    await wizard.open();

    expect(document.querySelector("[data-setup-readiness]")).toHaveTextContent(
      "0 of 3 required ready",
    );
    expect(primaryButton()).toBeDisabled();

    await completeIntake(user);

    expect(rowState("ai")).toBe("pending");
    expect(rowState("training")).toBe("pending");
    expect(document.querySelector("[data-setup-readiness]")).toHaveTextContent(
      "1 of 3 required ready",
    );
    expect(primaryButton()).toBeDisabled();
    wizard.controller.dispose();
  });

  it("uses status color for completion and a quiet brand tint for the optional badge", async () => {
    const wizard = mountWizard({ bridge: readyEverythingBridge() });
    await wizard.open();
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });

    expect(primaryButton().className).toContain("bg-primary text-primary-foreground");
    const tick = setupRow("ai").querySelector<HTMLElement>('[data-setup-disc="ready"]');
    expect(tick?.className).toContain("text-ok");
    const pending = setupRow("injury-status").querySelector('[data-setup-disc="pending"]');
    expect(pending).not.toBeNull();
    wizard.controller.dispose();
  });

  it("renders every setup row in order and adds no row for an injury answer", async () => {
    const user = userEvent.setup();
    const wizard = mountWizard({ bridge: coldBridge() });
    await wizard.open();

    expect(rowIds()).toEqual(["ai", "training", "telegram", "injury-status"]);

    await selectSetupOption(user, "onboarding-injury-status", "returning");

    expect(rowIds()).toEqual(["ai", "training", "telegram", "injury-status"]);
    expect(setupRow("injury-status").parentElement).toBe(setupCard());
    expect(document.querySelector('[data-setup-row="clinician-cleared"]')).toBeNull();

    await selectSetupOption(user, "onboarding-injury-status", "none");

    expect(rowIds()).toEqual(["ai", "training", "telegram", "injury-status"]);
    wizard.controller.dispose();
  });

  it("includes the optional Telegram connection in the gate", async () => {
    setTelegramSettings(
      readyTelegramSettings({
        channel: { desiredState: "enabled", state: "online" },
        bot: { state: "ready", username: "desktop_coach_bot" },
        pairing: { state: "unpaired" },
        credentialConfigured: true,
        gapWarning: { state: "clear" },
      }),
    );
    const wizard = mountWizard({ bridge: coldBridge() });
    await wizard.open();

    expect(rowIds()).toEqual(["ai", "training", "telegram", "injury-status"]);
    expect(setupRow("telegram")).toHaveTextContent("Telegram");
    expect(setupRow("telegram")).toHaveTextContent("Optional");
    expect(screen.getByRole("button", { name: "Delete the Telegram connection" })).toBeVisible();
    wizard.controller.dispose();
  });

  it("gives the gate a single level-one heading", async () => {
    const gate = mountWizard({ bridge: coldBridge() });
    await gate.open();

    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveAttribute("id", "setup-panel-title");
    expect(headings[0]).toHaveClass("outline-none");

    gate.controller.dispose();
    gate.rendered.unmount();
    resetOnboardingStore();

    const settings = mountWizard({ bridge: coldBridge(), placement: "settings" });
    await settings.open();

    expect(screen.queryAllByRole("heading", { level: 1 })).toHaveLength(0);
    expect(screen.getByRole("heading", { level: 2, name: "Setup" })).toHaveAttribute(
      "id",
      "setup-panel-title",
    );
    settings.controller.dispose();
  });

  it("describes the intake questions without promising unsupported coaching behavior", async () => {
    const wizard = mountWizard({ bridge: coldBridge() });
    await wizard.open();

    expect(rowSubtitle("injury-status")).toBe("Records your current injury or return context.");
    wizard.controller.dispose();
  });

  it("marks a detected keyless lane ready and offers to change it without asking for a key", async () => {
    const wizard = mountWizard({ bridge: claudeReadyBridge() });
    await wizard.open();
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });

    const row = setupRow("ai");
    expect(row.querySelector('[data-setup-disc="ready"]')).not.toBeNull();
    expect(row.querySelector('[data-setup-disc="pending"]')).toBeNull();
    expect(row.contains(trigger("ai"))).toBe(true);
    expect(trigger("ai").textContent).toBe("Change");
    expect(trigger("ai")).toBeEnabled();
    expect(document.querySelector("input[data-slot]")).toBeNull();
    expect(panel("api-key")).toBeNull();
    expect(panel("chatgpt")).toBeNull();
    wizard.controller.dispose();
  });

  it("keeps Claude unprobed while unrelated setup remains incomplete", async () => {
    const bridge = claudeSignedOutBridge();
    const wizard = mountWizard({ bridge });
    await wizard.open();

    expect(wizard.controller.state().claudeCliState).toBeNull();
    expect(bridge.claudeCliStatus).not.toHaveBeenCalled();
    expect(bridge.claudeCliRecheck).not.toHaveBeenCalled();
    expect(rowState("ai")).toBe("pending");
    expect(setupRow("ai").querySelector('[data-setup-disc="pending"]')).not.toBeNull();
    expect(setupRow("ai").textContent).toContain("AI that powers your coach");
    expect(rowSubtitle("ai")).toBe("Required — Enduragent doesn't include one");
    expect(trigger("ai").textContent).toBe("Choose");
    expect(primaryButton()).toBeDisabled();
    wizard.controller.dispose();
  });

  it("offers Claude before probing and keeps it available after a signed-out result", async () => {
    const user = userEvent.setup();
    const bridge = claudeSignedOutBridge();
    const wizard = mountWizard({ bridge });
    await wizard.open();

    await openLaneMenu(user);

    expect(bridge.claudeCliStatus).not.toHaveBeenCalled();
    expect(laneItems().map((item) => item.dataset.lane)).toEqual([
      "claude-cli",
      "openai-codex",
      "api-key",
    ]);
    for (const item of laneItems()) {
      expect(item.getAttribute("aria-disabled")).not.toBe("true");
      expect(item.hasAttribute("disabled")).toBe(false);
      expect(item.hasAttribute("data-disabled")).toBe(false);
    }

    const claudeLane = within(laneMenu() as HTMLElement).getByRole("menuitemradio", {
      name: /Claude Code/u,
    });
    await user.click(claudeLane);
    await waitFor(() => {
      expect(bridge.claudeCliStatus).toHaveBeenCalledOnce();
      expect(wizard.controller.state().claudeCliState).toBe("not-logged-in");
    });

    await openLaneMenu(user);
    expect(document.querySelector('[data-lane="claude-cli"]')).not.toBeNull();
    expect(claudeCliNoteText()).toContain("Claude Code CLI is not signed in.");
    wizard.controller.dispose();
  });

  it("restores the previous lane when the API-key panel is backed out of", async () => {
    const user = userEvent.setup();
    const bridge = claudeReadyBridge();
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });

    await chooseLane(user, "api-key");

    await waitFor(() => {
      expect(panel("api-key")).not.toBeNull();
    });
    expect(rowState("ai")).toBe("pending");
    expect(buttonNames(panel("api-key"))).toEqual(["Cancel", "Save"]);

    await user.click(
      within(panel("api-key") as HTMLElement).getByRole("button", { name: "Cancel API key setup" }),
    );

    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });
    expect(panel("api-key")).toBeNull();
    expect(rowSubtitle("ai")).toBe(
      "Powers your coach · Signed in as athlete@example.test - Claude Max subscription",
    );
    expect(trigger("ai").textContent).toBe("Change");
    expect(bridge.writeCredential).not.toHaveBeenCalled();
    wizard.controller.dispose();
  });

  it("restores the complete provider draft when API-key editing is cancelled", async () => {
    const user = userEvent.setup();
    const bridge = coldBridge();
    bridge.llmConfiguration.mockResolvedValue({
      ...TEST_LLM_CONFIGURATION,
      active: { provider: "openrouter", model: "saved/custom-model" },
    });
    bridge.credentialStatuses.mockResolvedValue([
      { slot: "openrouter", state: "configured", runtimeState: "active" },
    ]);
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });
    await openApiKeyPanel(user);

    expect(control("onboarding-llm-provider")).toHaveTextContent("OpenRouter");
    expect(control("onboarding-llm-model")).toHaveTextContent("Other model…");
    expect(control<HTMLInputElement>("onboarding-custom-model").value).toBe("saved/custom-model");
    expect(control("onboarding-endpoint-mode")).toHaveTextContent(
      "Keep current, or use provider default",
    );

    await selectSetupOption(user, "onboarding-llm-model", "deepseek/deepseek-v4-flash");
    await selectSetupOption(user, "onboarding-endpoint-mode", "custom");
    await user.type(
      control<HTMLInputElement>("onboarding-custom-endpoint"),
      "https://changed.example.test/v1",
    );
    await selectSetupOption(user, "onboarding-llm-provider", "anthropic");

    await user.click(
      within(panel("api-key") as HTMLElement).getByRole("button", { name: "Cancel API key setup" }),
    );
    await waitFor(() => {
      expect(panel("api-key")).toBeNull();
    });
    await openApiKeyPanel(user);

    expect(control("onboarding-llm-provider")).toHaveTextContent("OpenRouter");
    expect(control("onboarding-llm-model")).toHaveTextContent("Other model…");
    expect(control<HTMLInputElement>("onboarding-custom-model").value).toBe("saved/custom-model");
    expect(control("onboarding-endpoint-mode")).toHaveTextContent(
      "Keep current, or use provider default",
    );
    expect(document.querySelector("#onboarding-custom-endpoint")).toBeNull();
    wizard.controller.dispose();
  });

  it("uses a successful API-key save as the next cancellation baseline", async () => {
    const user = userEvent.setup();
    const bridge = readyEverythingBridge();
    bridge.credentialStatuses.mockResolvedValue([
      { slot: "anthropic", state: "configured", runtimeState: "active" },
      { slot: "intervals-icu", state: "configured", runtimeState: "active" },
    ]);
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });
    await openApiKeyPanel(user);
    seedSecret("anthropic", randomUUID());
    await user.click(
      within(panel("api-key") as HTMLElement).getByRole("button", { name: "Save API key" }),
    );
    await waitFor(() => {
      expect(panel("api-key")).toBeNull();
    });

    await openApiKeyPanel(user);
    await user.click(
      within(panel("api-key") as HTMLElement).getByRole("button", { name: "Cancel API key setup" }),
    );
    await waitFor(() => {
      expect(panel("api-key")).toBeNull();
    });
    await openApiKeyPanel(user);

    expect(control("onboarding-llm-provider")).toHaveTextContent("Anthropic");
    wizard.controller.dispose();
  });

  it("uses a successful ChatGPT login as the next cancellation baseline", async () => {
    const user = userEvent.setup();
    const bridge = claudeReadyBridge();
    bridge.chatGptStatus
      .mockResolvedValueOnce({ state: "absent", runtimeReady: false })
      .mockResolvedValue({ state: "configured", runtimeReady: true });
    bridge.chatGptLogin.mockImplementation(async ({ operationId }) => ({
      status: "stored",
      operationId,
    }));
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });
    await chooseLane(user, "openai-codex");
    await user.click(screen.getByRole("button", { name: "Sign in with ChatGPT" }));
    await waitFor(() => {
      expect(panel("chatgpt")).toBeNull();
    });

    await openApiKeyPanel(user);
    await user.click(
      within(panel("api-key") as HTMLElement).getByRole("button", { name: "Cancel API key setup" }),
    );
    await waitFor(() => {
      expect(panel("api-key")).toBeNull();
    });

    expect(rowState("ai")).toBe("ready");
    expect(rowSubtitle("ai")).toBe("Connected · powers your coach");
    wizard.controller.dispose();
  });

  it("puts Cancel first and closes first-time Intervals setup without reading a key", async () => {
    const user = userEvent.setup();
    const bridge = coldBridge();
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await openTrainingPanel(user);

    expect(panel("training")?.querySelector("input")).toBeNull();
    expect(buttonNames(panel("training"))).toEqual([
      "Cancel",
      "Use copied API key",
      "Import ride files instead",
    ]);

    await user.click(
      within(panel("training") as HTMLElement).getByRole("button", {
        name: "Cancel Intervals.icu setup",
      }),
    );

    await waitFor(() => {
      expect(panel("training")).toBeNull();
    });
    expect(bridge.writeCredential).not.toHaveBeenCalled();
    expect(bridge.pasteIntervalsApiKeyFromClipboard).not.toHaveBeenCalled();
    expect(rowState("training")).toBe("pending");
    expect(trigger("training").textContent).toBe("Connect");
    expect(trigger("training")).toHaveFocus();
    wizard.controller.dispose();
  });

  it("uses a copied Intervals API key, closes the panel, and focuses Delete", async () => {
    const user = userEvent.setup();
    const bridge = coldBridge();
    bindCredentialPort();
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await openTrainingPanel(user);

    await user.click(
      within(panel("training") as HTMLElement).getByRole("button", {
        name: "Use copied API key",
      }),
    );

    await waitFor(() => {
      expect(rowState("training")).toBe("ready");
    });
    await waitFor(() => {
      expect(panel("training")).toBeNull();
    });
    const remove = screen.getByRole("button", { name: "Delete the Intervals.icu connection" });
    expect(remove).toHaveTextContent("Delete");
    expect(remove).toHaveFocus();
    expect(bridge.pasteIntervalsApiKeyFromClipboard).toHaveBeenCalledOnce();
    expect(bridge.writeCredential).not.toHaveBeenCalled();
    wizard.controller.dispose();
  });

  it("keeps first-time Intervals setup open when the AI row finishes saving", async () => {
    const user = userEvent.setup();
    const bridge = claudeReadyBridge();
    bridge.credentialStatuses.mockResolvedValue([
      { slot: "anthropic", state: "configured", runtimeState: "active" },
    ]);
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });
    await openApiKeyPanel(user);
    await openTrainingPanel(user);
    seedSecret("anthropic", randomUUID());

    await user.click(
      within(panel("api-key") as HTMLElement).getByRole("button", { name: "Save API key" }),
    );

    await waitFor(() => {
      expect(panel("api-key")).toBeNull();
    });
    expect(panel("training")).not.toBeNull();
    expect(panel("training")?.querySelector("input")).toBeNull();
    expect(screen.getByRole("button", { name: "Use copied API key" })).toBeInTheDocument();
    expect(bridge.pasteIntervalsApiKeyFromClipboard).not.toHaveBeenCalled();
    wizard.controller.dispose();
  });

  it("keeps an open AI draft when copied Intervals setup finishes", async () => {
    const user = userEvent.setup();
    const bridge = coldBridge();
    bridge.llmConfiguration.mockResolvedValue({
      ...TEST_LLM_CONFIGURATION,
      active: { provider: "anthropic", model: "claude-sonnet-4-6" },
    });
    bridge.credentialStatuses.mockResolvedValue([
      { slot: "anthropic", state: "configured", runtimeState: "active" },
    ]);
    bindCredentialPort();
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });
    await openApiKeyPanel(user);
    await openTrainingPanel(user);
    const aiSecret = randomUUID();
    seedSecret("anthropic", aiSecret);

    await user.click(
      within(panel("training") as HTMLElement).getByRole("button", {
        name: "Use copied API key",
      }),
    );

    await waitFor(() => {
      expect(panel("training")).toBeNull();
    });
    expect(panel("api-key")).not.toBeNull();
    expect(passwordInput("anthropic").value).toBe(aiSecret);
    expect(
      screen.getByRole("button", { name: "Delete the Intervals.icu connection" }),
    ).toHaveFocus();
    expect(bridge.pasteIntervalsApiKeyFromClipboard).toHaveBeenCalledOnce();
    wizard.controller.dispose();
  });

  it("keeps the footer privacy note visible while Start coaching is blocked", async () => {
    const user = userEvent.setup();
    const wizard = mountWizard({ bridge: readyEverythingBridge() });
    await wizard.open();
    await waitFor(() => {
      expect(rowState("training")).toBe("ready");
    });

    expect(primaryButton()).toBeDisabled();
    expect(screen.getByText(FOOTER_NOTE).className).toContain("ml-auto");
    expect(document.querySelector("[data-setup-outstanding]")).toBeNull();

    await selectSetupOption(user, "onboarding-injury-status", "returning");

    await waitFor(() => {
      expect(primaryButton()).toBeEnabled();
    });
    expect(screen.getByText(FOOTER_NOTE)).toBeInTheDocument();
    wizard.controller.dispose();
  });

  it("keeps durable training ready while showing the exact first-time Intervals row", async () => {
    const missingBridge = claudeReadyBridge();
    missingBridge.getSetupStatus = vi.fn(async () => ({
      schemaVersion: 1 as const,
      intake: null,
      durableTrainingData: true,
    }));
    const missing = mountWizard({ bridge: missingBridge });
    await missing.open();
    expect(rowSubtitle("training")).toBe("Required · where your rides come from");
    expect(trigger("training").textContent).toBe("Connect");
    expect(rowState("training")).toBe("pending");
    expect(useEnduragentStore.getState().onboarding.readiness.trainingData).toBe(true);
    expect(document.querySelector("[data-setup-readiness]")).toHaveTextContent(
      "2 of 3 required ready",
    );
    missing.controller.dispose();
    missing.rendered.unmount();
    resetOnboardingStore();

    bindCredentialPort();
    const connected = mountWizard({ bridge: readyEverythingBridge() });
    await connected.open();
    await waitFor(() => {
      expect(useEnduragentStore.getState().onboarding.readiness.trainingData).toBe(true);
    });
    expect(rowState("training")).toBe("ready");
    expect(rowSubtitle("training")).toBe("Connected · where your rides come from");
    expect(document.querySelector('[data-setup-trigger="training"]')).toBeNull();
    expect(
      screen.getByRole("button", { name: "Delete the Intervals.icu connection" }),
    ).toHaveTextContent("Delete");
    connected.controller.dispose();
  });

  it("keeps the first-time Intervals row after a ride import makes training ready", async () => {
    const bridge = coldBridge();
    bridge.importFiles.mockResolvedValue(importResult({ total: 1, imported: 1, quarantined: 0 }));
    const wizard = mountWizard({ bridge });
    await wizard.open();
    expect(rowState("training")).toBe("pending");

    act(() => {
      wizard.controller.importDroppedFiles(["/synthetic/ride.fit"]);
    });

    await waitFor(() => {
      expect(useEnduragentStore.getState().onboarding.readiness.trainingData).toBe(true);
    });
    expect(rowState("training")).toBe("pending");
    expect(rowSubtitle("training")).toBe("Required · where your rides come from");
    expect(trigger("training").textContent).toBe("Connect");
    wizard.controller.dispose();
  });

  it("labels the demoted custom model and endpoint fields", async () => {
    const user = userEvent.setup();
    const wizard = mountWizard({ bridge: coldBridge() });
    await wizard.open();
    await openApiKeyPanel(user);
    await selectSetupOption(user, "onboarding-llm-provider", "openrouter");
    await selectSetupOption(user, "onboarding-llm-model", "__custom__");
    await selectSetupOption(user, "onboarding-endpoint-mode", "custom");

    expect(screen.getByLabelText("Custom model name")).toBe(control("onboarding-custom-model"));
    expect(screen.getByLabelText("Endpoint")).toBe(control("onboarding-endpoint-mode"));
    expect(screen.getByLabelText("Custom endpoint")).toBe(control("onboarding-custom-endpoint"));
    expect(screen.getByLabelText("OpenRouter API key")).toBe(passwordInput("openrouter"));
    wizard.controller.dispose();
  });

  it("rechecks Claude only from the explicit recoverable menu action", async () => {
    const user = userEvent.setup();
    const bridge = claudeReadyBridge();
    bridge.llmConfiguration.mockResolvedValue({ ...CLAUDE_CONFIGURATION, active: null });
    bridge.claudeCliStatus.mockResolvedValue({ state: "not-logged-in" });
    bridge.claudeCliRecheck.mockResolvedValue({ state: "not-logged-in" });
    const wizard = mountWizard({ bridge });
    await wizard.open();

    expect(bridge.claudeCliStatus).not.toHaveBeenCalled();
    expect(bridge.claudeCliRecheck).not.toHaveBeenCalled();

    await chooseLane(user, "claude-cli");
    await waitFor(() => {
      expect(bridge.claudeCliStatus).toHaveBeenCalledOnce();
      expect(wizard.controller.state().claudeCliState).toBe("not-logged-in");
    });

    await openLaneMenu(user);
    expect(claudeCliNoteText()).toContain("Claude Code CLI is not signed in.");
    await user.click(screen.getByRole("menuitem", { name: "Check again" }));

    await waitFor(() => {
      expect(bridge.claudeCliRecheck).toHaveBeenCalledOnce();
    });
    expect(bridge.claudeCliStatus).toHaveBeenCalledOnce();
    expect(wizard.controller.state().claudeCliState).toBe("not-logged-in");
    wizard.controller.dispose();
  });
});

function errorAnnouncer(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".onboarding-error-announcer");
}

function rowAnnouncer(id: string): HTMLElement | null {
  return setupRow(id).querySelector<HTMLElement>(`[data-setup-announce="${id}"]`);
}

describe("setup card accessibility", () => {
  afterEach(() => {
    resetOnboardingStore();
  });

  it("announces clipboard guidance when the copied Intervals API key has an invalid format", async () => {
    const user = userEvent.setup();
    const bridge = coldBridge();
    bridge.pasteIntervalsApiKeyFromClipboard.mockResolvedValue({
      outcome: "refused",
      reason: "invalid-key-format",
      current: { slot: "intervals-icu", state: "missing", runtimeState: null },
    });
    const wizard = mountWizard({ bridge });
    await wizard.open();

    await openTrainingPanel(user);
    await user.click(
      within(panel("training") as HTMLElement).getByRole("button", {
        name: "Use copied API key",
      }),
    );

    await waitFor(() => {
      expect(wizard.controller.state().fixedError).toBe("intervals-clipboard-unavailable");
    });
    expect(errorAnnouncer()?.textContent).toBe(
      "Enduragent couldn’t read an API key from the clipboard. Copy it in Intervals.icu, then try again.",
    );
    wizard.controller.dispose();
  });

  it("announces errors through a region that is mounted before the error exists", async () => {
    const user = userEvent.setup();
    const bridge = coldBridge();
    bridge.pasteIntervalsApiKeyFromClipboard.mockResolvedValue({
      outcome: "refused",
      reason: "credential-rejected",
      current: { slot: "intervals-icu", state: "missing", runtimeState: null },
    });
    const wizard = mountWizard({ bridge });
    await wizard.open();

    const announcer = errorAnnouncer();
    expect(announcer).not.toBeNull();
    expect(announcer?.getAttribute("aria-live")).toBe("polite");
    expect(announcer?.textContent).toBe("");

    await openTrainingPanel(user);
    await user.click(
      within(panel("training") as HTMLElement).getByRole("button", {
        name: "Use copied API key",
      }),
    );

    await waitFor(() => {
      expect(wizard.controller.state().fixedError).toBe("intervals-key-rejected");
    });
    expect(errorAnnouncer()).toBe(announcer);
    expect(announcer?.textContent).toBe(
      "Intervals.icu didn’t accept the copied API key. Copy a current API key, then try again.",
    );
    expect(document.querySelector("#onboarding-error")?.hasAttribute("aria-live")).toBe(false);
    wizard.controller.dispose();
  });

  it("describes only the controls in the section that owns the error", async () => {
    const user = userEvent.setup();
    const bridge = coldBridge();
    bridge.writeCredential.mockResolvedValue({
      slot: "anthropic",
      status: "refused",
      reason: "invalid-input",
    });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await openApiKeyPanel(user);

    expect(passwordInput("anthropic").hasAttribute("aria-describedby")).toBe(false);
    expect(control("onboarding-injury-status").hasAttribute("aria-describedby")).toBe(false);

    seedSecret("anthropic", randomUUID());
    await user.click(
      within(panel("api-key") as HTMLElement).getByRole("button", { name: "Save API key" }),
    );

    await waitFor(() => {
      expect(wizard.controller.state().fixedError).toBe("invalid-input");
    });
    expect(passwordInput("anthropic").getAttribute("aria-describedby")).toBe("onboarding-error");
    expect(control("onboarding-injury-status").hasAttribute("aria-describedby")).toBe(false);
    wizard.controller.dispose();
  });

  it("returns focus to the row trigger when a sub-panel is backed out of", async () => {
    const user = userEvent.setup();
    const wizard = mountWizard({ bridge: coldBridge() });
    await wizard.open();

    await openTrainingPanel(user);
    await user.click(
      within(panel("training") as HTMLElement).getByRole("button", {
        name: "Cancel Intervals.icu setup",
      }),
    );
    await waitFor(() => {
      expect(panel("training")).toBeNull();
    });
    expect(document.activeElement).toBe(trigger("training"));

    await openApiKeyPanel(user);
    await user.click(
      within(panel("api-key") as HTMLElement).getByRole("button", { name: "Cancel API key setup" }),
    );
    await waitFor(() => {
      expect(panel("api-key")).toBeNull();
    });
    expect(document.activeElement).toBe(trigger("ai"));
    wizard.controller.dispose();
  });

  it("exposes the intervals.icu disclosure state on its trigger", async () => {
    const user = userEvent.setup();
    const wizard = mountWizard({ bridge: coldBridge() });
    await wizard.open();

    expect(trigger("training").getAttribute("aria-expanded")).toBe("false");
    expect(trigger("training").hasAttribute("aria-controls")).toBe(false);

    await openTrainingPanel(user);

    const host = panel("training") as HTMLElement;
    expect(trigger("training").getAttribute("aria-expanded")).toBe("true");
    expect(host.id).not.toBe("");
    expect(trigger("training").getAttribute("aria-controls")).toBe(host.id);
    wizard.controller.dispose();
  });

  it("announces the sub-panel a lane choice reveals", async () => {
    const user = userEvent.setup();
    const wizard = mountWizard({ bridge: coldBridge() });
    await wizard.open();

    const announcer = rowAnnouncer("ai");
    expect(announcer).not.toBeNull();
    expect(announcer?.getAttribute("aria-live")).toBe("polite");
    expect(announcer?.textContent).toBe("");

    await openApiKeyPanel(user);

    expect(rowAnnouncer("ai")).toBe(announcer);
    expect(announcer?.textContent).toBe("API key setup opened below this row.");

    await chooseLane(user, "openai-codex");

    await waitFor(() => {
      expect(panel("chatgpt")).not.toBeNull();
    });
    expect(rowAnnouncer("ai")).toBe(announcer);
    expect(announcer?.textContent).toBe("ChatGPT sign-in opened below this row.");
    wizard.controller.dispose();
  });

  it("gives co-visible controls distinct accessible names", async () => {
    const user = userEvent.setup();
    const wizard = mountWizard({ bridge: claudeReadyBridge() });
    await wizard.open();
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });
    await openApiKeyPanel(user);
    await openTrainingPanel(user);

    expect(screen.queryAllByRole("button", { name: "Change" })).toHaveLength(0);
    expect(screen.queryAllByRole("button", { name: "Save" })).toHaveLength(0);
    expect(screen.queryAllByRole("button", { name: "Cancel" })).toHaveLength(0);
    for (const name of [
      "Change what powers your coach",
      "Connect Intervals.icu",
      "Cancel API key setup",
      "Save API key",
      "Cancel Intervals.icu setup",
      "Use copied API key",
      "Import ride files instead",
    ]) {
      expect(screen.getAllByRole("button", { name })).toHaveLength(1);
    }
    wizard.controller.dispose();
  });

  it("uses stronger compact copy and semantic control edges", async () => {
    const user = userEvent.setup();
    const wizard = mountWizard({ bridge: coldBridge() });
    await wizard.open();

    const compactCopy = [
      setupRow("ai").querySelector("[data-setup-row-title]")?.nextElementSibling,
      screen.getByText(FOOTER_NOTE),
      document.querySelector("[data-info-tip]"),
    ];
    for (const element of compactCopy) {
      expect(element?.className).toContain("text-ink-2");
      expect(element?.className).not.toContain("text-ink-3");
    }
    for (const element of [trigger("ai"), trigger("training")]) {
      expect(element.className).toContain("border-input");
      expect(element.className).not.toContain("border-line-2");
    }
    expect(control("onboarding-injury-status").className).toContain("border-input");
    expect(control("onboarding-injury-status").className).not.toContain("border-line-2");

    await openLaneMenu(user);
    expect(within(laneMenu() as HTMLElement).getByText(SETUP_MENU_LABEL).className).toContain(
      "text-ink-2",
    );
    for (const hint of document.querySelectorAll<HTMLElement>("[data-lane] i")) {
      expect(hint.className).toContain("text-ink-2");
    }
    await user.click(document.querySelector<HTMLElement>('[data-lane="api-key"]') as HTMLElement);
    await waitFor(() => {
      expect(panel("api-key")).not.toBeNull();
    });
    expect(screen.getByText(API_KEY_PANEL_HINT).className).toContain("text-ink-2");
    expect(control("onboarding-llm-provider").className).toContain("border-input");
    wizard.controller.dispose();
  });
});
