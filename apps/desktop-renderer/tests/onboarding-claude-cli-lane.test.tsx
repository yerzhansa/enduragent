import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { OnboardingBridge, OnboardingLlmConfiguration } from "../src/onboarding/bridge";
import type { ClaudeCliState } from "../src/onboarding/constants";
import { claudeCliPresentation } from "../src/onboarding/credential-presentation";
import type { ClaudeCliStatus } from "../src/onboarding/machine";
import { useEnduragentStore } from "../src/state/store";
import {
  chooseLane,
  claudeCliNoteText,
  control,
  mountWizard,
  openApiKeyPanel,
  openLaneMenu,
  resetOnboardingStore,
  rowState,
  rowSubtitle,
  setupRow,
  testBridge,
  type TestBridge,
} from "./onboarding-harness";

const CLAUDE_CLI_CONFIGURATION: OnboardingLlmConfiguration = {
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
  ],
  active: null,
};

const ACTIVE_CLAUDE_CLI_CONFIGURATION: OnboardingLlmConfiguration = {
  ...CLAUDE_CLI_CONFIGURATION,
  active: { provider: "claude-cli", model: "sonnet" },
};

function claudeBridge(status: ClaudeCliStatus, overrides: Partial<OnboardingBridge> = {}) {
  const bridge: TestBridge = testBridge(async () => ({
    status: "refused",
    reason: "cancelled",
  }));
  bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
  bridge.llmConfiguration.mockResolvedValue(CLAUDE_CLI_CONFIGURATION);
  bridge.claudeCliStatus.mockResolvedValue(status);
  bridge.claudeCliRecheck.mockResolvedValue(status);
  return Object.assign(bridge, overrides);
}

async function openLane(bridge: TestBridge): Promise<ReturnType<typeof mountWizard>> {
  const wizard = mountWizard({ bridge });
  await wizard.open();
  expect(bridge.claudeCliStatus).not.toHaveBeenCalled();
  return wizard;
}

async function selectClaudeLane(
  user: ReturnType<typeof userEvent.setup>,
  wizard: ReturnType<typeof mountWizard>,
  bridge: TestBridge,
): Promise<void> {
  await chooseLane(user, "claude-cli");
  await waitFor(() => {
    expect(bridge.claudeCliStatus).toHaveBeenCalledOnce();
    expect(wizard.controller.state().claudeCliState).not.toBeNull();
  });
}

function laneItem(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-lane="claude-cli"]');
}

describe("claude-cli onboarding lane", () => {
  afterEach(() => {
    resetOnboardingStore();
  });

  it("offers Claude before probing, then checks once and activates only after readiness", async () => {
    const user = userEvent.setup();
    let settle: ((status: ClaudeCliStatus) => void) | undefined;
    const bridge = claudeBridge({ state: "ready" });
    bridge.claudeCliStatus.mockReturnValue(
      new Promise<ClaudeCliStatus>((resolve) => {
        settle = resolve;
      }),
    );
    const wizard = mountWizard({ bridge });

    await wizard.open();
    await openLaneMenu(user);

    expect(laneItem()).not.toBeNull();
    expect(bridge.claudeCliStatus).not.toHaveBeenCalled();
    expect(claudeCliNoteText()).toBeNull();

    await user.click(laneItem()!);

    expect(bridge.claudeCliStatus).toHaveBeenCalledOnce();
    expect(bridge.applyLlmSelection).not.toHaveBeenCalled();
    expect(wizard.controller.state().busy).toBe(true);
    expect(rowState("ai")).toBe("pending");
    expect(setupRow("ai").textContent).toMatch(/checking/iu);

    await act(async () => {
      settle?.({ state: "ready", email: "athlete@example.test", plan: "Max" });
    });

    await waitFor(() => expect(bridge.applyLlmSelection).toHaveBeenCalledOnce());
    await waitFor(() => expect(rowState("ai")).toBe("ready"));
    expect(bridge.claudeCliStatus).toHaveBeenCalledOnce();
    wizard.controller.dispose();
  });

  it("restores an active Claude configuration without probing during startup", async () => {
    const bridge = claudeBridge({ state: "ready" });
    bridge.llmConfiguration.mockResolvedValue(ACTIVE_CLAUDE_CLI_CONFIGURATION);
    const wizard = mountWizard({ bridge });

    await wizard.open();

    expect(bridge.claudeCliStatus).not.toHaveBeenCalled();
    expect(useEnduragentStore.getState().onboarding.initialized).toBe(true);
    expect(useEnduragentStore.getState().onboarding.readiness.provider).toBe(true);
    wizard.controller.dispose();
  });

  it("offers the lane and carries the signed-in identity into the row", async () => {
    const user = userEvent.setup();
    const bridge = claudeBridge({
      state: "ready",
      email: "athlete@example.test",
      plan: "Max",
      version: "2.1.0",
    });
    const wizard = await openLane(bridge);

    await selectClaudeLane(user, wizard, bridge);
    await waitFor(() => expect(rowState("ai")).toBe("ready"));

    expect(rowState("ai")).toBe("ready");
    expect(setupRow("ai").textContent).toContain("Claude Code");
    expect(rowSubtitle("ai")).toBe(
      "Powers your coach · Signed in as athlete@example.test - Claude Max subscription",
    );
    expect(document.body.textContent).not.toContain("undefined");
    wizard.controller.dispose();
  });

  it("falls back to the email alone when the probe reports no plan", async () => {
    const user = userEvent.setup();
    const bridge = claudeBridge({ state: "ready", email: "athlete@example.test" });
    const wizard = await openLane(bridge);

    await selectClaudeLane(user, wizard, bridge);
    await waitFor(() => expect(rowState("ai")).toBe("ready"));

    expect(rowSubtitle("ai")).toBe("Powers your coach · Signed in as athlete@example.test");
    expect(document.body.textContent).not.toContain("Claude undefined subscription");
    wizard.controller.dispose();
  });

  it("keeps the plan when the email is unavailable", async () => {
    const user = userEvent.setup();
    const bridge = claudeBridge({ state: "ready", plan: "Pro" });
    const wizard = await openLane(bridge);

    await selectClaudeLane(user, wizard, bridge);
    await waitFor(() => expect(rowState("ai")).toBe("ready"));

    expect(rowSubtitle("ai")).toBe("Powers your coach · Signed in - Claude Pro subscription");
    wizard.controller.dispose();
  });

  it("names API key billing instead of claiming a subscription", async () => {
    const user = userEvent.setup();
    const bridge = claudeBridge({ state: "ready-api-key" });
    const wizard = await openLane(bridge);

    await selectClaudeLane(user, wizard, bridge);
    await waitFor(() => expect(rowState("ai")).toBe("ready"));

    expect(rowSubtitle("ai")).toBe(
      "Powers your coach · Using Anthropic API key billing - usage is charged to your API account.",
    );
    expect(rowSubtitle("ai")).not.toContain("subscription");
    wizard.controller.dispose();
  });

  it.each([
    { state: "not-logged-in" },
    { state: "api-key-token" },
    { state: "absent-binary" },
    { state: "disabled" },
    { state: "working-area-unavailable" },
  ] as const satisfies ReadonlyArray<{ readonly state: ClaudeCliState }>)(
    "keeps the selected lane recoverable and explains $state in place",
    async ({ state }) => {
      const user = userEvent.setup();
      const bridge = claudeBridge({ state });
      const wizard = await openLane(bridge);

      await selectClaudeLane(user, wizard, bridge);

      await openLaneMenu(user);

      expect(laneItem()).not.toBeNull();
      expect(claudeCliNoteText()).toBe(claudeCliPresentation(state).detail);
      if (state === "working-area-unavailable") {
        expect(claudeCliNoteText()).toBe(
          "Enduragent could not prepare Claude's private working area. Restart Enduragent, then choose Check again.",
        );
        expect(claudeCliNoteText()).not.toContain("/Users/");
        expect(claudeCliNoteText()).not.toContain("C:\\");
      }
      expect(document.querySelector('input[data-slot="claude-cli"]')).toBeNull();
      wizard.controller.dispose();
    },
  );

  it("rechecks the account from the menu note and never grows a key field", async () => {
    const user = userEvent.setup();
    const bridge = claudeBridge({ state: "not-logged-in" });
    bridge.claudeCliRecheck.mockResolvedValue({
      state: "ready",
      email: "athlete@example.test",
      plan: "Pro",
    });
    const wizard = await openLane(bridge);
    await selectClaudeLane(user, wizard, bridge);
    await openLaneMenu(user);

    await user.click(screen.getByRole("menuitem", { name: "Check again" }));

    await waitFor(() => {
      expect(bridge.claudeCliRecheck).toHaveBeenCalledOnce();
    });
    await waitFor(() => {
      expect(wizard.controller.state().claudeCliState).toBe("ready");
    });
    await waitFor(() => expect(bridge.applyLlmSelection).toHaveBeenCalledOnce());
    await openLaneMenu(user);
    expect(laneItem()).not.toBeNull();
    expect(claudeCliNoteText()).toBeNull();
    expect(bridge.claudeCliStatus).toHaveBeenCalledOnce();
    expect(document.querySelector('input[data-slot="claude-cli"]')).toBeNull();
    wizard.controller.dispose();
  });

  it("keeps the last known identity when a recheck fails", async () => {
    const user = userEvent.setup();
    const bridge = claudeBridge({ state: "ready", email: "athlete@example.test", plan: "Max" });
    bridge.claudeCliRecheck.mockRejectedValue(new Error("probe unavailable"));
    const wizard = await openLane(bridge);
    await selectClaudeLane(user, wizard, bridge);
    await waitFor(() => expect(rowState("ai")).toBe("ready"));

    act(() => {
      wizard.controller.recheckClaudeCli();
    });

    await waitFor(() => {
      expect(bridge.claudeCliRecheck).toHaveBeenCalledOnce();
    });
    await waitFor(() => {
      expect(wizard.controller.state().busy).toBe(false);
    });
    expect(rowSubtitle("ai")).toBe(
      "Powers your coach · Signed in as athlete@example.test - Claude Max subscription",
    );
    expect(document.body.textContent).not.toContain("probe unavailable");
    wizard.controller.dispose();
  });

  it("restores an active Claude selection without launching a readiness check", async () => {
    const bridge = claudeBridge({ state: "ready", email: "athlete@example.test", plan: "Max" });
    bridge.llmConfiguration.mockResolvedValue(ACTIVE_CLAUDE_CLI_CONFIGURATION);
    const wizard = mountWizard({ bridge });

    await wizard.open();

    await waitFor(() => expect(rowState("ai")).toBe("ready"));
    expect(bridge.claudeCliStatus).not.toHaveBeenCalled();
    expect(wizard.controller.state().claudeCliState).toBeNull();
    expect(bridge.applyLlmSelection).not.toHaveBeenCalled();
    expect(setupRow("ai").textContent).toContain("Claude Code");
    wizard.controller.dispose();
  });

  it("opens generic non-Claude setup without checking Claude", async () => {
    const user = userEvent.setup();
    const bridge = claudeBridge({ state: "ready", email: "athlete@example.test", plan: "Max" });
    const wizard = await openLane(bridge);
    await openApiKeyPanel(user);

    expect(control("onboarding-llm-provider")).toHaveTextContent("Anthropic");
    expect(control("onboarding-llm-model")).toHaveTextContent("Claude Sonnet 4.6");
    expect(bridge.claudeCliStatus).not.toHaveBeenCalled();
    expect(bridge.claudeCliRecheck).not.toHaveBeenCalled();
    wizard.controller.dispose();
  });

  it("marks a probe-ready lane ready without any credential entry", async () => {
    const user = userEvent.setup();
    const ready = claudeBridge({ state: "ready", email: "athlete@example.test", plan: "Max" });
    const wizard = await openLane(ready);

    await selectClaudeLane(user, wizard, ready);

    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });
    expect(ready.writeCredential).not.toHaveBeenCalled();
    expect(document.querySelector('[data-setup-panel="api-key"]')).toBeNull();
    wizard.controller.dispose();
  });

  it("keeps a selected lane listed and pending after it degrades", async () => {
    const user = userEvent.setup();
    const bridge = claudeBridge({ state: "ready", email: "athlete@example.test", plan: "Max" });
    bridge.claudeCliRecheck.mockResolvedValue({ state: "not-logged-in" });
    const wizard = await openLane(bridge);
    await selectClaudeLane(user, wizard, bridge);
    await waitFor(() => expect(rowState("ai")).toBe("ready"));

    act(() => {
      wizard.controller.recheckClaudeCli();
    });

    await waitFor(() => {
      expect(wizard.controller.state().claudeCliState).toBe("not-logged-in");
    });
    expect(rowState("ai")).toBe("pending");
    expect(rowSubtitle("ai")).toBe("Powers your coach · sign in from a terminal to finish");
    await openLaneMenu(user);
    expect(laneItem()).not.toBeNull();
    expect(claudeCliNoteText()).not.toBeNull();
    expect(screen.getByRole("menuitem", { name: "Check again" })).toBeInTheDocument();
    wizard.controller.dispose();
  });

  it("never names the lane when the daemon does not offer the provider", async () => {
    const user = userEvent.setup();
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
    bridge.claudeCliStatus.mockResolvedValue({ state: "ready", plan: "Max" });
    const wizard = mountWizard({ bridge });

    await wizard.open();
    await openLaneMenu(user);

    expect(bridge.claudeCliStatus).not.toHaveBeenCalled();
    expect(laneItem()).toBeNull();
    expect(claudeCliNoteText()).toBeNull();
    expect(document.body.textContent).not.toContain("Claude Code");
    wizard.controller.dispose();
  });

  it("never leaks probe fields other than the rendered identity", async () => {
    const user = userEvent.setup();
    const bridge = claudeBridge({
      state: "ready",
      email: "athlete@example.test",
      plan: "Max",
      version: "2.1.0",
    });
    const wizard = await openLane(bridge);
    await selectClaudeLane(user, wizard, bridge);
    await waitFor(() => expect(rowState("ai")).toBe("ready"));

    const rendered = document.body.textContent ?? "";
    expect(rendered).not.toContain("2.1.0");
    expect(rendered).not.toMatch(/sk-|oauth/iu);
    wizard.controller.dispose();
  });
});
