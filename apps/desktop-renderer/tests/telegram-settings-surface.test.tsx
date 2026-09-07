import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buttonVariants } from "@enduragent/ui";
import { cn } from "@enduragent/ui";
import type {
  TelegramAllowedSenders,
  TelegramControlStatus,
  TelegramSettingsState,
} from "../src/settings/telegram-controller";
import type { CredentialSettingsState } from "../src/settings/credential-controller";
import { EMPTY_SETTINGS_SURFACE, type TelegramSettingsPort } from "../src/state/settings-slice";
import { useEnduragentStore } from "../src/state/store";
import { TelegramSection } from "../src/ui/settings/TelegramSection";

function status(overrides: Partial<TelegramControlStatus> = {}): TelegramControlStatus {
  return {
    channel: { desiredState: "disabled", state: "disabled" },
    bot: { state: "unconfigured" },
    pairing: { state: "unpaired" },
    credentialConfigured: false,
    gapWarning: { state: "clear" },
    ...overrides,
  };
}

function readyState(
  telegram: TelegramControlStatus,
  allowedSenders: TelegramAllowedSenders = { senders: [] },
): Extract<TelegramSettingsState, { readonly status: "ready" }> {
  return {
    status: "ready",
    telegram,
    allowedSenders,
    senderLoadFailed: false,
    announcement: "",
    healthAnnouncement: "",
    feedback: null,
  };
}

function setup(
  next: TelegramSettingsState,
  credentials: CredentialSettingsState = EMPTY_SETTINGS_SURFACE.credentials,
) {
  const port = {
    retry: vi.fn(),
    pasteToken: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    remove: vi.fn(),
    reconcile: vi.fn(),
    removeWebhook: vi.fn(),
    beginPairing: vi.fn(),
    cancelPairing: vi.fn(),
    acknowledgeGapWarning: vi.fn(),
    addSender: vi.fn(),
    removeSender: vi.fn(),
  } satisfies TelegramSettingsPort;
  useEnduragentStore.setState({
    settings: { ...EMPTY_SETTINGS_SURFACE, credentials, telegram: next },
    settingsPorts: { telegram: port } as never,
  });
  render(<TelegramSection />);
  return port;
}

beforeEach(() => {
  useEnduragentStore.setState({
    settings: EMPTY_SETTINGS_SURFACE,
    settingsPorts: null,
  });
});

afterEach(() => {
  useEnduragentStore.setState({
    settings: EMPTY_SETTINGS_SURFACE,
    settingsPorts: null,
  });
});

describe("Telegram settings surface", () => {
  it("disables token storage and connection deletion during credential recovery", async () => {
    const user = userEvent.setup();
    const recovery = {
      status: "ready",
      entries: [],
      providerStatuses: [],
      confirmation: null,
      announcement: "Unlock your login Keychain outside Enduragent, then Retry.",
      recovery: { state: "locked" },
      repairCredential: null,
      recoveryAvailable: false,
      focus: null,
    } as const satisfies CredentialSettingsState;
    const port = setup(readyState(status()), recovery);

    const paste = screen.getByRole("button", { name: "Paste token from clipboard" });
    expect(paste).toBeDisabled();
    await user.click(paste);
    expect(port.pasteToken).not.toHaveBeenCalled();

    act(() => {
      useEnduragentStore.setState({
        settings: {
          ...useEnduragentStore.getState().settings,
          telegram: readyState(
            status({
              bot: { state: "ready", username: "desktop_coach_bot" },
              credentialConfigured: true,
            }),
          ),
        },
      });
    });

    const remove = screen.getByRole("button", { name: "Delete" });
    expect(remove).toBeDisabled();
    await user.click(remove);
    expect(port.remove).not.toHaveBeenCalled();
  });

  it("disables an open Telegram deletion confirmation when recovery becomes blocked", async () => {
    const user = userEvent.setup();
    const port = setup(
      readyState(
        status({
          bot: { state: "ready", username: "desktop_coach_bot" },
          credentialConfigured: true,
        }),
      ),
    );

    await user.click(screen.getByRole("button", { name: "Delete" }));
    const confirm = screen.getByRole("button", { name: "Delete connection" });
    expect(confirm).toBeEnabled();

    act(() => {
      useEnduragentStore.setState({
        settings: {
          ...useEnduragentStore.getState().settings,
          credentials: {
            status: "ready",
            entries: [],
            providerStatuses: [],
            confirmation: null,
            announcement: "Secure credential storage is unavailable.",
            recovery: { state: "unavailable" },
            repairCredential: null,
            recoveryAvailable: false,
            focus: null,
          },
        },
      });
    });

    expect(confirm).toBeDisabled();
    await user.click(confirm);
    expect(port.remove).not.toHaveBeenCalled();
  });

  it("explains the dedicated-bot boundary and accepts a token only from the clipboard", async () => {
    const user = userEvent.setup();
    const port = setup(readyState(status()));
    const section = screen.getByRole("region", { name: "Telegram" });

    expect(within(section).getByText(/creates a new @username and Telegram chat/u)).toBeVisible();
    expect(
      within(section).getByText(/visible history from a previous bot does not move/u),
    ).toBeVisible();
    expect(
      within(section).getByText(/athlete memory, training data and plans are shared/iu),
    ).toBeVisible();
    expect(within(section).getByText(/Mac is awake and online/u)).toBeVisible();
    expect(within(section).getByRole("link", { name: "@BotFather" })).toHaveAttribute(
      "href",
      "https://t.me/BotFather",
    );
    expect(within(section).queryByRole("textbox")).toBeNull();

    const firstTimeHeading = within(section).getByRole("heading", {
      name: "Create a bot with BotFather",
    });
    const firstTimePanel = firstTimeHeading.closest<HTMLElement>("#telegram-first-time-panel");
    expect(firstTimePanel).not.toBeNull();
    expect(
      within(firstTimePanel as HTMLElement)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Cancel", "Paste token from clipboard"]);

    await user.click(
      within(firstTimePanel as HTMLElement).getByRole("button", {
        name: "Cancel Telegram bot setup",
      }),
    );
    const connect = within(section).getByRole("button", { name: "Connect" });
    await waitFor(() => expect(connect).toHaveFocus());
    expect(port.pasteToken).not.toHaveBeenCalled();

    await user.click(connect);
    const reopenedHeading = within(section).getByRole("heading", {
      name: "Create a bot with BotFather",
    });
    expect(reopenedHeading).toHaveFocus();
    const reopenedPanel = reopenedHeading.closest<HTMLElement>("#telegram-first-time-panel");
    expect(reopenedPanel).not.toBeNull();
    await user.click(
      within(reopenedPanel as HTMLElement).getByRole("button", {
        name: "Paste token from clipboard",
      }),
    );
    expect(port.pasteToken).toHaveBeenCalledWith();
  });

  it("keeps clipboard setup closed until the missing identity is authoritative", async () => {
    const user = userEvent.setup();
    const port = setup({
      status: "error",
      kind: "load",
      telegram: null,
      allowedSenders: null,
      senderLoadFailed: false,
      announcement: "Telegram settings aren’t available.",
      healthAnnouncement: "",
      feedback: null,
    });

    expect(screen.getByText("Telegram status unavailable")).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Paste token from clipboard" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Create a bot with BotFather" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(port.retry).toHaveBeenCalledWith();
    expect(port.pasteToken).not.toHaveBeenCalled();
    expect(port.remove).not.toHaveBeenCalled();
  });

  it("shows the short-lived pairing code and explicit webhook removal", async () => {
    const user = userEvent.setup();
    const webhookPort = setup(
      readyState(
        status({
          bot: { state: "webhook-removal-required", username: "desktop_coach_bot" },
          credentialConfigured: true,
        }),
      ),
    );

    await user.click(screen.getByRole("button", { name: "Remove webhook" }));
    expect(webhookPort.removeWebhook).toHaveBeenCalledWith();

    act(() => {
      useEnduragentStore.setState({
        settings: {
          ...useEnduragentStore.getState().settings,
          telegram: readyState(
            status({
              channel: { desiredState: "enabled", state: "starting" },
              bot: { state: "ready", username: "desktop_coach_bot" },
              pairing: {
                state: "awaiting-code",
                code: "A1B2C3",
                expiresAt: "2098-07-06T12:01:00.000Z",
              },
              credentialConfigured: true,
            }),
          ),
        },
      });
    });

    expect(screen.getByLabelText("Telegram pairing code")).toHaveTextContent("A1B2C3");
    expect(
      screen.getByText(
        /first account to send it becomes the primary user, and the bot stays online/u,
      ),
    ).toBeVisible();
  });

  it.each([
    ["disabled intent", { desiredState: "disabled" as const, state: "disabled" as const }, true],
    ["failed channel", { desiredState: "enabled" as const, state: "failed" as const }, true],
    ["polling conflict", { desiredState: "enabled" as const, state: "conflict" as const }, true],
    [
      "transfer requirement",
      { desiredState: "enabled" as const, state: "transfer-required" as const },
      true,
    ],
    ["missing credential", { desiredState: "enabled" as const, state: "starting" as const }, false],
  ])("hides an unusable pairing code after %s", (_reason, channel, credentialConfigured) => {
    setup(
      readyState(
        status({
          channel,
          bot: { state: "ready", username: "desktop_coach_bot" },
          pairing: {
            state: "awaiting-code",
            code: "A1B2C3",
            expiresAt: "2098-07-06T12:01:00.000Z",
          },
          credentialConfigured,
        }),
      ),
    );

    expect(screen.queryByLabelText("Telegram pairing code")).toBeNull();
  });

  it("manages paired users without offering removal for the primary user", async () => {
    const user = userEvent.setup();
    const connected = status({
      channel: { desiredState: "enabled", state: "online" },
      bot: { state: "ready", username: "desktop_coach_bot" },
      pairing: { state: "paired" },
      credentialConfigured: true,
      gapWarning: {
        state: "possible-message-loss",
        detectedAt: "1998-07-06T12:00:00.000Z",
      },
    });
    const allowedSenders: TelegramAllowedSenders = {
      senders: [
        { senderId: 101, role: "primary" },
        { senderId: 202, role: "additional" },
      ],
    };
    const port = setup(readyState(connected, allowedSenders));

    expect(screen.getByText("@desktop_coach_bot")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Acknowledge" }));
    expect(port.acknowledgeGapWarning).toHaveBeenCalledWith();

    await user.click(screen.getByText("Advanced · allowed users"));
    const users = screen.getByRole("list", { name: "Allowed Telegram users" });
    expect(within(users).getByText("Primary user · required")).toBeVisible();
    expect(within(users).queryByRole("button", { name: "Remove Telegram user 101" })).toBeNull();

    const removeSender = within(users).getByRole("button", {
      name: "Remove Telegram user 202",
    });
    expect(removeSender.className).toBe(cn(buttonVariants({ variant: "destructive", size: "sm" })));

    await user.click(removeSender);
    let confirmation = within(users).getByRole("group", {
      name: "Remove Telegram user 202?",
    });
    expect(confirmation).toHaveAccessibleDescription(
      /lose access to your coach and shared athlete data until you re-add them by sender ID 202/iu,
    );
    let confirmationButtons = within(confirmation).getAllByRole("button");
    expect(confirmationButtons.map((button) => button.textContent)).toEqual([
      "Cancel",
      "Remove user",
    ]);
    expect(confirmationButtons[0]).toHaveFocus();
    expect(port.removeSender).not.toHaveBeenCalled();

    await user.click(confirmationButtons[0]);
    await waitFor(() => expect(removeSender).toHaveFocus());
    expect(port.removeSender).not.toHaveBeenCalled();

    await user.click(removeSender);
    confirmation = within(users).getByRole("group", {
      name: "Remove Telegram user 202?",
    });
    confirmationButtons = within(confirmation).getAllByRole("button");
    await user.click(confirmationButtons[1]);
    expect(port.removeSender).toHaveBeenCalledTimes(1);
    expect(port.removeSender).toHaveBeenCalledWith(202);

    act(() => {
      useEnduragentStore.setState((current) => ({
        settings: {
          ...current.settings,
          telegram: {
            ...readyState(connected, allowedSenders),
            status: "working",
            operation: "remove-sender",
          },
        },
      }));
    });
    const busyRemove = within(confirmation).getByRole("button", { name: "Remove user" });
    expect(busyRemove).toHaveAttribute("aria-disabled", "true");
    expect(busyRemove).not.toBeDisabled();
    await user.click(busyRemove);
    expect(port.removeSender).toHaveBeenCalledTimes(1);

    act(() => {
      useEnduragentStore.setState((current) => ({
        settings: {
          ...current.settings,
          telegram: readyState(connected, {
            senders: [{ senderId: 101, role: "primary" }],
          }),
        },
      }));
    });
    await waitFor(() =>
      expect(within(users).queryByRole("group", { name: "Remove Telegram user 202?" })).toBeNull(),
    );

    const senderId = screen.getByLabelText("Add a Telegram user ID");
    await user.type(senderId, "9");
    await user.click(screen.getByRole("button", { name: "Add user" }));
    expect(screen.getByText(/at least two digits/u)).toBeVisible();
    expect(port.addSender).not.toHaveBeenCalled();

    await user.clear(senderId);
    await user.type(senderId, "303");
    await user.click(screen.getByRole("button", { name: "Add user" }));
    expect(port.addSender).toHaveBeenCalledWith(303);
  });

  it("blocks allowed-user changes while credential reset is uncertain", async () => {
    const user = userEvent.setup();
    const connected = status({
      channel: { desiredState: "enabled", state: "online" },
      bot: { state: "ready", username: "desktop_coach_bot" },
      pairing: { state: "paired" },
      credentialConfigured: true,
    });
    const port = setup(
      readyState(connected, {
        senders: [
          { senderId: 101, role: "primary" },
          { senderId: 202, role: "additional" },
        ],
      }),
    );

    await user.click(screen.getByText("Advanced · allowed users"));
    const senderId = screen.getByLabelText("Add a Telegram user ID");
    await user.type(senderId, "303");
    const removeSender = screen.getByRole("button", { name: "Remove Telegram user 202" });
    await user.click(removeSender);
    const confirmation = screen.getByRole("group", { name: "Remove Telegram user 202?" });

    act(() => {
      useEnduragentStore.setState((current) => ({
        settings: {
          ...current.settings,
          credentials: {
            status: "error",
            kind: "load",
            announcement: "Credential removal could not be verified.",
            repairCredential: null,
            resetUncertain: true,
            recoveryAvailable: true,
            focus: { target: "feedback" },
          },
        },
      }));
    });

    expect(senderId).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add user" })).toBeDisabled();
    expect(removeSender).toBeDisabled();
    const confirm = within(confirmation).getByRole("button", { name: "Remove user" });
    expect(confirm).toBeDisabled();
    fireEvent.submit(senderId.closest("form")!);
    await user.click(confirm);
    expect(port.addSender).not.toHaveBeenCalled();
    expect(port.removeSender).not.toHaveBeenCalled();
  });

  it("truthfully explains automatic recovery when paired-user loading fails", async () => {
    const user = userEvent.setup();
    setup({
      ...readyState(
        status({
          channel: { desiredState: "enabled", state: "online" },
          bot: { state: "ready", username: "desktop_coach_bot" },
          pairing: { state: "paired" },
          credentialConfigured: true,
        }),
      ),
      senderLoadFailed: true,
      allowedSenders: null,
    });

    await user.click(screen.getByText("Advanced · allowed users"));

    expect(screen.getByText(/will try again automatically/u)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
  });

  it("labels ambiguous Telegram settings as repair-required storage uncertainty", () => {
    setup(
      readyState(
        status({
          channel: {
            desiredState: "enabled",
            state: "failed",
            errorCode: "telegram-settings-storage-uncertain",
          },
          bot: { state: "ready", username: "desktop_coach_bot" },
          pairing: { state: "unpaired" },
          credentialConfigured: true,
        }),
      ),
    );

    expect(screen.getByText(/Telegram settings may not have been saved completely/u)).toBeVisible();
    expect(screen.queryByText(/encrypted bot credential could not be saved/u)).toBeNull();
  });

  it.each([
    [
      "telegram-credential-encryption-unavailable" as const,
      /quit and reopen Enduragent, unlock your login keychain, then choose Check again/iu,
      /without encryption/iu,
    ],
    [
      "telegram-credential-unsafe-backend" as const,
      /refused to access the saved bot token without encryption.*choose Check again/iu,
      /macOS|Keychain/iu,
    ],
    [
      "telegram-credential-unavailable" as const,
      /saved bot token could not be read from secure storage.*delete this connection, then connect a new bot/iu,
      /macOS|Keychain/iu,
    ],
  ])("offers actionable recovery for %s", async (errorCode, expected, forbidden) => {
    const user = userEvent.setup();
    const port = setup(
      readyState(status({ channel: { desiredState: "enabled", state: "failed", errorCode } })),
    );

    expect(screen.getByText(expected)).toBeVisible();
    expect(screen.queryByText(forbidden)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(port.reconcile).toHaveBeenCalledWith();
  });

  it("fails closed when a configured credential identity cannot be read", async () => {
    const user = userEvent.setup();
    const port = setup(
      readyState(
        status({
          channel: {
            desiredState: "enabled",
            state: "failed",
            errorCode: "telegram-credential-unavailable",
          },
          bot: { state: "unconfigured" },
          credentialConfigured: true,
        }),
      ),
    );

    expect(
      screen.getByText(/saved bot token could not be read from secure storage/iu),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Check again" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Paste token from clipboard" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Create a bot with BotFather" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(port.reconcile).toHaveBeenCalledWith();
    expect(port.pasteToken).not.toHaveBeenCalled();
    expect(port.remove).not.toHaveBeenCalled();

    act(() => {
      useEnduragentStore.setState((current) => ({
        settings: {
          ...current.settings,
          telegram: readyState(status()),
        },
      }));
    });

    const firstTimeHeading = await screen.findByRole("heading", {
      name: "Create a bot with BotFather",
    });
    await waitFor(() => expect(firstTimeHeading).toHaveFocus());
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
    expect(screen.getByRole("button", { name: "Paste token from clipboard" })).toBeVisible();
  });

  it("fails closed after an uncertain deletion leaves identity unverified", async () => {
    const user = userEvent.setup();
    const port = setup(
      readyState(
        status({
          channel: {
            desiredState: "disabled",
            state: "failed",
            errorCode: "telegram-control-failed",
          },
          bot: { state: "unconfigured" },
          credentialConfigured: false,
        }),
      ),
    );

    expect(
      screen.getByText(
        "Telegram could not start. Keep Enduragent open, check the internet connection, then choose Check again.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Check again" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Paste token from clipboard" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Create a bot with BotFather" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Check again" }));
    expect(port.reconcile).toHaveBeenCalledWith();
    expect(port.pasteToken).not.toHaveBeenCalled();
    expect(port.remove).not.toHaveBeenCalled();
  });

  it.each([
    [
      "transfer-required" as const,
      /delete the connection there, then reconnect it here with a copied token/iu,
    ],
    [
      "invalid-token" as const,
      /delete this connection, then connect a new bot with a copied token from BotFather/iu,
    ],
  ])("uses delete-and-reconnect guidance for %s", (channelState, expected) => {
    setup(
      readyState(
        status({
          channel: { desiredState: "enabled", state: channelState },
          bot: { state: "ready", username: "desktop_coach_bot" },
          credentialConfigured: true,
        }),
      ),
    );

    expect(screen.getByText(expected)).toBeVisible();
    expect(screen.queryByText(/replace it|paste its token here again/iu)).toBeNull();
  });

  it.each([
    [
      "telegram-credential-encryption-unavailable" as const,
      /quit and reopen Enduragent, unlock your login keychain, then choose Check again/iu,
    ],
    [
      "telegram-credential-unsafe-backend" as const,
      /refused to access the saved bot token without encryption.*choose Check again/iu,
    ],
  ])("keeps the current paired bot visible during %s recovery", (errorCode, expected) => {
    setup(
      readyState(
        status({
          channel: { desiredState: "enabled", state: "failed", errorCode },
          bot: { state: "ready", username: "desktop_coach_bot" },
          pairing: { state: "paired" },
          credentialConfigured: true,
        }),
      ),
    );

    expect(screen.getByText(expected)).toBeVisible();
    expect(screen.getByText("@desktop_coach_bot")).toBeVisible();
    expect(screen.getByText("Paired with a primary Telegram user")).toBeVisible();
    expect(screen.getByRole("button", { name: "Check again" })).toBeVisible();
    expect(screen.queryByText("Create a bot with BotFather")).toBeNull();
    expect(screen.queryByRole("button", { name: "Paste token from clipboard" })).toBeNull();
  });

  it("requires confirmation before deleting the encrypted bot credential", async () => {
    const user = userEvent.setup();
    const connected = status({
      bot: { state: "ready", username: "desktop_coach_bot" },
      pairing: { state: "paired" },
      credentialConfigured: true,
    });
    const port = setup(readyState(connected));

    await user.click(screen.getByText("Advanced · allowed users"));
    await user.type(screen.getByLabelText("Add a Telegram user ID"), "9");
    await user.click(screen.getByRole("button", { name: "Add user" }));
    expect(
      screen.getByText("Enter a numeric Telegram user ID with at least two digits."),
    ).toBeVisible();

    const deleteTrigger = screen.getByRole("button", { name: "Delete" });
    expect(deleteTrigger.className).toBe(
      cn(buttonVariants({ variant: "destructive", size: "sm" })),
    );
    expect(screen.queryByRole("button", { name: "Replace token from clipboard" })).toBeNull();

    await user.click(deleteTrigger);
    let confirmation = screen.getByRole("group", {
      name: "Delete @desktop_coach_bot from this Mac?",
    });
    expect(confirmation).toHaveAccessibleDescription(
      /deletes its encrypted token and allowed-user access from this Mac/iu,
    );
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

    await user.click(confirmationButtons[0]);
    await waitFor(() => expect(deleteTrigger).toHaveFocus());

    await user.click(deleteTrigger);
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(deleteTrigger).toHaveFocus());
    expect(
      screen.queryByRole("group", { name: "Delete @desktop_coach_bot from this Mac?" }),
    ).toBeNull();

    await user.click(deleteTrigger);
    confirmation = screen.getByRole("group", {
      name: "Delete @desktop_coach_bot from this Mac?",
    });
    confirmationButtons = within(confirmation).getAllByRole("button");
    await user.click(confirmationButtons[1]);
    expect(port.remove).toHaveBeenCalledWith();
    expect(confirmation).toBeVisible();

    act(() => {
      useEnduragentStore.setState((current) => ({
        settings: {
          ...current.settings,
          telegram: {
            ...readyState(connected),
            status: "working",
            operation: "remove",
          },
        },
      }));
    });
    const busyDelete = within(confirmation).getByRole("button", { name: "Delete connection" });
    expect(busyDelete).toHaveAttribute("aria-disabled", "true");
    expect(busyDelete).not.toBeDisabled();
    expect(busyDelete).toHaveFocus();

    act(() => {
      useEnduragentStore.setState((current) => ({
        settings: {
          ...current.settings,
          telegram: readyState(status()),
        },
      }));
    });

    const firstTimeHeading = await screen.findByRole("heading", {
      name: "Create a bot with BotFather",
    });
    await waitFor(() => expect(firstTimeHeading).toHaveFocus());
    const firstTimePanel = firstTimeHeading.closest<HTMLElement>("#telegram-first-time-panel");
    expect(firstTimePanel).not.toBeNull();
    expect(
      within(firstTimePanel as HTMLElement)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Cancel", "Paste token from clipboard"]);
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Replace token from clipboard" })).toBeNull();

    act(() => {
      useEnduragentStore.setState((current) => ({
        settings: {
          ...current.settings,
          telegram: readyState(connected),
        },
      }));
    });
    await user.click(screen.getByText("Advanced · allowed users"));
    expect(screen.getByLabelText("Add a Telegram user ID")).toHaveValue("");
    expect(
      screen.queryByText("Enter a numeric Telegram user ID with at least two digits."),
    ).toBeNull();
  });

  it("announces a refused deletion as an alert while keeping online health visible", () => {
    const telegram = status({
      channel: { desiredState: "enabled", state: "online" },
      bot: { state: "ready", username: "desktop_coach_bot" },
      pairing: { state: "paired" },
      credentialConfigured: true,
    });
    setup({
      ...readyState(telegram),
      announcement: "The Telegram connection was not deleted. The current bot is unchanged.",
      feedback: {
        tone: "error",
        message: "The Telegram connection was not deleted. The current bot is unchanged.",
      },
    });

    expect(screen.getByText("Online")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The Telegram connection was not deleted. The current bot is unchanged.",
    );
  });

  it("announces a health transition separately from action feedback", () => {
    const telegram = status({
      channel: { desiredState: "enabled", state: "online" },
      bot: { state: "ready", username: "desktop_coach_bot" },
      pairing: { state: "paired" },
      credentialConfigured: true,
    });
    setup({
      ...readyState(telegram),
      announcement: "Telegram is online.",
      healthAnnouncement: "Telegram is online.",
      feedback: null,
    });

    expect(screen.getByText("Online")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Telegram is online.");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("publishes one polite announcement when pairing completes", () => {
    const message = "Telegram is paired with its primary user.";
    setup({
      ...readyState(
        status({
          channel: { desiredState: "enabled", state: "online" },
          bot: { state: "ready", username: "desktop_coach_bot" },
          pairing: { state: "paired" },
          credentialConfigured: true,
        }),
      ),
      healthAnnouncement: message,
      feedback: null,
    });

    const announcements = screen
      .getAllByRole("status")
      .filter((element) => element.textContent === message);
    expect(announcements).toHaveLength(1);
    expect(announcements[0]).toHaveAttribute("aria-live", "polite");
    expect(announcements[0]).toHaveAttribute("aria-atomic", "true");
    expect(screen.getAllByText(message)).toHaveLength(1);
  });

  it("exposes uncertain deletion feedback as a polite live warning", () => {
    const message =
      "Telegram removal could not be confirmed. Restart Enduragent and check the connection before trying again.";
    setup({
      ...readyState(
        status({
          channel: { desiredState: "enabled", state: "online" },
          bot: { state: "ready", username: "desktop_coach_bot" },
          pairing: { state: "paired" },
          credentialConfigured: true,
        }),
      ),
      announcement: message,
      feedback: { tone: "warning", message },
    });

    const warning = screen.getByText(message);
    expect(warning).toHaveAttribute("role", "status");
    expect(warning).toHaveAttribute("aria-live", "polite");
    expect(warning).toHaveAttribute("aria-atomic", "true");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders transient sleep suspension without calling it disabled or connecting", () => {
    setup(
      readyState(
        status({
          channel: { desiredState: "enabled", state: "suspended" },
          bot: { state: "ready", username: "desktop_coach_bot" },
          pairing: { state: "paired" },
          credentialConfigured: true,
        }),
      ),
    );

    expect(screen.getByText("Paused while asleep")).toBeVisible();
    expect(screen.getByText(/polling resumes when this Mac wakes/iu)).toBeVisible();
    expect(screen.queryByText("Off")).toBeNull();
    expect(screen.queryByText("Connecting")).toBeNull();
  });
});
