import { randomUUID } from "node:crypto";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OnboardingBridge } from "../src/onboarding/bridge";
import {
  chooseLane,
  mountWizard,
  openApiKeyPanel,
  panel,
  resetOnboardingStore,
  rowState,
  rowSubtitle,
  selectSetupOption,
  seedSecret,
  setupCard,
  testBridge,
  type TestBridge,
} from "./onboarding-harness";

function expectOnePoweringRow(subtitle: string): void {
  expect(rowState("ai")).toBe("ready");
  expect(rowSubtitle("ai")).toBe(subtitle);
  const claiming = Array.from(setupCard().querySelectorAll("[data-setup-row]")).filter((row) =>
    (row.textContent ?? "").toLowerCase().includes("powers your coach"),
  );
  expect(claiming).toHaveLength(1);
}

function twoProviderBridge(overrides: Partial<OnboardingBridge>): TestBridge {
  const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
  bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
  bridge.llmConfiguration.mockResolvedValue({
    schemaVersion: 1,
    catalogRevision: 7,
    providers: [
      {
        provider: "anthropic",
        defaultModel: "claude-sonnet-4-6",
        models: [{ value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" }],
      },
      {
        provider: "openai-codex",
        defaultModel: "gpt-5.5",
        models: [{ value: "gpt-5.5", label: "GPT-5.5" }],
      },
    ],
    active: { provider: "anthropic", model: "claude-sonnet-4-6" },
  });
  return Object.assign(bridge, overrides);
}

describe("onboarding provider status", () => {
  afterEach(() => {
    resetOnboardingStore();
  });

  it("shows only ChatGPT as powering the coach after sign-in supersedes an API key", async () => {
    const user = userEvent.setup();
    let selectedProvider: "anthropic" | "chatgpt" = "anthropic";
    const credentialStatuses = vi.fn(async () => [
      {
        slot: "anthropic" as const,
        state: "configured" as const,
        runtimeState:
          selectedProvider === "anthropic" ? ("active" as const) : ("stored-inactive" as const),
      },
    ]);
    const chatGptStatus = vi.fn(async () => ({
      state: selectedProvider === "chatgpt" ? ("configured" as const) : ("absent" as const),
      runtimeReady: selectedProvider === "chatgpt",
    }));
    const chatGptLogin = vi.fn(async ({ operationId }: { operationId: string }) => {
      selectedProvider = "chatgpt";
      return { status: "stored" as const, operationId };
    });
    const bridge = twoProviderBridge({ credentialStatuses, chatGptStatus, chatGptLogin });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    expectOnePoweringRow("Connected · powers your coach");

    await chooseLane(user, "openai-codex");
    expect(rowState("ai")).toBe("pending");
    await user.click(screen.getByRole("button", { name: "Sign in with ChatGPT" }));

    expect(credentialStatuses).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });
    expectOnePoweringRow("Connected · powers your coach");
    expect(panel("chatgpt")).toBeNull();
    expect(document.body.textContent).not.toContain("Retry saved keys");
    expect(chatGptStatus).toHaveBeenCalledTimes(1);
    wizard.controller.dispose();
  });

  it("shows the API-key provider as powering the coach after a key save", async () => {
    const user = userEvent.setup();
    let selectedProvider: "anthropic" | "chatgpt" = "chatgpt";
    const credentialStatuses = vi.fn(async () =>
      selectedProvider === "anthropic"
        ? [
            {
              slot: "anthropic" as const,
              state: "configured" as const,
              runtimeState: "active" as const,
            },
          ]
        : [],
    );
    const chatGptStatus = vi.fn(async () => ({
      state: "configured" as const,
      runtimeReady: selectedProvider === "chatgpt",
    }));
    const writeCredential = vi.fn(async () => {
      selectedProvider = "anthropic";
      return {
        slot: "anthropic" as const,
        status: "configured" as const,
        runtimeReady: true as const,
      };
    });
    const bridge = twoProviderBridge({ credentialStatuses, chatGptStatus, writeCredential });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await openApiKeyPanel(user);
    await selectSetupOption(user, "onboarding-llm-provider", "anthropic");
    seedSecret("anthropic", randomUUID());

    const host = panel("api-key");
    await user.click(within(host as HTMLElement).getByRole("button", { name: "Save API key" }));

    await waitFor(() => {
      expect(credentialStatuses).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });
    expectOnePoweringRow("Connected · powers your coach");
    expect(writeCredential).toHaveBeenCalledOnce();
    wizard.controller.dispose();
  });

  it("shows the selected API-key provider as powering the coach after Save succeeds", async () => {
    const user = userEvent.setup();
    let selectedProvider: "anthropic" | "chatgpt" = "chatgpt";
    const credentialStatuses = vi.fn(async () => [
      {
        slot: "anthropic" as const,
        state: "configured" as const,
        runtimeState: selectedProvider === "anthropic" ? ("active" as const) : ("failed" as const),
      },
    ]);
    const chatGptStatus = vi.fn(async () => ({
      state: "configured" as const,
      runtimeReady: selectedProvider === "chatgpt",
    }));
    const applyLlmSelection = vi.fn(async () => {
      selectedProvider = "anthropic";
      return { status: "configured" as const, runtimeReady: true as const };
    });
    const bridge = twoProviderBridge({ credentialStatuses, chatGptStatus, applyLlmSelection });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await openApiKeyPanel(user);
    await selectSetupOption(user, "onboarding-llm-provider", "anthropic");

    const host = panel("api-key");
    await user.click(within(host as HTMLElement).getByRole("button", { name: "Save API key" }));

    await waitFor(() => {
      expect(applyLlmSelection).toHaveBeenCalledOnce();
      expect(chatGptStatus).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });
    expectOnePoweringRow("Connected · powers your coach");
    wizard.controller.dispose();
  });

  it("preserves ChatGPT activity when an unrelated post-selection status is unavailable", async () => {
    const user = userEvent.setup();
    let selectedProvider: "anthropic" | "chatgpt" = "chatgpt";
    const chatGptStatus = vi
      .fn<OnboardingBridge["chatGptStatus"]>()
      .mockResolvedValueOnce({ state: "configured", runtimeReady: true })
      .mockRejectedValueOnce(new Error("private status failure"));
    const credentialStatuses = vi.fn(async () => [
      {
        slot: "anthropic" as const,
        state: "configured" as const,
        runtimeState: selectedProvider === "anthropic" ? ("active" as const) : ("failed" as const),
      },
    ]);
    const applyLlmSelection = vi.fn(async () => {
      selectedProvider = "anthropic";
      return { status: "configured" as const, runtimeReady: true as const };
    });
    const bridge = twoProviderBridge({ credentialStatuses, chatGptStatus, applyLlmSelection });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await openApiKeyPanel(user);
    await selectSetupOption(user, "onboarding-llm-provider", "anthropic");

    const host = panel("api-key");
    await user.click(within(host as HTMLElement).getByRole("button", { name: "Save API key" }));

    await waitFor(() => {
      expect(applyLlmSelection).toHaveBeenCalledOnce();
      expect(chatGptStatus).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });
    expect(wizard.controller.state().chatGptRuntimeState).toBe("ready");
    expect(document.body.textContent).not.toContain("private status failure");
    wizard.controller.dispose();
  });

  it("does not run a post-sign-in refresh that could overwrite the completed sign-in", async () => {
    const user = userEvent.setup();
    const credentialStatuses = vi
      .fn<OnboardingBridge["credentialStatuses"]>()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new TypeError());
    const chatGptLogin = vi.fn(async ({ operationId }: { operationId: string }) => ({
      status: "stored" as const,
      operationId,
    }));
    const chatGptStatus = vi
      .fn<OnboardingBridge["chatGptStatus"]>()
      .mockResolvedValueOnce({ state: "absent", runtimeReady: false })
      .mockResolvedValueOnce({ state: "configured", runtimeReady: true });
    const bridge = twoProviderBridge({ credentialStatuses, chatGptLogin, chatGptStatus });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await chooseLane(user, "openai-codex");

    await user.click(screen.getByRole("button", { name: "Sign in with ChatGPT" }));

    expect(credentialStatuses).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(rowState("ai")).toBe("ready");
    });
    expect(document.body.textContent).not.toContain(
      "ChatGPT sign-in could not be completed. Please retry.",
    );
    expect(chatGptStatus).toHaveBeenCalledTimes(1);
    wizard.controller.dispose();
  });
});
