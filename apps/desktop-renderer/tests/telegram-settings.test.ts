import { describe, expect, it, vi } from "vitest";
import {
  createTelegramSettingsController,
  type TelegramAllowedSendersMutationResult,
  type TelegramAllowedSenders,
  type TelegramControlStatus,
  type TelegramMutationResult,
  type TelegramSettingsBridge,
  type TelegramSettingsState,
  type TelegramSettingsView,
} from "../src/settings/telegram-controller.js";

const DISABLED = Object.freeze({
  channel: { desiredState: "disabled", state: "disabled" },
  bot: { state: "unconfigured" },
  pairing: { state: "unpaired" },
  credentialConfigured: false,
  gapWarning: { state: "clear" },
} as const satisfies TelegramControlStatus);

const PAIRED = Object.freeze({
  channel: { desiredState: "enabled", state: "online" },
  bot: { state: "ready", username: "synthetic_bot" },
  pairing: { state: "paired" },
  credentialConfigured: true,
  gapWarning: { state: "clear" },
} as const satisfies TelegramControlStatus);

const OFFLINE = Object.freeze({
  ...PAIRED,
  channel: { desiredState: "enabled", state: "offline-retrying" },
} as const satisfies TelegramControlStatus);

const AWAITING = Object.freeze({
  ...PAIRED,
  channel: { desiredState: "enabled", state: "starting" },
  pairing: {
    state: "awaiting-code",
    code: "A1B2C3",
    expiresAt: "1998-07-06T12:01:00.000Z",
  },
} as const satisfies TelegramControlStatus);

const SENDERS = Object.freeze({
  senders: Object.freeze([{ senderId: 101, role: "primary" as const }]),
}) satisfies TelegramAllowedSenders;

function setup() {
  const states: TelegramSettingsState[] = [];
  let handlers!: Parameters<TelegramSettingsView["bind"]>[0];
  let poll: (() => void) | undefined;
  const release = vi.fn();
  const bridge = {
    status: vi.fn(async (): Promise<TelegramControlStatus> => DISABLED),
    pasteTokenFromClipboard: vi.fn(
      async (): Promise<TelegramMutationResult> => ({
        outcome: "applied" as const,
        current: {
          ...DISABLED,
          bot: { state: "ready" as const, username: "synthetic_bot" },
          credentialConfigured: true,
        },
      }),
    ),
    enable: vi.fn(
      async (): Promise<TelegramMutationResult> => ({ outcome: "applied", current: PAIRED }),
    ),
    disable: vi.fn(
      async (): Promise<TelegramMutationResult> => ({
        outcome: "applied" as const,
        current: {
          ...PAIRED,
          channel: { desiredState: "disabled" as const, state: "disabled" as const },
        },
      }),
    ),
    remove: vi.fn(
      async (): Promise<TelegramMutationResult> => ({ outcome: "applied", current: DISABLED }),
    ),
    reconcile: vi.fn(
      async (): Promise<TelegramMutationResult> => ({ outcome: "applied", current: DISABLED }),
    ),
    removeWebhook: vi.fn(
      async (): Promise<TelegramMutationResult> => ({
        outcome: "applied" as const,
        current: {
          ...PAIRED,
          pairing: { state: "unpaired" as const },
          channel: { desiredState: "disabled" as const, state: "disabled" as const },
        },
      }),
    ),
    beginPairing: vi.fn(
      async (): Promise<TelegramMutationResult> => ({
        outcome: "applied" as const,
        current: AWAITING,
      }),
    ),
    cancelPairing: vi.fn(
      async (): Promise<TelegramMutationResult> => ({
        outcome: "applied" as const,
        current: {
          ...PAIRED,
          pairing: { state: "unpaired" as const },
          channel: { desiredState: "disabled" as const, state: "disabled" as const },
        },
      }),
    ),
    acknowledgeGapWarning: vi.fn(
      async (): Promise<TelegramMutationResult> => ({ outcome: "applied", current: PAIRED }),
    ),
    listAllowedSenders: vi.fn(async (): Promise<TelegramAllowedSenders> => SENDERS),
    addAllowedSender: vi.fn(
      async (): Promise<TelegramAllowedSendersMutationResult> => ({
        outcome: "applied",
        current: {
          senders: [...SENDERS.senders, { senderId: 202, role: "additional" }],
        },
      }),
    ),
    removeAllowedSender: vi.fn(
      async (): Promise<TelegramAllowedSendersMutationResult> => ({
        outcome: "applied",
        current: SENDERS,
      }),
    ),
  } satisfies TelegramSettingsBridge;
  const view: TelegramSettingsView = {
    bind: (next) => {
      handlers = next;
    },
    close: vi.fn(),
    render: (state) => states.push(state),
    dispose: vi.fn(),
  };
  const clearInterval = vi.fn();
  const controller = createTelegramSettingsController({
    bridge,
    beginMutation: () => release,
    view,
    pollIntervalMs: 10,
    setInterval: ((callback: () => void) => {
      poll = callback;
      return 17;
    }) as never,
    clearInterval: clearInterval as never,
  });
  return {
    bridge,
    clearInterval,
    controller,
    get handlers() {
      return handlers;
    },
    get poll() {
      return poll;
    },
    release,
    states,
    view,
  };
}

async function beginPairing(runtime: ReturnType<typeof setup>): Promise<void> {
  runtime.handlers.onBeginPairing();
  await vi.waitFor(() =>
    expect(runtime.controller.state()).toMatchObject({
      telegram: { pairing: { state: "awaiting-code" } },
    }),
  );
}

describe("Telegram settings controller", () => {
  it("loads redacted status and polls only while active", async () => {
    const runtime = setup();
    await runtime.controller.activate();
    expect(runtime.controller.state()).toMatchObject({ status: "ready", telegram: DISABLED });

    runtime.bridge.status.mockResolvedValueOnce(PAIRED);
    runtime.poll?.();
    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({
        status: "ready",
        telegram: { channel: { state: "online" } },
        allowedSenders: SENDERS,
      }),
    );

    runtime.controller.close();
    expect(runtime.clearInterval).toHaveBeenCalledWith(17);
    expect(runtime.controller.state()).toEqual({ status: "closed" });
  });

  it("clears stale load-error feedback when background polling recovers", async () => {
    const runtime = setup();
    runtime.bridge.status.mockRejectedValueOnce(new TypeError());

    await runtime.controller.activate();

    expect(runtime.controller.state()).toMatchObject({
      status: "error",
      kind: "load",
      announcement: "Telegram settings aren’t available. Keep the app open and try again.",
      feedback: {
        tone: "error",
        message: "Telegram settings aren’t available. Keep the app open and try again.",
      },
    });

    runtime.bridge.status.mockResolvedValueOnce(PAIRED);
    runtime.poll?.();

    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({
        status: "ready",
        telegram: PAIRED,
        announcement: "",
        feedback: null,
      }),
    );
  });

  it("shows a sender load failure when a malformed allowed-sender response is rejected", async () => {
    const runtime = setup();
    runtime.bridge.status.mockResolvedValueOnce(PAIRED);
    runtime.bridge.listAllowedSenders.mockRejectedValueOnce(new TypeError());

    await runtime.controller.activate();

    expect(runtime.controller.state()).toMatchObject({
      status: "ready",
      telegram: PAIRED,
      allowedSenders: null,
      senderLoadFailed: true,
    });
  });

  it("captures a token without an argument and releases the shared mutation lock", async () => {
    const runtime = setup();
    await runtime.controller.activate();

    runtime.handlers.onPasteToken();

    await vi.waitFor(() => expect(runtime.bridge.pasteTokenFromClipboard).toHaveBeenCalledWith());
    await vi.waitFor(() => expect(runtime.release).toHaveBeenCalledOnce());
    expect(runtime.controller.state()).toMatchObject({
      status: "ready",
      telegram: { credentialConfigured: true, bot: { username: "synthetic_bot" } },
    });
  });

  it("announces a fresh clipboard connection with the connected bot", async () => {
    const runtime = setup();
    await runtime.controller.activate();

    runtime.handlers.onPasteToken();

    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({
        status: "ready",
        telegram: { credentialConfigured: true, bot: { username: "synthetic_bot" } },
        announcement: "Telegram connected to @synthetic_bot. Pairing needs to be set up.",
        feedback: {
          tone: "success",
          message: "Telegram connected to @synthetic_bot. Pairing needs to be set up.",
        },
      }),
    );
  });

  it("guides first-time webhook removal without asking for another reconnect", async () => {
    const runtime = setup();
    await runtime.controller.activate();
    const webhookRequired = {
      ...DISABLED,
      bot: { state: "webhook-removal-required" as const, username: "synthetic_bot" },
      credentialConfigured: true,
    };
    runtime.bridge.pasteTokenFromClipboard.mockResolvedValueOnce({
      outcome: "refused",
      reason: "webhook-removal-required",
      current: webhookRequired,
    });

    runtime.handlers.onPasteToken();

    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({
        telegram: webhookRequired,
        feedback: {
          tone: "error",
          message:
            "The copied bot still uses a webhook. Remove the webhook before pairing it with this Mac.",
        },
      }),
    );
  });

  it("gives actionable Keychain recovery when secure storage is unavailable during setup", async () => {
    const runtime = setup();
    await runtime.controller.activate();
    runtime.bridge.pasteTokenFromClipboard.mockResolvedValueOnce({
      outcome: "refused",
      reason: "encryption-unavailable",
      current: DISABLED,
    });

    runtime.handlers.onPasteToken();

    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({
        telegram: DISABLED,
        feedback: {
          tone: "error",
          message:
            "Secure token storage is unavailable. Quit and reopen Enduragent, unlock your login keychain, copy the bot token again, then retry.",
        },
      }),
    );
  });

  it("refuses plaintext token storage without mislabeling it as a Keychain approval problem", async () => {
    const runtime = setup();
    await runtime.controller.activate();
    runtime.bridge.pasteTokenFromClipboard.mockResolvedValueOnce({
      outcome: "refused",
      reason: "unsafe-backend",
      current: DISABLED,
    });

    runtime.handlers.onPasteToken();

    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({
        telegram: DISABLED,
        feedback: {
          tone: "error",
          message:
            "No secure credential backend is available, so Enduragent refused to save the bot token without encryption. Quit and reopen Enduragent, copy the bot token again, then retry.",
        },
      }),
    );
    expect(JSON.stringify(runtime.controller.state())).not.toContain("Keychain");
  });

  it("directs a rejected saved token through delete and reconnect", async () => {
    const runtime = setup();
    runtime.bridge.status.mockResolvedValueOnce({
      ...PAIRED,
      channel: { desiredState: "enabled", state: "invalid-token" },
    });

    await runtime.controller.activate();

    expect(runtime.controller.state()).toMatchObject({
      status: "ready",
      telegram: { channel: { state: "invalid-token" } },
      announcement:
        "Telegram rejected this token. Delete the connection, then connect a new bot with a fresh token from BotFather.",
    });
  });

  it("deletes the Telegram connection with delete vocabulary", async () => {
    const runtime = setup();
    runtime.bridge.status.mockResolvedValueOnce(PAIRED);
    await runtime.controller.activate();

    runtime.handlers.onRemove();

    expect(runtime.states.at(-1)).toMatchObject({
      status: "working",
      operation: "remove",
      announcement: "Deleting the Telegram connection…",
      feedback: { tone: "status", message: "Deleting the Telegram connection…" },
    });
    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({
        status: "ready",
        telegram: DISABLED,
        announcement: "Telegram connection deleted from this Mac.",
        feedback: {
          tone: "success",
          message: "Telegram connection deleted from this Mac.",
        },
      }),
    );
    expect(runtime.bridge.remove).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "control-uncertain",
      "Telegram connection deletion may not have completed. Restart Enduragent and check whether the bot is still connected before trying again.",
    ],
    [
      "storage-uncertain",
      "Telegram connection deletion could not be confirmed because secure storage could not be verified. Restart Enduragent and check Telegram before trying again.",
    ],
  ] as const)("reports %s deletion uncertainty", async (reason, message) => {
    const runtime = setup();
    runtime.bridge.status.mockResolvedValueOnce(PAIRED);
    await runtime.controller.activate();
    runtime.bridge.remove.mockResolvedValueOnce({ outcome: "uncertain", reason, current: PAIRED });

    runtime.handlers.onRemove();

    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({
        status: "ready",
        telegram: PAIRED,
        feedback: { tone: "warning", message },
      }),
    );
  });

  it("keeps the connected bot online while reporting a refused clipboard token", async () => {
    const runtime = setup();
    runtime.bridge.status.mockResolvedValueOnce(PAIRED);
    await runtime.controller.activate();
    runtime.bridge.pasteTokenFromClipboard.mockResolvedValueOnce({
      outcome: "refused",
      reason: "invalid-token",
      current: PAIRED,
    });

    runtime.handlers.onPasteToken();

    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({
        status: "ready",
        telegram: { channel: { state: "online" } },
        feedback: {
          tone: "error",
          message: "Telegram rejected the copied token. The current Telegram bot is unchanged.",
        },
      }),
    );

    runtime.bridge.status.mockResolvedValueOnce(PAIRED);
    runtime.poll?.();
    await vi.waitFor(() => expect(runtime.bridge.status).toHaveBeenCalledTimes(2));
    expect(runtime.controller.state()).toMatchObject({
      telegram: { channel: { state: "online" } },
      feedback: {
        tone: "error",
        message: "Telegram rejected the copied token. The current Telegram bot is unchanged.",
      },
    });
  });

  it("announces only real health transitions while preserving action feedback", async () => {
    const runtime = setup();
    runtime.bridge.status.mockResolvedValueOnce(OFFLINE);
    await runtime.controller.activate();
    runtime.bridge.pasteTokenFromClipboard.mockResolvedValueOnce({
      outcome: "refused",
      reason: "invalid-token",
      current: OFFLINE,
    });
    runtime.handlers.onPasteToken();
    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({
        feedback: { tone: "error" },
      }),
    );

    runtime.bridge.status.mockResolvedValueOnce(PAIRED);
    runtime.poll?.();
    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({
        telegram: { channel: { state: "online" } },
        healthAnnouncement: "Telegram is online.",
        feedback: {
          tone: "error",
          message: "Telegram rejected the copied token. The current Telegram bot is unchanged.",
        },
      }),
    );

    runtime.bridge.status.mockResolvedValueOnce(PAIRED);
    runtime.poll?.();
    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({ healthAnnouncement: "" }),
    );
    expect(runtime.controller.state()).toMatchObject({ feedback: { tone: "error" } });
  });

  it("clears successful action feedback when channel truth changes", async () => {
    const runtime = setup();
    runtime.bridge.status.mockResolvedValueOnce(PAIRED);
    await runtime.controller.activate();
    runtime.handlers.onEnable();
    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({
        feedback: { tone: "success", message: "Telegram is online." },
      }),
    );

    runtime.bridge.status.mockResolvedValueOnce(OFFLINE);
    runtime.poll?.();

    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({
        telegram: { channel: { state: "offline-retrying" } },
        announcement: "",
        healthAnnouncement:
          "Telegram is offline. Enduragent will keep trying while this Mac is awake and online.",
        feedback: null,
      }),
    );
  });

  it("reports uncertain clipboard-token storage without claiming refusal", async () => {
    const runtime = setup();
    runtime.bridge.status.mockResolvedValueOnce(PAIRED);
    await runtime.controller.activate();
    runtime.bridge.pasteTokenFromClipboard.mockResolvedValueOnce({
      outcome: "uncertain",
      reason: "storage-uncertain",
      current: PAIRED,
    });

    runtime.handlers.onPasteToken();

    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({
        status: "ready",
        telegram: { channel: { state: "online" } },
        feedback: {
          tone: "warning",
          message:
            "The copied token was not applied because secure storage could not be verified. The current Telegram bot is unchanged. Restart Enduragent and check Telegram before trying again.",
        },
      }),
    );
  });

  it("uses neutral copy when a clipboard-token connection cannot be confirmed", async () => {
    const runtime = setup();
    runtime.bridge.status.mockResolvedValueOnce(PAIRED);
    await runtime.controller.activate();
    runtime.bridge.pasteTokenFromClipboard.mockResolvedValueOnce({
      outcome: "uncertain",
      reason: "control-uncertain",
      current: PAIRED,
    });

    runtime.handlers.onPasteToken();

    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({
        telegram: { channel: { state: "online" } },
        feedback: {
          tone: "warning",
          message:
            "The Telegram connection may have started, but Enduragent could not confirm whether it finished. Restart Enduragent and check Telegram before trying again.",
        },
      }),
    );
    expect(JSON.stringify(runtime.controller.state())).not.toContain("was not applied");
  });

  it("preserves uncertain clipboard-token warnings across health transitions", async () => {
    const runtime = setup();
    runtime.bridge.status.mockResolvedValueOnce(PAIRED);
    await runtime.controller.activate();
    runtime.bridge.pasteTokenFromClipboard.mockResolvedValueOnce({
      outcome: "uncertain",
      reason: "storage-uncertain",
      current: PAIRED,
    });
    runtime.handlers.onPasteToken();
    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({ feedback: { tone: "warning" } }),
    );

    runtime.bridge.status.mockResolvedValueOnce(OFFLINE);
    runtime.poll?.();

    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({
        telegram: { channel: { state: "offline-retrying" } },
        healthAnnouncement:
          "Telegram is offline. Enduragent will keep trying while this Mac is awake and online.",
        feedback: {
          tone: "warning",
          message:
            "The copied token was not applied because secure storage could not be verified. The current Telegram bot is unchanged. Restart Enduragent and check Telegram before trying again.",
        },
      }),
    );
  });

  it.each([
    ["clipboard-unavailable", "The clipboard could not be read. No Telegram token was used."],
    [
      "clipboard-clear-failed",
      "The clipboard could not be cleared, so the copied token was not used. The current Telegram bot is unchanged.",
    ],
    [
      "invalid-token-format",
      "The clipboard does not contain a valid Telegram bot token. The current Telegram bot is unchanged.",
    ],
    [
      "validation-unavailable",
      "Telegram could not verify the copied token right now. The current Telegram bot is unchanged.",
    ],
    [
      "webhook-removal-required",
      "The copied bot still uses a webhook. Remove the webhook, then delete the current connection and connect this bot.",
    ],
    [
      "encryption-unavailable",
      "The current Telegram bot is unchanged because secure token storage is unavailable. Quit and reopen Enduragent, unlock your login keychain, copy the bot token again, then retry.",
    ],
    [
      "unsafe-backend",
      "The current Telegram bot is unchanged because no secure credential backend is available. Enduragent refused to save the copied token without encryption. Quit and reopen Enduragent, copy the bot token again, then retry.",
    ],
  ] as const)("reports %s without changing the connected bot", async (reason, message) => {
    const runtime = setup();
    runtime.bridge.status.mockResolvedValueOnce(PAIRED);
    await runtime.controller.activate();
    runtime.bridge.pasteTokenFromClipboard.mockResolvedValueOnce({
      outcome: "refused",
      reason,
      current: PAIRED,
    });

    runtime.handlers.onPasteToken();

    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({
        telegram: PAIRED,
        feedback: { tone: "error", message },
      }),
    );
  });

  it.each([
    [
      {
        ...DISABLED,
        bot: { state: "ready" as const, username: "connected_bot" },
        credentialConfigured: true,
      },
      "Telegram connected to @connected_bot. Pairing needs to be set up.",
    ],
    [DISABLED, "Telegram connection deleted from this Mac."],
  ])(
    "invalidates pairing instructions when the bot is deleted or reconnected",
    async (next, message) => {
      const runtime = setup();
      await runtime.controller.activate();
      await beginPairing(runtime);

      runtime.bridge.status.mockResolvedValueOnce(next);
      runtime.poll?.();

      await vi.waitFor(() =>
        expect(runtime.controller.state()).toMatchObject({
          telegram: next,
          healthAnnouncement: message,
          feedback: null,
        }),
      );
    },
  );

  it.each([
    [
      "reconcile" as const,
      "encryption-unavailable" as const,
      "Secure token storage is unavailable. Quit and reopen Enduragent, unlock your login keychain, then choose Check again.",
    ],
    [
      "remove-webhook" as const,
      "unsafe-backend" as const,
      "No secure credential backend is available, so Enduragent refused to access the saved bot token without encryption. Quit and reopen Enduragent, then choose Check again.",
    ],
  ])("gives %s an actionable %s recovery", async (action, reason, message) => {
    const runtime = setup();
    runtime.bridge.status.mockResolvedValueOnce(PAIRED);
    await runtime.controller.activate();
    const result = { outcome: "refused", reason, current: PAIRED } as const;
    if (action === "reconcile") {
      runtime.bridge.reconcile.mockResolvedValueOnce(result);
      runtime.handlers.onReconcile();
    } else {
      runtime.bridge.removeWebhook.mockResolvedValueOnce(result);
      runtime.handlers.onRemoveWebhook();
    }

    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({
        telegram: PAIRED,
        feedback: { tone: "error", message },
      }),
    );
  });

  it("publishes the short-lived pairing code and manages additional senders", async () => {
    const runtime = setup();
    runtime.bridge.status.mockResolvedValueOnce(PAIRED);
    await runtime.controller.activate();

    await beginPairing(runtime);
    expect(runtime.controller.state()).toMatchObject({
      status: "ready",
      telegram: { pairing: { state: "awaiting-code", code: "A1B2C3" } },
    });

    runtime.handlers.onAddSender(202);
    await vi.waitFor(() => expect(runtime.bridge.addAllowedSender).toHaveBeenCalledWith(202));
    expect(runtime.controller.state()).toMatchObject({
      status: "ready",
      allowedSenders: { senders: [{ senderId: 101 }, { senderId: 202 }] },
    });
  });

  it("replaces pairing instructions when the primary user claims the bot", async () => {
    const runtime = setup();
    await runtime.controller.activate();
    await beginPairing(runtime);
    expect(runtime.controller.state()).toMatchObject({
      feedback: {
        tone: "success",
        message: "Pairing code ready. Send it to the bot in Telegram.",
      },
    });

    runtime.bridge.status.mockResolvedValueOnce(PAIRED);
    runtime.poll?.();

    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({
        telegram: { pairing: { state: "paired" } },
        announcement: "",
        healthAnnouncement: "Telegram is paired with its primary user.",
        feedback: null,
      }),
    );

    runtime.bridge.status.mockResolvedValueOnce(PAIRED);
    runtime.poll?.();

    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({
        telegram: { pairing: { state: "paired" } },
        healthAnnouncement: "",
        feedback: null,
      }),
    );
  });

  it("keeps the current pairing instruction through recoverable channel transitions", async () => {
    const runtime = setup();
    await runtime.controller.activate();
    await beginPairing(runtime);

    for (const [state, healthAnnouncement] of [
      ["online", "Telegram is online."],
      [
        "offline-retrying",
        "Telegram is offline. Enduragent will keep trying while this Mac is awake and online.",
      ],
      ["suspended", "Telegram polling is paused while this Mac sleeps."],
    ] as const) {
      runtime.bridge.status.mockResolvedValueOnce({
        ...AWAITING,
        channel: { desiredState: "enabled", state },
      });
      runtime.poll?.();
      await vi.waitFor(() =>
        expect(runtime.controller.state()).toMatchObject({
          telegram: { channel: { state }, pairing: { state: "awaiting-code" } },
          healthAnnouncement,
          feedback: {
            tone: "success",
            message: "Pairing code ready. Send it to the bot in Telegram.",
          },
        }),
      );
    }
  });

  it("announces a replacement pairing code once", async () => {
    const runtime = setup();
    await runtime.controller.activate();
    await beginPairing(runtime);
    const replacement = {
      ...AWAITING,
      pairing: {
        state: "awaiting-code" as const,
        code: "D4E5F6",
        expiresAt: "1998-07-06T12:02:00.000Z",
      },
    };

    runtime.bridge.status.mockResolvedValueOnce(replacement);
    runtime.poll?.();

    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({
        telegram: { pairing: { state: "awaiting-code", code: "D4E5F6" } },
        announcement: "",
        healthAnnouncement: "A new Telegram pairing code is ready. Send it to the bot in Telegram.",
        feedback: null,
      }),
    );

    runtime.bridge.status.mockResolvedValueOnce(replacement);
    runtime.poll?.();
    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({ healthAnnouncement: "" }),
    );
  });

  it("reports channel truth instead of an unusable replacement code from polling", async () => {
    const runtime = setup();
    await runtime.controller.activate();
    await beginPairing(runtime);
    const conflictedReplacement = {
      ...AWAITING,
      channel: { desiredState: "enabled" as const, state: "conflict" as const },
      pairing: {
        state: "awaiting-code" as const,
        code: "D4E5F6",
        expiresAt: "1998-07-06T12:02:00.000Z",
      },
    };

    runtime.bridge.status.mockResolvedValueOnce(conflictedReplacement);
    runtime.poll?.();

    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({
        telegram: conflictedReplacement,
        announcement: "",
        healthAnnouncement:
          "Another service is polling this bot. Stop that deployment, then check again.",
        feedback: null,
      }),
    );
    expect(JSON.stringify(runtime.controller.state())).not.toContain(
      "A new Telegram pairing code is ready",
    );
  });

  it("reports channel truth instead of an action-returned unusable replacement code", async () => {
    const runtime = setup();
    await runtime.controller.activate();
    await beginPairing(runtime);
    const conflictedReplacement = {
      ...AWAITING,
      channel: { desiredState: "enabled" as const, state: "conflict" as const },
      pairing: {
        state: "awaiting-code" as const,
        code: "D4E5F6",
        expiresAt: "1998-07-06T12:02:00.000Z",
      },
    };
    runtime.bridge.reconcile.mockResolvedValueOnce({
      outcome: "applied",
      current: conflictedReplacement,
    });

    runtime.handlers.onReconcile();

    const message = "Another service is polling this bot. Stop that deployment, then check again.";
    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({
        telegram: conflictedReplacement,
        announcement: message,
        healthAnnouncement: "",
        feedback: { tone: "success", message },
      }),
    );
    expect(JSON.stringify(runtime.controller.state())).not.toContain(
      "A new Telegram pairing code is ready",
    );
  });

  it.each([
    [
      "disabled intent",
      { ...AWAITING, channel: { desiredState: "disabled" as const, state: "disabled" as const } },
      "Telegram is off.",
    ],
    [
      "failed channel",
      { ...AWAITING, channel: { desiredState: "enabled" as const, state: "failed" as const } },
      "Telegram needs attention. Keep the app open, check the connection, and try again.",
    ],
    [
      "polling conflict",
      { ...AWAITING, channel: { desiredState: "enabled" as const, state: "conflict" as const } },
      "Another service is polling this bot. Stop that deployment, then check again.",
    ],
    [
      "transfer requirement",
      {
        ...AWAITING,
        channel: { desiredState: "enabled" as const, state: "transfer-required" as const },
      },
      "This bot is still owned by another Desktop installation. Delete the connection there before connecting it here.",
    ],
    ["missing credential", { ...AWAITING, credentialConfigured: false }, ""],
  ])("removes pairing instructions after %s", async (_reason, next, healthAnnouncement) => {
    const runtime = setup();
    await runtime.controller.activate();
    await beginPairing(runtime);

    runtime.bridge.status.mockResolvedValueOnce(next);
    runtime.poll?.();

    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({
        telegram: next,
        announcement: "",
        healthAnnouncement,
        feedback: null,
      }),
    );
  });

  it.each([
    [
      "expired",
      { state: "expired" as const },
      "The pairing code expired before it was used. Create a new code when you are ready.",
    ],
    [
      "unavailable",
      { state: "failed" as const, errorCode: "telegram-pairing-unavailable" as const },
      "Pairing is unavailable until the Telegram bot can connect.",
    ],
    [
      "refused",
      { state: "failed" as const, errorCode: "telegram-pairing-refused" as const },
      "Pairing was refused because this bot already has a primary user.",
    ],
    [
      "storage failed",
      { state: "failed" as const, errorCode: "telegram-pairing-storage-failed" as const },
      "The primary Telegram user could not be saved. Check local disk access and try pairing again.",
    ],
    [
      "storage uncertain",
      { state: "failed" as const, errorCode: "telegram-pairing-storage-uncertain" as const },
      "The primary Telegram user may have been saved, but Enduragent could not verify storage. Restart Enduragent and check Telegram before pairing again.",
    ],
    ["unpaired", { state: "unpaired" as const }, "Telegram pairing was cancelled."],
  ])("replaces pairing instructions when pairing becomes %s", async (_state, pairing, message) => {
    const runtime = setup();
    await runtime.controller.activate();
    await beginPairing(runtime);

    runtime.bridge.status.mockResolvedValueOnce({
      ...PAIRED,
      channel: { desiredState: "enabled", state: "starting" },
      pairing,
    });
    runtime.poll?.();

    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({
        telegram: { pairing },
        healthAnnouncement: message,
        feedback: null,
      }),
    );
  });

  it.each([
    ["paired", PAIRED, "Telegram is paired with its primary user."],
    [
      "expired",
      { ...AWAITING, pairing: { state: "expired" as const } },
      "The pairing code expired before it was used. Create a new code when you are ready.",
    ],
    [
      "failed",
      {
        ...AWAITING,
        pairing: { state: "failed" as const, errorCode: "telegram-pairing-refused" as const },
      },
      "Pairing was refused because this bot already has a primary user.",
    ],
    [
      "unpaired",
      { ...AWAITING, pairing: { state: "unpaired" as const } },
      "Telegram pairing was cancelled.",
    ],
    [
      "new bot connection",
      {
        ...DISABLED,
        bot: { state: "ready" as const, username: "connected_bot" },
        credentialConfigured: true,
      },
      "Telegram connected to @connected_bot. Pairing needs to be set up.",
    ],
  ])("announces an action-returned %s transition once", async (_transition, next, message) => {
    const runtime = setup();
    await runtime.controller.activate();
    await beginPairing(runtime);
    runtime.bridge.reconcile.mockResolvedValueOnce({ outcome: "applied", current: next });

    runtime.handlers.onReconcile();

    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({
        telegram: next,
        announcement: message,
        healthAnnouncement: "",
        feedback: { tone: "success", message },
      }),
    );

    runtime.bridge.status.mockResolvedValueOnce(next);
    runtime.poll?.();
    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({
        healthAnnouncement: "",
        feedback: { message },
      }),
    );
  });

  it("warns that a primary claim may have committed when pairing storage is uncertain", async () => {
    const runtime = setup();
    await runtime.controller.activate();
    runtime.bridge.beginPairing.mockResolvedValueOnce({
      outcome: "uncertain",
      reason: "storage-uncertain",
      current: {
        ...PAIRED,
        channel: { desiredState: "disabled", state: "disabled" },
        pairing: { state: "failed", errorCode: "telegram-pairing-storage-uncertain" },
      },
    });

    runtime.handlers.onBeginPairing();

    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({
        status: "ready",
        telegram: {
          pairing: { state: "failed", errorCode: "telegram-pairing-storage-uncertain" },
        },
        feedback: {
          tone: "warning",
          message:
            "The primary Telegram user may have been saved, but Enduragent could not verify storage. Restart Enduragent and check Telegram before pairing again.",
        },
      }),
    );
  });

  it.each([
    [
      "add",
      "storage-uncertain",
      "The allowed-user list may have changed, but Enduragent could not verify storage. Restart Enduragent and check the list before trying again.",
    ],
    [
      "remove",
      "control-uncertain",
      "The allowed-user list may have changed, but Enduragent lost confirmation from the local coaching service. Restart Enduragent and check the list before trying again.",
    ],
  ] as const)(
    "warns without projecting an untrusted sender list when %s is %s",
    async (operation, reason, message) => {
      const runtime = setup();
      runtime.bridge.status.mockResolvedValueOnce(PAIRED);
      await runtime.controller.activate();
      const previous = runtime.controller.state();
      const mutation =
        operation === "add" ? runtime.bridge.addAllowedSender : runtime.bridge.removeAllowedSender;
      mutation.mockResolvedValueOnce({
        outcome: "uncertain",
        reason,
      });

      if (operation === "add") runtime.handlers.onAddSender(202);
      else runtime.handlers.onRemoveSender(202);

      await vi.waitFor(() =>
        expect(runtime.controller.state()).toMatchObject({
          status: "ready",
          allowedSenders: "allowedSenders" in previous ? previous.allowedSenders : undefined,
          feedback: {
            tone: "warning",
            message,
          },
        }),
      );
      expect(runtime.controller.state()).not.toMatchObject({ status: "error" });
    },
  );

  it("renders a definite sender refusal as an error without replacing the trusted list", async () => {
    const runtime = setup();
    runtime.bridge.status.mockResolvedValueOnce(PAIRED);
    await runtime.controller.activate();
    const previous = runtime.controller.state();
    runtime.bridge.addAllowedSender.mockResolvedValueOnce({
      outcome: "refused",
      reason: "invalid-state",
    });

    runtime.handlers.onAddSender(202);

    await vi.waitFor(() =>
      expect(runtime.controller.state()).toMatchObject({
        status: "ready",
        allowedSenders: "allowedSenders" in previous ? previous.allowedSenders : undefined,
        feedback: {
          tone: "error",
          message: "The allowed-user list could not be changed. Check the user ID and try again.",
        },
      }),
    );
  });

  it("acknowledges the durable delivery-gap warning", async () => {
    const runtime = setup();
    runtime.bridge.status.mockResolvedValueOnce({
      ...PAIRED,
      gapWarning: {
        state: "possible-message-loss",
        detectedAt: "1998-07-06T12:00:00.000Z",
      },
    });
    await runtime.controller.activate();

    runtime.handlers.onAcknowledgeGapWarning();

    await vi.waitFor(() => expect(runtime.bridge.acknowledgeGapWarning).toHaveBeenCalledWith());
    expect(runtime.controller.state()).toMatchObject({
      status: "ready",
      telegram: { gapWarning: { state: "clear" } },
    });
  });

  it("fences a late poll result after close", async () => {
    const runtime = setup();
    await runtime.controller.activate();
    let resolve!: (status: TelegramControlStatus) => void;
    runtime.bridge.status.mockReturnValueOnce(
      new Promise<TelegramControlStatus>((resolveStatus) => {
        resolve = resolveStatus;
      }),
    );
    runtime.poll?.();
    runtime.controller.close();
    resolve(PAIRED);
    await Promise.resolve();
    await Promise.resolve();
    expect(runtime.controller.state()).toEqual({ status: "closed" });
  });

  it("starts a fresh load when reopened before the previous load settles", async () => {
    const runtime = setup();
    let resolveFirst!: (status: TelegramControlStatus) => void;
    runtime.bridge.status
      .mockReturnValueOnce(
        new Promise<TelegramControlStatus>((resolveStatus) => {
          resolveFirst = resolveStatus;
        }),
      )
      .mockResolvedValueOnce(PAIRED);

    const firstOpen = runtime.controller.activate();
    runtime.controller.close();
    const secondOpen = runtime.controller.activate();
    resolveFirst(DISABLED);

    await firstOpen;
    await secondOpen;
    expect(runtime.bridge.status).toHaveBeenCalledTimes(2);
    expect(runtime.controller.state()).toMatchObject({
      status: "ready",
      telegram: { credentialConfigured: true },
    });
  });
});
