import { createPhrasebook } from "@enduragent/i18n/messages";
import { act, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenRouterSignInResult } from "../src/onboarding/bridge";
import { deleteDetailMessage } from "../src/settings/credential-delete-copy";
import { useEnduragentStore } from "../src/state/store";
import { SetupPanel } from "../src/ui/onboarding/OnboardingWizard";
import { renderLocalized } from "./language-harness";
import {
  TEST_LLM_CONFIGURATION,
  chooseLane,
  control,
  laneItems,
  mountWizard,
  openLaneMenu,
  panel,
  passwordInput,
  resetOnboardingStore,
  rowState,
  rowSubtitle,
  saveModelKey,
  seedSecret,
  selectSetupOption,
  setupRow,
  testBridge,
  type TestBridge,
  type UserEvent,
} from "./onboarding-harness";

const IDLE_HINT =
  "Opens OpenRouter in your browser. Approve there, and the key it makes stays on this Mac. The approval page calls this app localhost.";
const SIGN_IN = "Sign in with OpenRouter";
const PASTE = "Paste a key instead";
const ACTIVE = { slot: "openrouter", state: "configured", runtimeState: "active" } as const;
const INACTIVE = {
  slot: "openrouter",
  state: "configured",
  runtimeState: "stored-inactive",
} as const;
const PASTED_KEY = `sk-or-v1-${"3".repeat(64)}`;
const STATUS_UNAVAILABLE =
  "That key was saved, but its status could not be refreshed. Check the setup area again.";
const SELECTION = {
  catalogRevision: TEST_LLM_CONFIGURATION.catalogRevision,
  provider: "openrouter",
  model: "deepseek/deepseek-v4-flash",
  endpoint: { mode: "default" },
} as const;

interface Pending {
  readonly promise: Promise<OpenRouterSignInResult>;
  resolve(result: OpenRouterSignInResult): void;
}

function pending(): Pending {
  let resolve!: (result: OpenRouterSignInResult) => void;
  const promise = new Promise<OpenRouterSignInResult>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function bridgeWith(
  options: {
    readonly active?: "openrouter" | null;
    readonly statuses?: readonly (typeof ACTIVE | typeof INACTIVE)[];
  } = {},
): TestBridge {
  const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
  bridge.chatGptStatus.mockResolvedValue({ state: "absent", runtimeReady: false });
  bridge.llmConfiguration.mockResolvedValue({
    ...TEST_LLM_CONFIGURATION,
    active:
      options.active === "openrouter"
        ? { provider: "openrouter", model: "deepseek/deepseek-v4-flash" }
        : null,
  });
  bridge.credentialStatuses.mockResolvedValue(options.statuses ?? []);
  return bridge;
}

function openRouterPanel(): HTMLElement {
  const host = panel("openrouter");
  if (host === null) throw new Error("OpenRouter panel is not open");
  return host;
}

function panelState(): string | null {
  return (
    panel("openrouter")
      ?.querySelector("[data-openrouter-state]")
      ?.getAttribute("data-openrouter-state") ?? null
  );
}

function buttons(): readonly { readonly name: string; readonly disabled: boolean }[] {
  return Array.from(openRouterPanel().querySelectorAll("button"), (button) => ({
    name: button.textContent ?? "",
    disabled: button.disabled,
  }));
}

function rowTitle(): string {
  return setupRow("ai").querySelector("[data-setup-row-title]")?.textContent ?? "";
}

async function click(user: UserEvent, name: string): Promise<void> {
  await user.click(within(openRouterPanel()).getByRole("button", { name }));
}

async function openIdlePanel(user: UserEvent, bridge: TestBridge) {
  const wizard = mountWizard({ bridge });
  await wizard.open();
  await chooseLane(user, "openrouter");
  await waitFor(() => expect(panelState()).toBe("idle"));
  return wizard;
}

describe("OpenRouter sign-in panel", () => {
  afterEach(() => {
    resetOnboardingStore();
  });

  it("offers OpenRouter between ChatGPT and API key and opens the idle panel", async () => {
    const user = userEvent.setup();
    const bridge = bridgeWith();
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await openLaneMenu(user);
    expect(laneItems().map((item) => item.dataset.lane)).toEqual([
      "openai-codex",
      "openrouter",
      "api-key",
    ]);
    const lane = document.querySelector<HTMLElement>('[data-lane="openrouter"]');
    expect(lane).toHaveTextContent("OpenRouter");
    expect(lane).toHaveTextContent("Sign in · pay per use, many models");
    await user.click(lane as HTMLElement);
    await waitFor(() => expect(panelState()).toBe("idle"));

    expect(openRouterPanel()).toHaveTextContent(IDLE_HINT);
    expect(buttons()).toEqual([
      { name: "Cancel", disabled: false },
      { name: SIGN_IN, disabled: false },
      { name: PASTE, disabled: false },
    ]);
    expect(rowTitle()).toBe("OpenRouter");
    expect(rowSubtitle("ai")).toBe("Powers your coach · sign in to finish");
    expect(rowState("ai")).toBe("pending");
    expect(document.querySelector('[data-setup-announce="ai"]')).toHaveTextContent(
      "OpenRouter sign-in opened below this row.",
    );
    expect(document.querySelector('input[data-slot="openrouter"]')).toBeNull();

    await click(user, "Cancel");
    await waitFor(() => expect(panel("openrouter")).toBeNull());
    wizard.controller.dispose();
  });

  it("signs in through the browser and shows OpenRouter as connected with no key pasted", async () => {
    const user = userEvent.setup();
    const bridge = bridgeWith();
    const signIn = pending();
    bridge.openRouterSignIn.mockReturnValueOnce(signIn.promise);
    const wizard = await openIdlePanel(user, bridge);

    await click(user, SIGN_IN);
    await waitFor(() => expect(panelState()).toBe("waiting"));
    expect(bridge.openRouterSignIn).toHaveBeenCalledWith({
      operationId: expect.any(String),
      selection: SELECTION,
    });
    const operationId = bridge.openRouterSignIn.mock.calls[0]?.[0].operationId ?? "";
    expect(openRouterPanel()).toHaveTextContent(
      "Finish in your browser. Enduragent carries on by itself once you approve.",
    );
    expect(buttons()).toEqual([
      { name: "Cancel sign-in", disabled: false },
      { name: "Waiting for browser…", disabled: true },
      { name: "Open the sign-in page again", disabled: false },
      { name: "Enter a code instead", disabled: false },
    ]);
    expect(document.querySelector<HTMLButtonElement>('[data-setup-trigger="ai"]')?.disabled).toBe(
      true,
    );
    await click(user, "Open the sign-in page again");
    expect(bridge.reopenOpenRouterSignIn).toHaveBeenCalledWith(operationId);

    act(() => bridge.emitOpenRouterProgress({ operationId, phase: "completing-sign-in" }));
    await waitFor(() => expect(panelState()).toBe("completing"));
    expect(openRouterPanel()).toHaveTextContent("Approved. Saving the key on this Mac…");
    expect(buttons()).toEqual([{ name: "Completing sign-in…", disabled: true }]);

    bridge.credentialStatuses.mockResolvedValue([ACTIVE]);
    signIn.resolve({ status: "connected", operationId, credit: "paid" });
    await waitFor(() => expect(panel("openrouter")).toBeNull());
    expect(rowTitle()).toBe("OpenRouter");
    expect(rowSubtitle("ai")).toBe("Connected · powers your coach");
    expect(rowState("ai")).toBe("ready");
    expect(bridge.writeCredential).not.toHaveBeenCalled();
    wizard.controller.dispose();
  });

  it("shows an amber row and the add-credits panel for an account that never bought credits", async () => {
    const user = userEvent.setup();
    const bridge = bridgeWith();
    const wizard = await openIdlePanel(user, bridge);
    bridge.credentialStatuses.mockResolvedValue([ACTIVE]);
    bridge.openRouterSignIn.mockImplementationOnce(async ({ operationId }) => ({
      status: "connected",
      operationId,
      credit: "never-paid",
    }));
    await click(user, SIGN_IN);

    await waitFor(() => expect(panelState()).toBe("no-credits"));
    expect(rowState("ai")).toBe("attention");
    expect(rowSubtitle("ai")).toBe("Signed in · add credits on OpenRouter to get replies");
    expect(openRouterPanel()).toHaveTextContent(
      "This OpenRouter account has never bought credits. The coach needs credits to reply, usually cents per conversation.",
    );
    expect(openRouterPanel()).toHaveTextContent(
      "Enduragent checks again when you come back to this window.",
    );
    expect(buttons().map((entry) => entry.name)).toEqual(["Check again", "Add credits"]);
    await click(user, "Add credits");
    expect(bridge.openOpenRouterPage).toHaveBeenCalledWith("credits");

    bridge.openRouterCreditStatus.mockResolvedValueOnce("paid");
    await click(user, "Check again");
    await waitFor(() => expect(rowState("ai")).toBe("ready"));
    expect(panel("openrouter")).toBeNull();
    expect(rowSubtitle("ai")).toBe("Connected · powers your coach");
    wizard.controller.dispose();
  });

  it("shows a pasted OpenRouter key as the OpenRouter lane and reads its credits on open and focus", async () => {
    const bridge = bridgeWith({ active: "openrouter", statuses: [ACTIVE] });
    bridge.openRouterCreditStatus.mockResolvedValue("never-paid");
    const wizard = mountWizard({ bridge });
    await wizard.open();

    await waitFor(() => expect(rowState("ai")).toBe("attention"));
    expect(rowTitle()).toBe("OpenRouter");
    expect(bridge.openRouterCreditStatus).toHaveBeenCalledOnce();
    expect(panelState()).toBe("no-credits");

    bridge.openRouterCreditStatus.mockResolvedValue("paid");
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(rowState("ai")).toBe("ready"));
    expect(bridge.openRouterCreditStatus).toHaveBeenCalledTimes(2);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(bridge.openRouterCreditStatus).toHaveBeenCalledTimes(2);
    wizard.controller.dispose();
  });

  it("reads the credit status again when the Settings setup panel opens", async () => {
    const bridge = bridgeWith({ active: "openrouter", statuses: [ACTIVE] });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await waitFor(() => expect(bridge.openRouterCreditStatus).toHaveBeenCalledOnce());
    const settings = renderLocalized(<SetupPanel placement="settings" />);
    await waitFor(() => expect(bridge.openRouterCreditStatus).toHaveBeenCalledTimes(2));
    settings.unmount();
    wizard.controller.dispose();
  });

  it("walks the code-by-hand states without a key or code in the renderer", async () => {
    const user = userEvent.setup();
    const bridge = bridgeWith();
    bridge.openRouterSignIn.mockReturnValueOnce(pending().promise);
    const wizard = await openIdlePanel(user, bridge);
    await click(user, SIGN_IN);
    await waitFor(() => expect(panelState()).toBe("waiting"));

    await click(user, "Enter a code instead");
    await waitFor(() => expect(panelState()).toBe("code"));
    expect(openRouterPanel()).toHaveTextContent("Sign in with a code");
    expect(openRouterPanel()).toHaveTextContent(
      "Use this when the browser cannot hand the sign-in back to Enduragent.",
    );
    expect(
      Array.from(openRouterPanel().querySelectorAll("li"), (item) => item.textContent),
    ).toEqual([
      "Choose Open sign-in page, then approve in your browser.",
      "Copy the code OpenRouter shows.",
      "Choose Use copied code. Enduragent reads the code, then clears your clipboard.",
    ]);
    expect(buttons().map((entry) => entry.name)).toEqual([
      "Cancel sign-in",
      "Open sign-in page",
      "Use copied code",
    ]);
    expect(openRouterPanel()).toHaveTextContent("A code works once and expires after 10 minutes.");
    expect(openRouterPanel().querySelector("input")).toBeNull();

    const codeOperation = bridge.startOpenRouterCodeSignIn.mock.calls[0]?.[0].operationId ?? "";
    bridge.useCopiedOpenRouterCode.mockResolvedValueOnce({
      status: "refused",
      operationId: codeOperation,
      reason: "clipboard-no-code",
    });
    await click(user, "Use copied code");
    await waitFor(() => expect(panelState()).toBe("code-problem"));
    expect(openRouterPanel()).toHaveTextContent(
      "Your clipboard does not hold an OpenRouter code. Copy the code from the browser, then choose Use copied code again. This sign-in stays open.",
    );

    bridge.useCopiedOpenRouterCode.mockResolvedValueOnce({
      status: "refused",
      operationId: codeOperation,
      reason: "code-expired",
    });
    await click(user, "Use copied code");
    await waitFor(() => expect(panelState()).toBe("code-expired"));
    expect(openRouterPanel()).toHaveTextContent(
      "That code expired or was already used. Choose Get a new code, then copy the new one.",
    );
    expect(buttons().map((entry) => entry.name)).toEqual(["Cancel sign-in", "Get a new code"]);
    await click(user, "Get a new code");
    await waitFor(() => expect(bridge.startOpenRouterCodeSignIn).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(panelState()).toBe("code"));

    await click(user, "Cancel sign-in");
    await waitFor(() => expect(panelState()).toBe("idle"));
    expect(bridge.cancelOpenRouterSignIn).toHaveBeenCalled();
    expect(bridge.writeCredential).not.toHaveBeenCalled();
    wizard.controller.dispose();
  });

  it.each([
    {
      reason: "not-finished",
      copy: "Sign-in was not finished in the browser. Try again when you are ready.",
      names: ["Cancel", "Try again", "Enter a code instead"],
    },
    {
      reason: "unreachable",
      copy: "OpenRouter did not answer, so nothing was saved. Try again in a minute.",
      names: ["Cancel", "Try again"],
    },
    {
      reason: "not-saved",
      copy: "OpenRouter made a key, but this Mac could not save it. Try again. The unused key stays on OpenRouter until you delete it there.",
      names: ["Cancel", "Try again", "Open my keys on OpenRouter"],
    },
  ] as const)("shows the $reason failure with its actions", async ({ reason, copy, names }) => {
    const user = userEvent.setup();
    const bridge = bridgeWith();
    bridge.openRouterSignIn.mockImplementationOnce(async ({ operationId }) => ({
      status: "refused",
      operationId,
      reason,
    }));
    const wizard = await openIdlePanel(user, bridge);
    await click(user, SIGN_IN);
    await waitFor(() => expect(panelState()).toBe(reason));
    const status = within(openRouterPanel()).getByRole("status");
    expect(status).toHaveTextContent(copy);
    expect(status.className).toContain("text-danger");
    expect(buttons().map((entry) => entry.name)).toEqual(names);
    if (reason === "not-saved") {
      await click(user, "Open my keys on OpenRouter");
      expect(bridge.openOpenRouterPage).toHaveBeenCalledWith("keys");
    }
    await click(user, "Try again");
    await waitFor(() => expect(bridge.openRouterSignIn).toHaveBeenCalledTimes(2));
    wizard.controller.dispose();
  });

  it("clears a failure with Cancel so OpenRouter opens idle next time", async () => {
    const user = userEvent.setup();
    const bridge = bridgeWith();
    bridge.openRouterSignIn.mockImplementationOnce(async ({ operationId }) => ({
      status: "refused",
      operationId,
      reason: "not-finished",
    }));
    const wizard = await openIdlePanel(user, bridge);
    await click(user, SIGN_IN);
    await waitFor(() => expect(panelState()).toBe("not-finished"));
    await click(user, "Cancel");
    await waitFor(() => expect(panel("openrouter")).toBeNull());
    expect(useEnduragentStore.getState().onboarding.openRouter.signIn.phase).toBe("idle");
    await chooseLane(user, "openrouter");
    await waitFor(() => expect(panelState()).toBe("idle"));
    wizard.controller.dispose();
  });

  it("closes a failed Sign in again in Settings and keeps the connected row", async () => {
    const user = userEvent.setup();
    const bridge = bridgeWith({ active: "openrouter", statuses: [ACTIVE] });
    bridge.openRouterSignIn.mockImplementationOnce(async ({ operationId }) => ({
      status: "refused",
      operationId,
      reason: "unreachable",
    }));
    const wizard = mountWizard({ bridge, placement: "settings" });
    await wizard.open();
    await waitFor(() => expect(rowState("ai")).toBe("ready"));
    await chooseLane(user, "openrouter");
    await click(user, "Sign in again");
    await waitFor(() => expect(panelState()).toBe("unreachable"));
    await click(user, "Cancel");
    await waitFor(() => expect(panel("openrouter")).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(panel("openrouter")).toBeNull();
    expect(rowState("ai")).toBe("ready");
    expect(rowSubtitle("ai")).toBe("Connected · powers your coach");
    wizard.controller.dispose();
  });

  it("retries activation of a saved key without signing in again", async () => {
    const user = userEvent.setup();
    const bridge = bridgeWith();
    const wizard = await openIdlePanel(user, bridge);
    bridge.credentialStatuses.mockResolvedValue([INACTIVE]);
    bridge.openRouterSignIn.mockImplementationOnce(async ({ operationId }) => ({
      status: "refused",
      operationId,
      reason: "saved-not-active",
    }));
    await click(user, SIGN_IN);
    await waitFor(() => expect(panelState()).toBe("saved-not-active"));
    expect(openRouterPanel()).toHaveTextContent("The key is saved on this Mac.");
    expect(within(openRouterPanel()).getByRole("status")).toHaveTextContent(
      "Signed in, but the coach could not start. Retry without signing in again.",
    );
    expect(rowSubtitle("ai")).toBe("Powers your coach · signed in · activation needed");
    expect(buttons().map((entry) => entry.name)).toEqual(["Retry activation"]);

    bridge.credentialStatuses.mockResolvedValue([ACTIVE]);
    await click(user, "Retry activation");
    await waitFor(() => expect(panel("openrouter")).toBeNull());
    expect(bridge.applyLlmSelection).toHaveBeenCalledWith(SELECTION);
    expect(bridge.openRouterSignIn).toHaveBeenCalledOnce();
    expect(rowSubtitle("ai")).toBe("Connected · powers your coach");
    wizard.controller.dispose();
  });

  it("keeps the paste path: Paste a key instead opens the API key lane with OpenRouter chosen", async () => {
    const user = userEvent.setup();
    const bridge = bridgeWith();
    const wizard = await openIdlePanel(user, bridge);
    await click(user, PASTE);
    await waitFor(() => expect(panel("api-key")).not.toBeNull());
    expect(control("onboarding-llm-provider")).toHaveTextContent("OpenRouter");
    expect(passwordInput("openrouter")).toBeInTheDocument();
    expect(panel("openrouter")).toBeNull();
    wizard.controller.dispose();
  });

  it("offers Sign in again in Settings when OpenRouter is already connected", async () => {
    const user = userEvent.setup();
    const bridge = bridgeWith({ active: "openrouter", statuses: [ACTIVE] });
    const wizard = mountWizard({ bridge, placement: "settings" });
    await wizard.open();
    await waitFor(() => expect(rowState("ai")).toBe("ready"));
    await chooseLane(user, "openrouter");
    await waitFor(() => expect(panelState()).toBe("sign-in-again"));
    expect(openRouterPanel()).toHaveTextContent(
      "Signing in again replaces the key on this Mac. The old key keeps working on OpenRouter until you delete it there.",
    );
    expect(buttons().map((entry) => entry.name)).toEqual(["Cancel", "Sign in again", PASTE]);
    expect(useEnduragentStore.getState().onboarding.openRouter.signIn.phase).toBe("idle");
    wizard.controller.dispose();
  });

  it("reactivates a stored OpenRouter key when the lane is picked again", async () => {
    const user = userEvent.setup();
    const bridge = bridgeWith({ statuses: [INACTIVE] });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    bridge.credentialStatuses.mockResolvedValue([ACTIVE]);
    await chooseLane(user, "openrouter");
    await waitFor(() => expect(rowState("ai")).toBe("ready"));
    expect(bridge.applyLlmSelection).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openrouter" }),
    );
    expect(bridge.openRouterSignIn).not.toHaveBeenCalled();
    expect(panel("openrouter")).toBeNull();
    wizard.controller.dispose();
  });

  it("tells Settings to reload after OpenRouter connects by sign-in or by a pasted key", async () => {
    const user = userEvent.setup();
    const bridge = bridgeWith();
    const reloadSettings = vi.fn();
    const wizard = mountWizard({ bridge, onActiveSelectionChanged: reloadSettings });
    await wizard.open();
    await chooseLane(user, "openrouter");
    bridge.credentialStatuses.mockResolvedValue([ACTIVE]);
    await click(user, SIGN_IN);
    await waitFor(() => expect(rowState("ai")).toBe("ready"));
    expect(reloadSettings).toHaveBeenCalledOnce();

    await chooseLane(user, "api-key");
    seedSecret("openrouter", PASTED_KEY);
    await saveModelKey(user);
    await waitFor(() => expect(reloadSettings).toHaveBeenCalledTimes(2));
    wizard.controller.dispose();
  });

  it("shows a status error when the setup status cannot be refreshed after sign-in", async () => {
    const user = userEvent.setup();
    const bridge = bridgeWith();
    const reloadSettings = vi.fn();
    const wizard = mountWizard({ bridge, onActiveSelectionChanged: reloadSettings });
    await wizard.open();
    await chooseLane(user, "openrouter");
    bridge.credentialStatuses.mockRejectedValue(new TypeError());
    await click(user, SIGN_IN);
    await waitFor(() => expect(setupRow("ai").parentElement).toHaveTextContent(STATUS_UNAVAILABLE));
    expect(useEnduragentStore.getState().onboarding.openRouter.signIn.phase).toBe("idle");
    expect(reloadSettings).not.toHaveBeenCalled();
    wizard.controller.dispose();
  });

  it("disables the code panel while main reads the copied code", async () => {
    const user = userEvent.setup();
    const bridge = bridgeWith();
    const read = pending();
    bridge.useCopiedOpenRouterCode.mockReturnValueOnce(read.promise);
    bridge.openRouterSignIn.mockReturnValueOnce(pending().promise);
    const wizard = await openIdlePanel(user, bridge);
    await click(user, SIGN_IN);
    await waitFor(() => expect(panelState()).toBe("waiting"));
    await click(user, "Enter a code instead");
    await waitFor(() => expect(panelState()).toBe("code"));
    await click(user, "Use copied code");
    await waitFor(() =>
      expect(buttons()).toEqual([
        { name: "Cancel sign-in", disabled: true },
        { name: "Open sign-in page", disabled: true },
        { name: "Use copied code", disabled: true },
      ]),
    );
    expect(document.querySelector<HTMLButtonElement>('[data-setup-trigger="ai"]')?.disabled).toBe(
      true,
    );
    const operationId = bridge.startOpenRouterCodeSignIn.mock.calls[0]?.[0].operationId ?? "";
    bridge.credentialStatuses.mockResolvedValue([ACTIVE]);
    read.resolve({ status: "connected", operationId, credit: "paid" });
    await waitFor(() => expect(panel("openrouter")).toBeNull());
    expect(bridge.cancelOpenRouterSignIn).not.toHaveBeenCalled();
    wizard.controller.dispose();
  });

  it("keeps the code panel open with the no-answer status when OpenRouter does not answer", async () => {
    const user = userEvent.setup();
    const bridge = bridgeWith();
    const wizard = await openIdlePanel(user, bridge);
    bridge.startOpenRouterCodeSignIn.mockImplementationOnce(async ({ operationId }) => {
      bridge.useCopiedOpenRouterCode.mockResolvedValueOnce({
        status: "refused",
        operationId,
        reason: "unreachable",
      });
      return { status: "awaiting-code", operationId };
    });
    bridge.openRouterSignIn.mockReturnValueOnce(pending().promise);
    await click(user, SIGN_IN);
    await click(user, "Enter a code instead");
    await waitFor(() => expect(panelState()).toBe("code"));
    await click(user, "Use copied code");
    await waitFor(() => expect(panelState()).toBe("code-unreachable"));
    expect(within(openRouterPanel()).getByRole("status")).toHaveTextContent(
      "OpenRouter did not answer, so nothing was saved. Try again in a minute.",
    );
    expect(buttons().map((entry) => entry.name)).toEqual([
      "Cancel sign-in",
      "Open sign-in page",
      "Use copied code",
    ]);
    wizard.controller.dispose();
  });

  it("cancels a code sign-in when the rider pastes an OpenRouter key instead", async () => {
    const user = userEvent.setup();
    const bridge = bridgeWith();
    bridge.openRouterSignIn.mockReturnValueOnce(pending().promise);
    const wizard = await openIdlePanel(user, bridge);
    await click(user, SIGN_IN);
    await click(user, "Enter a code instead");
    await waitFor(() => expect(panelState()).toBe("code"));
    const operationId = bridge.startOpenRouterCodeSignIn.mock.calls[0]?.[0].operationId ?? "";

    await chooseLane(user, "api-key");
    expect(bridge.cancelOpenRouterSignIn).toHaveBeenCalledWith(operationId);
    await waitFor(() => expect(panel("api-key")).not.toBeNull());
    await selectSetupOption(user, "onboarding-llm-provider", "openrouter");
    bridge.credentialStatuses.mockResolvedValue([ACTIVE]);
    seedSecret("openrouter", PASTED_KEY);
    await saveModelKey(user);
    await waitFor(() => expect(panel("api-key")).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(panel("openrouter")).toBeNull();
    expect(rowTitle()).toBe("OpenRouter");
    expect(rowState("ai")).toBe("ready");
    expect(useEnduragentStore.getState().onboarding.openRouter.signIn.phase).toBe("idle");
    wizard.controller.dispose();
  });

  it("clears an activation failure when another lane is picked, then reactivates from it", async () => {
    const user = userEvent.setup();
    const bridge = bridgeWith();
    const wizard = await openIdlePanel(user, bridge);
    bridge.credentialStatuses.mockResolvedValue([INACTIVE]);
    bridge.openRouterSignIn.mockImplementationOnce(async ({ operationId }) => ({
      status: "refused",
      operationId,
      reason: "saved-not-active",
    }));
    await click(user, SIGN_IN);
    await waitFor(() => expect(panelState()).toBe("saved-not-active"));

    await chooseLane(user, "api-key");
    expect(useEnduragentStore.getState().onboarding.openRouter.signIn.phase).toBe("idle");
    bridge.credentialStatuses.mockResolvedValue([ACTIVE]);
    await chooseLane(user, "openrouter");
    await waitFor(() => expect(rowState("ai")).toBe("ready"));
    expect(bridge.applyLlmSelection).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openrouter" }),
    );
    expect(panel("openrouter")).toBeNull();
    wizard.controller.dispose();
  });

  it("drops the sign-in state when a credential repair closes the panel", async () => {
    const user = userEvent.setup();
    const bridge = bridgeWith();
    bridge.openRouterSignIn.mockReturnValueOnce(pending().promise);
    const wizard = await openIdlePanel(user, bridge);
    await click(user, SIGN_IN);
    await click(user, "Enter a code instead");
    await waitFor(() => expect(panelState()).toBe("code"));
    act(() => {
      useEnduragentStore.getState().patchSettings({
        credentials: { status: "closed", repairCredential: "anthropic" },
      });
    });
    await waitFor(() => expect(panel("openrouter")).toBeNull());
    expect(useEnduragentStore.getState().onboarding.openRouter.signIn.phase).toBe("idle");
    expect(bridge.cancelOpenRouterSignIn).toHaveBeenCalled();
    wizard.controller.dispose();
  });

  it("opens the sign-in panel when OpenRouter is already the lane but its key does not work", async () => {
    const user = userEvent.setup();
    const bridge = bridgeWith({ active: "openrouter", statuses: [INACTIVE] });
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await waitFor(() => expect(rowTitle()).toBe("OpenRouter"));
    expect(rowState("ai")).toBe("pending");
    await chooseLane(user, "openrouter");
    await waitFor(() => expect(panelState()).toBe("idle"));
    expect(bridge.applyLlmSelection).not.toHaveBeenCalled();
    expect(buttons().map((entry) => entry.name)).toEqual(["Cancel", SIGN_IN, PASTE]);
    wizard.controller.dispose();
  });

  it("reads the credit of a pasted OpenRouter key and forgets the credit of the old key", async () => {
    const user = userEvent.setup();
    const bridge = bridgeWith();
    const wizard = await openIdlePanel(user, bridge);
    bridge.credentialStatuses.mockResolvedValue([ACTIVE]);
    bridge.openRouterSignIn.mockImplementationOnce(async ({ operationId }) => ({
      status: "connected",
      operationId,
      credit: "never-paid",
    }));
    await click(user, SIGN_IN);
    await waitFor(() => expect(rowState("ai")).toBe("attention"));

    let answerRecheck!: (status: "never-paid") => void;
    bridge.openRouterCreditStatus.mockReturnValueOnce(
      new Promise((resolve) => {
        answerRecheck = resolve;
      }),
    );
    await click(user, "Check again");
    expect(bridge.openRouterCreditStatus).toHaveBeenCalledOnce();
    expect(panelState()).toBe("no-credits");
    expect(rowState("ai")).toBe("attention");
    act(() => answerRecheck("never-paid"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(panelState()).toBe("no-credits");

    bridge.openRouterCreditStatus.mockResolvedValue("paid");
    await chooseLane(user, "api-key");
    seedSecret("openrouter", PASTED_KEY);
    await saveModelKey(user);
    await waitFor(() => expect(bridge.openRouterCreditStatus).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(rowState("ai")).toBe("ready"));
    expect(panel("openrouter")).toBeNull();

    bridge.openRouterCreditStatus.mockResolvedValue("never-paid");
    await chooseLane(user, "api-key");
    seedSecret("openrouter", PASTED_KEY);
    await saveModelKey(user);
    await waitFor(() => expect(rowState("ai")).toBe("attention"));
    expect(panelState()).toBe("no-credits");
    wizard.controller.dispose();
  });

  it("warns that deleting the OpenRouter key leaves it working on OpenRouter", async () => {
    const { say } = await createPhrasebook({ tag: "en", locale: "en-US" });
    expect(say(deleteDetailMessage("openrouter"))).toBe(
      "This removes it from this Mac only. Enduragent will stop using it if it is active. The key keeps working on OpenRouter until you delete it there.",
    );
    expect(say(deleteDetailMessage("anthropic"))).toBe(
      "This removes it from this Mac only. Enduragent will stop using it if it is active. Your provider account is unchanged.",
    );
  });
});
