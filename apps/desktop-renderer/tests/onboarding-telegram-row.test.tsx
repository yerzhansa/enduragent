import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { buttonVariants } from "@enduragent/ui";
import { cn } from "@enduragent/ui";
import type {
  TelegramControlStatus,
  TelegramSettingsAction,
  TelegramSettingsState,
} from "../src/settings/telegram-controller";
import { useEnduragentStore } from "../src/state/store";
import {
  TELEGRAM_AVAILABILITY_COPY,
  TELEGRAM_CREATE_COPY,
  TELEGRAM_CREATE_TITLE,
  TELEGRAM_DELETE_COPY,
} from "../src/ui/onboarding/copy";
import {
  mountWizard,
  panel,
  readyTelegramSettings,
  resetOnboardingStore,
  setTelegramSettings,
  setupCard,
  setupRow,
  testBridge,
} from "./onboarding-harness";

const UNCONFIGURED: TelegramControlStatus = {
  channel: { desiredState: "disabled", state: "disabled" },
  bot: { state: "unconfigured" },
  pairing: { state: "unpaired" },
  credentialConfigured: false,
  gapWarning: { state: "clear" },
};

const VERIFIED: TelegramControlStatus = {
  channel: { desiredState: "disabled", state: "disabled" },
  bot: { state: "ready", username: "synthetic_coach_bot" },
  pairing: { state: "unpaired" },
  credentialConfigured: true,
  gapWarning: { state: "clear" },
};

const CLOSED_UNCONFIGURED: TelegramControlStatus = {
  channel: {
    desiredState: "disabled",
    state: "failed",
    errorCode: "telegram-control-failed",
  },
  bot: { state: "unconfigured" },
  pairing: { state: "unpaired" },
  credentialConfigured: false,
  gapWarning: { state: "clear" },
};

const REDACTED_CONFIGURED: TelegramControlStatus = {
  channel: {
    desiredState: "disabled",
    state: "failed",
    errorCode: "telegram-credential-unavailable",
  },
  bot: { state: "unconfigured" },
  pairing: { state: "unpaired" },
  credentialConfigured: true,
  gapWarning: { state: "clear" },
};

const UNCERTAIN_CONNECTION_COPY =
  "The Telegram connection may have started, but Enduragent could not confirm whether it finished. Restart Enduragent and check Telegram before trying again.";

const UNCERTAIN_DELETION_COPY =
  "Telegram connection deletion may not have completed. Restart Enduragent and check whether the bot is still connected before trying again.";

const UNCERTAIN_STORAGE_DELETION_COPY =
  "Telegram connection deletion could not be confirmed because secure storage could not be verified. Restart Enduragent and check Telegram before trying again.";

function workingTelegramSettings(
  operation: TelegramSettingsAction,
  telegram: TelegramControlStatus,
): Extract<TelegramSettingsState, { readonly status: "working" }> {
  return {
    status: "working",
    operation,
    telegram,
    allowedSenders: { senders: [] },
    senderLoadFailed: false,
    announcement: "controller-specific working copy",
    healthAnnouncement: "",
    feedback: { tone: "status", message: "controller-specific working copy" },
  };
}

function publishTelegram(state: TelegramSettingsState, saving = false): void {
  act(() => {
    const current = useEnduragentStore.getState().settings;
    useEnduragentStore.setState({
      settings: {
        ...current,
        telegram: state,
        savingOwners: saving ? ["telegram"] : [],
      },
    });
  });
}

function deleteConfirmation(): HTMLElement {
  const confirmation = document.querySelector<HTMLElement>(
    '[data-inline-confirmation="delete-telegram"]',
  );
  if (confirmation === null) throw new TypeError("Telegram delete confirmation missing");
  return confirmation;
}

describe("setup gate Telegram row", () => {
  afterEach(() => resetOnboardingStore());

  it("sits after Training only in the gate and uses the approved logo-free clipboard flow", async () => {
    const user = userEvent.setup();
    const port = setTelegramSettings(readyTelegramSettings(UNCONFIGURED));
    const wizard = mountWizard({
      bridge: testBridge(async () => ({ status: "refused", reason: "cancelled" })),
    });
    await wizard.open();

    expect(
      Array.from(setupCard().children)
        .map((child) => (child as HTMLElement).dataset.setupRow ?? "")
        .filter(Boolean),
    ).toEqual(["ai", "training", "telegram", "injury-status"]);
    const row = setupRow("telegram");
    expect(row.querySelector("[data-setup-row-title]")).toHaveTextContent("Telegram");
    expect(row.querySelector("[data-telegram-optional]")).toHaveTextContent("Optional");
    expect(row).toHaveTextContent(TELEGRAM_AVAILABILITY_COPY);
    expect(row.querySelector('[data-setup-disc="pending"]')).not.toBeNull();
    expect(row.querySelector("img, input")).toBeNull();
    expect(screen.getByText(/required ready/u)).toBeVisible();

    const create = screen.getByRole("button", { name: "Create Telegram bot" });
    expect(create.className).toBe(
      screen.getByRole("button", { name: "Connect Intervals.icu" }).className,
    );
    await user.click(create);

    const telegramPanel = panel("telegram");
    expect(create).toHaveAttribute("aria-expanded", "true");
    expect(telegramPanel).not.toBeNull();
    expect(telegramPanel?.textContent).toContain(TELEGRAM_CREATE_COPY);
    expect(
      within(telegramPanel as HTMLElement).getByRole("link", { name: "@BotFather" }),
    ).toHaveAttribute("href", "https://t.me/BotFather");
    expect(telegramPanel?.querySelector("img, input, textarea")).toBeNull();
    expect(
      within(telegramPanel as HTMLElement)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Cancel", "Use copied token"]);
    expect(
      within(telegramPanel as HTMLElement).getByRole("heading", {
        name: TELEGRAM_CREATE_TITLE,
      }),
    ).toHaveFocus();

    const useToken = within(telegramPanel as HTMLElement).getByRole("button", {
      name: "Use copied token",
    });
    expect(useToken).toHaveAttribute("data-telegram-action", "use-token");
    await user.click(useToken);
    expect(port.pasteToken).toHaveBeenCalledOnce();

    wizard.controller.dispose();
    wizard.rendered.unmount();
    resetOnboardingStore();
    setTelegramSettings(readyTelegramSettings(VERIFIED));
    const settingsWizard = mountWizard({
      bridge: testBridge(async () => ({ status: "refused", reason: "cancelled" })),
      placement: "settings",
    });
    await settingsWizard.open();

    expect(document.querySelector('[data-setup-row="telegram"]')).toBeNull();
    expect(document.querySelector("[data-setup-readiness]")).toBeNull();
    settingsWizard.controller.dispose();
  });

  it("keeps the open panel aligned with authoritative identity changes from another surface", async () => {
    const user = userEvent.setup();
    setTelegramSettings(readyTelegramSettings(UNCONFIGURED));
    const wizard = mountWizard({
      bridge: testBridge(async () => ({ status: "refused", reason: "cancelled" })),
    });
    await wizard.open();

    await user.click(screen.getByRole("button", { name: "Create Telegram bot" }));
    expect(panel("telegram")).not.toBeNull();
    publishTelegram(readyTelegramSettings(VERIFIED));

    await waitFor(() => expect(panel("telegram")).toBeNull());
    const deleteButton = screen.getByRole("button", {
      name: "Delete the Telegram connection",
    });
    expect(deleteButton).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Use copied token" })).toBeNull();

    await user.click(deleteButton);
    expect(deleteConfirmation()).toBeVisible();
    publishTelegram(readyTelegramSettings(UNCONFIGURED));

    await waitFor(() => {
      expect(document.querySelector('[data-inline-confirmation="delete-telegram"]')).toBeNull();
      expect(panel("telegram")).not.toBeNull();
    });
    const firstTimePanel = panel("telegram") as HTMLElement;
    expect(
      within(firstTimePanel).getByRole("heading", { name: TELEGRAM_CREATE_TITLE }),
    ).toHaveFocus();
    expect(screen.getByRole("button", { name: "Create Telegram bot" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    wizard.controller.dispose();
  });

  it("shows generic progress and closes only after the controller reports applied verification", async () => {
    const user = userEvent.setup();
    const port = setTelegramSettings(readyTelegramSettings(UNCONFIGURED));
    const wizard = mountWizard({
      bridge: testBridge(async () => ({ status: "refused", reason: "cancelled" })),
    });
    await wizard.open();
    await user.click(screen.getByRole("button", { name: "Create Telegram bot" }));
    await user.click(screen.getByRole("button", { name: "Use copied token" }));

    publishTelegram(workingTelegramSettings("paste-token", UNCONFIGURED), true);
    expect(screen.getByRole("button", { name: "Connecting…" })).toBeDisabled();
    expect(screen.queryByText(/Reading and verifying/u)).toBeNull();

    publishTelegram(
      readyTelegramSettings(UNCONFIGURED, {
        tone: "error",
        message: "Telegram rejected the copied token. No Telegram bot was connected.",
      }),
    );
    await waitFor(() => {
      expect(panel("telegram")).not.toBeNull();
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Telegram rejected the copied token");
    expect(setupRow("telegram").dataset.state).toBe("pending");

    await user.click(screen.getByRole("button", { name: "Use copied token" }));
    publishTelegram(workingTelegramSettings("paste-token", UNCONFIGURED), true);
    publishTelegram(
      readyTelegramSettings(VERIFIED, {
        tone: "success",
        message: "Telegram is off.",
      }),
    );

    await waitFor(() => {
      expect(panel("telegram")).toBeNull();
    });
    expect(setupRow("telegram").dataset.state).toBe("ready");
    expect(setupRow("telegram")).toHaveTextContent("Bot verified · @synthetic_coach_bot");
    const rowButtons = within(setupRow("telegram")).getAllByRole("button");
    expect(rowButtons.map((button) => button.textContent)).toEqual(["Delete"]);
    const deleteButton = within(setupRow("telegram")).getByRole("button", {
      name: "Delete the Telegram connection",
    });
    expect(deleteButton.className).toBe(cn(buttonVariants({ variant: "destructive", size: "sm" })));
    expect(deleteButton).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Change Telegram bot" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Use copied token" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
    expect(port.pasteToken).toHaveBeenCalledTimes(2);
    wizard.controller.dispose();
  });

  it("offers one retry and restores Create focus when uncertain setup resolves as missing", async () => {
    const user = userEvent.setup();
    const port = setTelegramSettings(readyTelegramSettings(UNCONFIGURED));
    const wizard = mountWizard({
      bridge: testBridge(async () => ({ status: "refused", reason: "cancelled" })),
    });
    await wizard.open();
    await user.click(screen.getByRole("button", { name: "Create Telegram bot" }));
    await user.click(screen.getByRole("button", { name: "Use copied token" }));
    publishTelegram(workingTelegramSettings("paste-token", UNCONFIGURED), true);
    publishTelegram(
      readyTelegramSettings(CLOSED_UNCONFIGURED, {
        tone: "warning",
        message: UNCERTAIN_CONNECTION_COPY,
      }),
    );

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "Check again" })).toHaveLength(1);
    });
    expect(panel("telegram")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Use copied token" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(port.retry).toHaveBeenCalledOnce();
    publishTelegram(readyTelegramSettings(UNCONFIGURED));

    await waitFor(() => {
      expect(panel("telegram")).toBeNull();
    });
    const create = screen.getByRole("button", { name: "Create Telegram bot" });
    expect(create).toHaveFocus();
    expect(document.querySelector("[data-telegram-feedback]")).toBeNull();
    expect(port.pasteToken).toHaveBeenCalledOnce();
    wizard.controller.dispose();
  });

  it("keeps verified uncertain setup recovery without exposing a connected token action", async () => {
    const user = userEvent.setup();
    const port = setTelegramSettings(readyTelegramSettings(UNCONFIGURED));
    const wizard = mountWizard({
      bridge: testBridge(async () => ({ status: "refused", reason: "cancelled" })),
    });
    await wizard.open();
    await user.click(screen.getByRole("button", { name: "Create Telegram bot" }));
    await user.click(screen.getByRole("button", { name: "Use copied token" }));
    publishTelegram(workingTelegramSettings("paste-token", UNCONFIGURED), true);
    publishTelegram(
      readyTelegramSettings(VERIFIED, {
        tone: "warning",
        message: UNCERTAIN_CONNECTION_COPY,
      }),
    );

    await waitFor(() => {
      expect(document.querySelector('[data-telegram-feedback="warning"]')).toHaveTextContent(
        UNCERTAIN_CONNECTION_COPY,
      );
    });
    const deleteButton = screen.getByRole("button", { name: "Delete the Telegram connection" });
    expect(deleteButton).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Use copied token" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Check again" })).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(port.retry).toHaveBeenCalledOnce();
    publishTelegram(readyTelegramSettings(VERIFIED));

    await waitFor(() => expect(deleteButton).toBeEnabled());
    expect(deleteButton).toHaveFocus();
    expect(panel("telegram-connect-recovery")).toBeNull();
    expect(document.querySelector("[data-telegram-feedback]")).toBeNull();
    wizard.controller.dispose();
  });

  it.each([
    ["a closed control fallback", CLOSED_UNCONFIGURED],
    ["a redacted saved credential", REDACTED_CONFIGURED],
  ] as const)("offers Create for %s", async (_label, status) => {
    const user = userEvent.setup();
    const port = setTelegramSettings(readyTelegramSettings(status));
    const wizard = mountWizard({
      bridge: testBridge(async () => ({ status: "refused", reason: "cancelled" })),
    });
    await wizard.open();

    const create = screen.getByRole("button", { name: "Create Telegram bot" });
    expect(create).toBeVisible();
    expect(screen.queryByRole("button", { name: "Delete the Telegram connection" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
    await user.click(create);
    await user.click(screen.getByRole("button", { name: "Use copied token" }));
    expect(port.pasteToken).toHaveBeenCalledOnce();

    wizard.controller.dispose();
  });

  it("confirms deletion, restores focus on dismissal, and opens first-time setup after apply", async () => {
    const user = userEvent.setup();
    const port = setTelegramSettings(readyTelegramSettings(VERIFIED));
    const wizard = mountWizard({
      bridge: testBridge(async () => ({ status: "refused", reason: "cancelled" })),
    });
    await wizard.open();

    const rowButtons = within(setupRow("telegram")).getAllByRole("button");
    expect(rowButtons.map((button) => button.textContent)).toEqual(["Delete"]);
    const deleteButton = within(setupRow("telegram")).getByRole("button", {
      name: "Delete the Telegram connection",
    });
    expect(deleteButton.className).toBe(cn(buttonVariants({ variant: "destructive", size: "sm" })));
    expect(screen.queryByRole("button", { name: "Change Telegram bot" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Use copied token" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
    await user.click(deleteButton);

    let confirmation = deleteConfirmation();
    expect(confirmation).toHaveTextContent(TELEGRAM_DELETE_COPY);
    let confirmationButtons = within(confirmation).getAllByRole("button");
    expect(confirmationButtons.map((button) => button.textContent)).toEqual([
      "Cancel",
      "Delete connection",
    ]);
    expect(confirmationButtons[0]).toHaveFocus();
    expect(confirmationButtons[1]?.className).toBe(
      cn(buttonVariants({ variant: "destructive-solid", size: "sm" })),
    );
    expect(port.remove).not.toHaveBeenCalled();

    await user.click(confirmationButtons[0] as HTMLButtonElement);
    await waitFor(() => expect(deleteButton).toHaveFocus());
    expect(document.querySelector('[data-inline-confirmation="delete-telegram"]')).toBeNull();

    await user.click(deleteButton);
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(deleteButton).toHaveFocus());
    expect(document.querySelector('[data-inline-confirmation="delete-telegram"]')).toBeNull();

    await user.click(deleteButton);
    confirmation = deleteConfirmation();
    confirmationButtons = within(confirmation).getAllByRole("button");
    await user.click(confirmationButtons[1] as HTMLButtonElement);
    expect(port.remove).toHaveBeenCalledOnce();
    publishTelegram(workingTelegramSettings("remove", VERIFIED), true);
    expect(screen.getByRole("button", { name: "Delete connection" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByText("Deleting…")).toBeVisible();
    publishTelegram(
      readyTelegramSettings(UNCONFIGURED, {
        tone: "success",
        message: "Telegram connection deleted from this Mac.",
      }),
    );

    await waitFor(() => {
      expect(document.querySelector('[data-inline-confirmation="delete-telegram"]')).toBeNull();
      expect(panel("telegram")).not.toBeNull();
    });
    const firstTimePanel = panel("telegram") as HTMLElement;
    const heading = within(firstTimePanel).getByRole("heading", { name: TELEGRAM_CREATE_TITLE });
    expect(heading).toHaveFocus();
    expect(setupRow("telegram").dataset.state).toBe("pending");
    expect(screen.getByRole("button", { name: "Create Telegram bot" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(
      within(firstTimePanel)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Cancel", "Use copied token"]);
    wizard.controller.dispose();
  });

  it("opens first-time setup when deletion settles while the Chat setup row is unmounted", async () => {
    const user = userEvent.setup();
    setTelegramSettings(readyTelegramSettings(VERIFIED));
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    const first = mountWizard({ bridge });
    await first.open();
    await user.click(screen.getByRole("button", { name: "Delete the Telegram connection" }));
    await user.click(screen.getByRole("button", { name: "Delete connection" }));
    publishTelegram(workingTelegramSettings("remove", VERIFIED), true);

    first.controller.dispose();
    first.rendered.unmount();
    publishTelegram(
      readyTelegramSettings(UNCONFIGURED, {
        tone: "success",
        message: "Telegram connection deleted from this Mac.",
      }),
    );

    const reopened = mountWizard({ bridge });
    await reopened.open();

    await waitFor(() => expect(panel("telegram")).not.toBeNull());
    const firstTimePanel = panel("telegram") as HTMLElement;
    expect(setupRow("telegram").dataset.state).toBe("pending");
    expect(screen.getByRole("button", { name: "Create Telegram bot" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(
      within(firstTimePanel).getByRole("heading", { name: TELEGRAM_CREATE_TITLE }),
    ).toHaveFocus();
    reopened.controller.dispose();
  });

  it("restores busy deletion focus before an uncertain result after remount", async () => {
    const user = userEvent.setup();
    setTelegramSettings(readyTelegramSettings(VERIFIED));
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    const first = mountWizard({ bridge });
    await first.open();
    await user.click(screen.getByRole("button", { name: "Delete the Telegram connection" }));
    await user.click(screen.getByRole("button", { name: "Delete connection" }));
    publishTelegram(workingTelegramSettings("remove", VERIFIED), true);

    first.controller.dispose();
    first.rendered.unmount();

    const reopened = mountWizard({ bridge });
    await reopened.open();

    const busyDelete = screen.getByRole("button", { name: "Delete connection" });
    expect(busyDelete).toHaveAttribute("aria-disabled", "true");
    expect(busyDelete).toHaveFocus();

    publishTelegram(
      readyTelegramSettings(VERIFIED, {
        tone: "warning",
        message: UNCERTAIN_DELETION_COPY,
      }),
    );

    await waitFor(() => {
      expect(document.querySelector('[data-telegram-feedback="warning"]')).toHaveTextContent(
        UNCERTAIN_DELETION_COPY,
      );
    });
    expect(screen.getByRole("button", { name: "Delete connection" })).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "Check again" })).toHaveLength(1);
    reopened.controller.dispose();
  });

  it("fails closed and offers an authoritative retry after uncertain deletion across remount", async () => {
    const user = userEvent.setup();
    const port = setTelegramSettings(readyTelegramSettings(VERIFIED));
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    const first = mountWizard({ bridge });
    await first.open();
    await user.click(screen.getByRole("button", { name: "Delete the Telegram connection" }));
    await user.click(screen.getByRole("button", { name: "Delete connection" }));
    publishTelegram(workingTelegramSettings("remove", VERIFIED), true);

    first.controller.dispose();
    first.rendered.unmount();
    publishTelegram(
      readyTelegramSettings(CLOSED_UNCONFIGURED, {
        tone: "warning",
        message: UNCERTAIN_DELETION_COPY,
      }),
    );

    const reopened = mountWizard({ bridge });
    await reopened.open();

    expect(deleteConfirmation()).toHaveTextContent(TELEGRAM_DELETE_COPY);
    expect(setupRow("telegram")).toHaveTextContent("Bot verified · @synthetic_coach_bot");
    expect(document.querySelector('[data-telegram-feedback="warning"]')).toHaveTextContent(
      UNCERTAIN_DELETION_COPY,
    );
    expect(screen.getByRole("button", { name: "Delete connection" })).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "Check again" })).toHaveLength(1);
    expect(port.remove).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(port.retry).toHaveBeenCalledOnce();
    publishTelegram(readyTelegramSettings(VERIFIED));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Delete connection" })).toBeEnabled();
    });
    expect(deleteConfirmation()).toBeVisible();
    expect(screen.getByRole("button", { name: "Delete connection" })).toHaveFocus();
    expect(document.querySelector("[data-telegram-feedback]")).toBeNull();
    expect(port.remove).toHaveBeenCalledOnce();
    reopened.controller.dispose();
  });

  it("keeps a known-current uncertain deletion visible until retry and restores action focus", async () => {
    const user = userEvent.setup();
    const port = setTelegramSettings(readyTelegramSettings(VERIFIED));
    const wizard = mountWizard({
      bridge: testBridge(async () => ({ status: "refused", reason: "cancelled" })),
    });
    await wizard.open();
    await user.click(screen.getByRole("button", { name: "Delete the Telegram connection" }));
    await user.click(screen.getByRole("button", { name: "Delete connection" }));
    publishTelegram(workingTelegramSettings("remove", VERIFIED), true);
    publishTelegram(
      readyTelegramSettings(VERIFIED, {
        tone: "warning",
        message: UNCERTAIN_DELETION_COPY,
      }),
    );

    await waitFor(() => {
      expect(document.querySelector('[data-telegram-feedback="warning"]')).toHaveTextContent(
        UNCERTAIN_DELETION_COPY,
      );
    });
    expect(deleteConfirmation()).toBeVisible();
    expect(screen.getByRole("button", { name: "Delete connection" })).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "Check again" })).toHaveLength(1);
    expect(port.remove).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(port.retry).toHaveBeenCalledOnce();
    publishTelegram(readyTelegramSettings(VERIFIED));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Delete connection" })).toBeEnabled();
    });
    expect(deleteConfirmation()).toBeVisible();
    expect(screen.getByRole("button", { name: "Delete connection" })).toHaveFocus();
    expect(document.querySelector("[data-telegram-feedback]")).toBeNull();
    expect(port.remove).toHaveBeenCalledOnce();
    wizard.controller.dispose();
  });

  it("preserves uncertain deletion through Cancel and restores Delete focus", async () => {
    const user = userEvent.setup();
    const port = setTelegramSettings(readyTelegramSettings(VERIFIED));
    const wizard = mountWizard({
      bridge: testBridge(async () => ({ status: "refused", reason: "cancelled" })),
    });
    await wizard.open();
    const deleteButton = screen.getByRole("button", { name: "Delete the Telegram connection" });
    await user.click(deleteButton);
    await user.click(screen.getByRole("button", { name: "Delete connection" }));
    publishTelegram(workingTelegramSettings("remove", VERIFIED), true);
    publishTelegram(
      readyTelegramSettings(VERIFIED, {
        tone: "warning",
        message: UNCERTAIN_DELETION_COPY,
      }),
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Delete connection" })).toBeDisabled();
    });
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(deleteButton).toHaveFocus());
    expect(document.querySelector('[data-inline-confirmation="delete-telegram"]')).toBeNull();
    expect(panel("telegram-delete-recovery")).toBeNull();
    expect(document.querySelector("[data-telegram-feedback]")).toBeNull();
    expect(port.remove).toHaveBeenCalledOnce();

    await user.click(deleteButton);
    expect(deleteConfirmation()).toBeVisible();
    expect(document.querySelector('[data-telegram-feedback="warning"]')).toHaveTextContent(
      UNCERTAIN_DELETION_COPY,
    );
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    const retry = screen.getByRole("button", { name: "Check again" });
    await user.click(retry);
    expect(port.retry).toHaveBeenCalledOnce();
    publishTelegram(readyTelegramSettings(VERIFIED));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Delete connection" })).toBeEnabled();
    });
    expect(screen.getByRole("button", { name: "Delete connection" })).toHaveFocus();
    expect(document.querySelector("[data-telegram-feedback]")).toBeNull();
    expect(port.remove).toHaveBeenCalledOnce();
    wizard.controller.dispose();
  });

  it("opens first-time setup when retry confirms the bot is already gone", async () => {
    const user = userEvent.setup();
    const port = setTelegramSettings(readyTelegramSettings(VERIFIED));
    const bridge = testBridge(async () => ({ status: "refused", reason: "cancelled" }));
    const wizard = mountWizard({ bridge });
    await wizard.open();
    await user.click(screen.getByRole("button", { name: "Delete the Telegram connection" }));
    await user.click(screen.getByRole("button", { name: "Delete connection" }));
    publishTelegram(workingTelegramSettings("remove", VERIFIED), true);
    publishTelegram(
      readyTelegramSettings(CLOSED_UNCONFIGURED, {
        tone: "warning",
        message: UNCERTAIN_DELETION_COPY,
      }),
    );

    expect(screen.getByRole("button", { name: "Delete connection" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(port.retry).toHaveBeenCalledOnce();
    publishTelegram(readyTelegramSettings(UNCONFIGURED));

    await waitFor(() => {
      expect(document.querySelector('[data-inline-confirmation="delete-telegram"]')).toBeNull();
      expect(panel("telegram")).not.toBeNull();
    });
    const firstTimePanel = panel("telegram") as HTMLElement;
    const create = screen.getByRole("button", { name: "Create Telegram bot" });
    expect(setupRow("telegram").dataset.state).toBe("pending");
    expect(create).toHaveAttribute("aria-expanded", "true");
    expect(
      within(firstTimePanel).getByRole("heading", { name: TELEGRAM_CREATE_TITLE }),
    ).toHaveFocus();
    expect(document.querySelector("[data-telegram-feedback]")).toBeNull();
    expect(port.remove).toHaveBeenCalledOnce();
    wizard.controller.dispose();
  });

  it("keeps an unconfigured snapshot unresolved until secure-storage deletion is retried", async () => {
    const user = userEvent.setup();
    const port = setTelegramSettings(readyTelegramSettings(VERIFIED));
    const wizard = mountWizard({
      bridge: testBridge(async () => ({ status: "refused", reason: "cancelled" })),
    });
    await wizard.open();
    await user.click(screen.getByRole("button", { name: "Delete the Telegram connection" }));
    await user.click(screen.getByRole("button", { name: "Delete connection" }));
    publishTelegram(workingTelegramSettings("remove", VERIFIED), true);
    publishTelegram(
      readyTelegramSettings(UNCONFIGURED, {
        tone: "warning",
        message: UNCERTAIN_STORAGE_DELETION_COPY,
      }),
    );

    await waitFor(() => {
      expect(document.querySelector('[data-telegram-feedback="warning"]')).toHaveTextContent(
        UNCERTAIN_STORAGE_DELETION_COPY,
      );
    });
    expect(deleteConfirmation()).toBeVisible();
    expect(setupRow("telegram")).toHaveTextContent("Bot verified · @synthetic_coach_bot");
    expect(screen.getByRole("button", { name: "Delete connection" })).toBeDisabled();
    expect(panel("telegram")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(port.retry).toHaveBeenCalledOnce();
    publishTelegram(readyTelegramSettings(UNCONFIGURED));

    await waitFor(() => expect(panel("telegram")).not.toBeNull());
    expect(
      within(panel("telegram") as HTMLElement).getByRole("heading", {
        name: TELEGRAM_CREATE_TITLE,
      }),
    ).toHaveFocus();
    wizard.controller.dispose();
  });
});
