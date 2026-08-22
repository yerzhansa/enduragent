import {
  AthleteHomeIdentitySchema,
  TelegramBotIdSchema,
  TelegramBotUsernameSchema,
  type TelegramAllowedSendersResult,
} from "@enduragent/coach-contract";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DESKTOP_TELEGRAM_ADD_ALLOWED_SENDER_CHANNEL,
  DESKTOP_TELEGRAM_ACKNOWLEDGE_GAP_WARNING_CHANNEL,
  DESKTOP_TELEGRAM_BEGIN_PAIRING_CHANNEL,
  DESKTOP_TELEGRAM_CANCEL_PAIRING_CHANNEL,
  DESKTOP_TELEGRAM_DISABLE_CHANNEL,
  DESKTOP_TELEGRAM_ENABLE_CHANNEL,
  DESKTOP_TELEGRAM_LIST_ALLOWED_SENDERS_CHANNEL,
  DESKTOP_TELEGRAM_PASTE_CREDENTIAL_CHANNEL,
  DESKTOP_TELEGRAM_RECONCILE_CHANNEL,
  DESKTOP_TELEGRAM_REMOVE_ALLOWED_SENDER_CHANNEL,
  DESKTOP_TELEGRAM_REMOVE_CHANNEL,
  DESKTOP_TELEGRAM_REMOVE_WEBHOOK_CHANNEL,
  DESKTOP_TELEGRAM_STATUS_CHANNEL,
} from "../src/main/constants.js";
import type {
  DesktopTelegramMutationResult,
  DesktopTelegramSnapshot,
  TelegramControlCoordinator,
} from "../src/main/telegram-control.js";
import { installDesktopTelegramIpc } from "../src/main/telegram-ipc.js";
import type { TelegramGapWarning } from "../src/main/telegram-power.js";
import {
  createTelegramCredentialVault,
  type TelegramCredentialVault,
} from "../src/main/telegram-credential-vault.js";

const TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
const USERNAME = "desktop_bot";
const PRIMARY_SENDER = {
  senderId: 12345,
  role: "primary",
  addedAt: "2026-08-03T12:00:00.000Z",
} as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const snapshot = (
  configured: boolean,
  channel: DesktopTelegramSnapshot["channel"] = {
    desiredState: "disabled",
    state: "disabled",
  },
): DesktopTelegramSnapshot => ({
  channel,
  bot: configured ? { state: "ready", username: USERNAME } : { state: "unconfigured" },
  pairing: { state: "unpaired" },
  credentialConfigured: configured,
});

const ipcSnapshot = (configured: boolean, channel?: DesktopTelegramSnapshot["channel"]) => ({
  ...snapshot(configured, channel),
  gapWarning: { state: "clear" } as const,
});

const applied = (current: DesktopTelegramSnapshot): DesktopTelegramMutationResult => ({
  outcome: "applied",
  current,
});

function setup(
  options: {
    readonly trusted?: boolean;
    readonly configured?: boolean;
    readonly vault?: Pick<TelegramCredentialVault, "profileStatus">;
  } = {},
) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const removed: string[] = [];
  const trace: string[] = [];
  let configured = options.configured ?? false;
  const senderList: TelegramAllowedSendersResult = { senders: [PRIMARY_SENDER] };
  const coordinator: TelegramControlCoordinator = {
    status: vi.fn(async () => snapshot(configured)),
    configure: vi.fn(async (token: string) => {
      trace.push(`configure:${token}`);
      configured = true;
      return applied(snapshot(true));
    }),
    replace: vi.fn(async (token: string) => {
      trace.push(`replace:${token}`);
      return applied(snapshot(true));
    }),
    enable: vi.fn(async () =>
      applied(snapshot(true, { desiredState: "enabled", state: "starting" })),
    ),
    disable: vi.fn(async () => applied(snapshot(configured))),
    stopPolling: vi.fn(async () => snapshot(configured)),
    resumePolling: vi.fn(async () => snapshot(configured)),
    remove: vi.fn(async () => {
      configured = false;
      return applied(snapshot(false));
    }),
    resetRuntimeForCredentialReset: vi.fn(async () => true),
    reconcile: vi.fn(async () => applied(snapshot(configured))),
    removeWebhook: vi.fn(async () => applied(snapshot(configured))),
    beginPairing: vi.fn(
      async (): Promise<DesktopTelegramMutationResult> =>
        applied({
          ...snapshot(true, { desiredState: "enabled", state: "starting" }),
          pairing: {
            state: "awaiting-code",
            code: "ABCDEF",
            expiresAt: "2026-08-03T12:01:00.000Z",
          },
        }),
    ),
    cancelPairing: vi.fn(async () => applied(snapshot(configured))),
    listAllowedSenders: vi.fn(async () => senderList),
    addAllowedSender: vi.fn(async ({ senderId }) => ({
      outcome: "applied" as const,
      current: {
        senders: [...senderList.senders, { senderId, role: "additional" as const }],
      },
    })),
    removeAllowedSender: vi.fn(async () => ({ outcome: "applied" as const, current: senderList })),
    close: vi.fn(async () => undefined),
  };
  const vault = {
    profileStatus: vi.fn(async () =>
      options.vault === undefined
        ? configured
          ? {
              state: "configured" as const,
              profileId: "00000000-0000-4000-8000-000000000001",
              bot: { id: 10001, username: USERNAME },
            }
          : { state: "missing" as const }
        : options.vault.profileStatus(),
    ),
  } satisfies Pick<TelegramCredentialVault, "profileStatus">;
  const clipboard = {
    readText: vi.fn(() => {
      trace.push("read");
      return `  ${TOKEN}  `;
    }),
    clear: vi.fn(() => {
      trace.push("clear");
    }),
  };
  const power = {
    warning: vi.fn(async (): Promise<TelegramGapWarning> => ({ state: "clear" })),
    acknowledgeWarning: vi.fn(async (): Promise<TelegramGapWarning> => ({ state: "clear" })),
  };
  const dispose = installDesktopTelegramIpc({
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler as never),
      removeHandler: (channel) => removed.push(channel),
    },
    clipboard,
    coordinator,
    vault,
    power,
    isTrusted: () => options.trusted ?? true,
  });
  const invoke = (channel: string, ...args: unknown[]) =>
    handlers.get(channel)!({ sender: {}, senderFrame: {} }, ...args);
  return { clipboard, coordinator, dispose, handlers, invoke, power, removed, trace, vault };
}

describe("Desktop Telegram IPC", () => {
  it("registers exactly thirteen semantic handlers and removes every one", () => {
    const runtime = setup();
    const channels = [
      DESKTOP_TELEGRAM_STATUS_CHANNEL,
      DESKTOP_TELEGRAM_PASTE_CREDENTIAL_CHANNEL,
      DESKTOP_TELEGRAM_ENABLE_CHANNEL,
      DESKTOP_TELEGRAM_DISABLE_CHANNEL,
      DESKTOP_TELEGRAM_REMOVE_CHANNEL,
      DESKTOP_TELEGRAM_RECONCILE_CHANNEL,
      DESKTOP_TELEGRAM_REMOVE_WEBHOOK_CHANNEL,
      DESKTOP_TELEGRAM_BEGIN_PAIRING_CHANNEL,
      DESKTOP_TELEGRAM_CANCEL_PAIRING_CHANNEL,
      DESKTOP_TELEGRAM_LIST_ALLOWED_SENDERS_CHANNEL,
      DESKTOP_TELEGRAM_ADD_ALLOWED_SENDER_CHANNEL,
      DESKTOP_TELEGRAM_REMOVE_ALLOWED_SENDER_CHANNEL,
      DESKTOP_TELEGRAM_ACKNOWLEDGE_GAP_WARNING_CHANNEL,
    ];

    expect(runtime.handlers.size).toBe(13);
    expect([...runtime.handlers.keys()].sort()).toEqual(channels.sort());

    runtime.dispose();
    expect(runtime.removed.sort()).toEqual([...runtime.handlers.keys()].sort());
  });

  it("fences new requests synchronously and drains an accepted removal before shutdown advances", async () => {
    const runtime = setup({ configured: true });
    const removal = deferred<DesktopTelegramMutationResult>();
    vi.mocked(runtime.coordinator.remove).mockReturnValueOnce(removal.promise);

    const accepted = Promise.resolve(runtime.invoke(DESKTOP_TELEGRAM_REMOVE_CHANNEL));
    await vi.waitFor(() => expect(runtime.coordinator.remove).toHaveBeenCalledOnce());

    const firstClose = runtime.dispose();
    const secondClose = runtime.dispose();
    const daemonClose = vi.fn();
    const exit = vi.fn();
    const shutdown = (async () => {
      await firstClose;
      await runtime.coordinator.close();
      daemonClose();
      exit();
    })();

    expect(secondClose).toBe(firstClose);
    expect(runtime.removed).toHaveLength(runtime.handlers.size);
    expect(() => runtime.invoke(DESKTOP_TELEGRAM_STATUS_CHANNEL)).toThrow(TypeError);
    await Promise.resolve();
    expect(runtime.coordinator.close).not.toHaveBeenCalled();
    expect(daemonClose).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();

    removal.resolve(applied(snapshot(false)));
    await expect(accepted).resolves.toEqual({ outcome: "applied", current: ipcSnapshot(false) });
    await shutdown;

    expect(runtime.coordinator.close).toHaveBeenCalledOnce();
    expect(daemonClose).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });

  it("returns only the strict redacted snapshot shape", async () => {
    const runtime = setup({ configured: true });
    await expect(runtime.invoke(DESKTOP_TELEGRAM_STATUS_CHANNEL)).resolves.toEqual(
      ipcSnapshot(true),
    );

    vi.mocked(runtime.coordinator.status).mockResolvedValueOnce({
      ...snapshot(true),
      token: TOKEN,
      exception: "private daemon detail",
    } as never);
    const closed = await runtime.invoke(DESKTOP_TELEGRAM_STATUS_CHANNEL);

    expect(closed).toEqual({
      channel: {
        desiredState: "disabled",
        state: "failed",
        errorCode: "telegram-control-failed",
      },
      bot: { state: "unconfigured" },
      pairing: { state: "unpaired" },
      credentialConfigured: false,
      gapWarning: { state: "clear" },
    });
    expect(JSON.stringify(closed)).not.toContain(TOKEN);
    expect(JSON.stringify(closed)).not.toContain("private daemon detail");
  });

  it.each([
    "telegram-credential-encryption-unavailable",
    "telegram-credential-unsafe-backend",
  ] as const)("passes through the closed redacted %s status code", async (errorCode) => {
    const runtime = setup();
    const current = snapshot(false, { desiredState: "enabled", state: "failed", errorCode });
    vi.mocked(runtime.coordinator.status).mockResolvedValueOnce(current);

    await expect(runtime.invoke(DESKTOP_TELEGRAM_STATUS_CHANNEL)).resolves.toEqual({
      ...current,
      gapWarning: { state: "clear" },
    });
  });

  it("reads and clears the clipboard synchronously before any credential await", async () => {
    const runtime = setup();

    const pending = runtime.invoke(DESKTOP_TELEGRAM_PASTE_CREDENTIAL_CHANNEL);
    expect(runtime.trace).toEqual(["read", "clear"]);
    expect(runtime.vault.profileStatus).not.toHaveBeenCalled();

    await expect(pending).resolves.toEqual({ outcome: "applied", current: ipcSnapshot(true) });
    expect(runtime.trace).toEqual(["read", "clear", `configure:${TOKEN}`]);
    expect(runtime.coordinator.configure).toHaveBeenCalledWith(TOKEN);
    expect(runtime.coordinator.replace).not.toHaveBeenCalled();
  });

  it("selects replacement only after clipboard capture when a credential exists", async () => {
    const runtime = setup({ configured: true });

    await runtime.invoke(DESKTOP_TELEGRAM_PASTE_CREDENTIAL_CHANNEL);

    expect(runtime.trace).toEqual(["read", "clear", `replace:${TOKEN}`]);
    expect(runtime.coordinator.configure).not.toHaveBeenCalled();
    expect(runtime.coordinator.replace).toHaveBeenCalledWith(TOKEN);
  });

  for (const [run, reason, available, backend] of [
    [it, "encryption-unavailable" as const, false, undefined],
    [it.skipIf(process.platform === "win32"), "unsafe-backend" as const, true, "basic_text"],
  ] as const) {
    run(`routes a reopened real-vault ${reason} paste through replacement`, async () => {
      const base = await mkdtemp(join(await realpath(tmpdir()), "telegram-ipc-secure-storage-"));
      try {
        const homePath = join(base, "athlete-home");
        await mkdir(homePath, { mode: 0o700 });
        const value = {
          root: join(base, "telegram-channel-v1"),
          athleteHome: AthleteHomeIdentitySchema.parse(await realpath(homePath)),
        };
        const encryption = {
          isEncryptionAvailable: () => true,
          encryptString: (plaintext: string) => Buffer.from(plaintext, "utf8").reverse(),
          decryptString: (ciphertext: Buffer) => Buffer.from(ciphertext).reverse().toString("utf8"),
        };
        const seed = createTelegramCredentialVault({ ...value, encryption });
        await expect(
          seed.replaceProfile({
            token: TOKEN,
            bot: {
              id: TelegramBotIdSchema.parse(10001),
              username: TelegramBotUsernameSchema.parse(USERNAME),
            },
            authenticatedAthleteHome: value.athleteHome,
          }),
        ).resolves.toMatchObject({ outcome: "applied" });
        const reopened = createTelegramCredentialVault({
          ...value,
          ...(backend === undefined ? {} : { platform: "linux" as const }),
          encryption: {
            ...encryption,
            isEncryptionAvailable: () => available,
            ...(backend === undefined ? {} : { getSelectedStorageBackend: () => backend }),
          },
        });
        await expect(reopened.profileStatus()).resolves.toEqual({ state: "re-prompt", reason });
        const runtime = setup({ configured: true, vault: reopened });
        vi.mocked(runtime.coordinator.replace).mockResolvedValueOnce({
          outcome: "refused",
          reason,
          current: snapshot(true),
        });

        await expect(runtime.invoke(DESKTOP_TELEGRAM_PASTE_CREDENTIAL_CHANNEL)).resolves.toEqual({
          outcome: "refused",
          reason,
          current: ipcSnapshot(true),
        });
        expect(runtime.coordinator.replace).toHaveBeenCalledWith(TOKEN);
        expect(runtime.coordinator.configure).not.toHaveBeenCalled();
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    });
  }

  it("passes through refused and uncertain credential outcomes without inferring success from health", async () => {
    const refused = setup({ configured: true });
    vi.mocked(refused.coordinator.replace).mockResolvedValueOnce({
      outcome: "refused",
      reason: "invalid-token",
      current: snapshot(true, { desiredState: "enabled", state: "online" }),
    });

    await expect(refused.invoke(DESKTOP_TELEGRAM_PASTE_CREDENTIAL_CHANNEL)).resolves.toEqual({
      outcome: "refused",
      reason: "invalid-token",
      current: ipcSnapshot(true, { desiredState: "enabled", state: "online" }),
    });

    const uncertain = setup({ configured: true });
    vi.mocked(uncertain.coordinator.replace).mockResolvedValueOnce({
      outcome: "uncertain",
      reason: "storage-uncertain",
      current: snapshot(true, { desiredState: "enabled", state: "online" }),
    });

    await expect(uncertain.invoke(DESKTOP_TELEGRAM_PASTE_CREDENTIAL_CHANNEL)).resolves.toEqual({
      outcome: "uncertain",
      reason: "storage-uncertain",
      current: ipcSnapshot(true, { desiredState: "enabled", state: "online" }),
    });

    vi.mocked(uncertain.coordinator.replace).mockResolvedValueOnce({
      outcome: "uncertain",
      reason: "control-uncertain",
      current: snapshot(true, { desiredState: "enabled", state: "online" }),
    });
    await expect(uncertain.invoke(DESKTOP_TELEGRAM_PASTE_CREDENTIAL_CHANNEL)).resolves.toEqual({
      outcome: "uncertain",
      reason: "control-uncertain",
      current: ipcSnapshot(true, { desiredState: "enabled", state: "online" }),
    });
  });

  it.each(["encryption-unavailable", "unsafe-backend"] as const)(
    "passes through the closed %s refusal without credential details",
    async (reason) => {
      const runtime = setup();
      vi.mocked(runtime.coordinator.configure).mockResolvedValueOnce({
        outcome: "refused",
        reason,
        current: snapshot(false),
      });

      const result = await runtime.invoke(DESKTOP_TELEGRAM_PASTE_CREDENTIAL_CHANNEL);

      expect(result).toEqual({
        outcome: "refused",
        reason,
        current: ipcSnapshot(false),
      });
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    },
  );

  it("closes malformed coordinator mutation envelopes instead of copying private fields", async () => {
    const runtime = setup({ configured: true });
    for (const malformed of [
      {
        outcome: "refused",
        reason: "invalid-token",
        current: snapshot(true),
        token: TOKEN,
      },
      {
        outcome: "refused",
        reason: "arbitrary-private-reason",
        current: snapshot(true),
      },
      {
        outcome: "uncertain",
        reason: "storage-uncertain",
        current: { ...snapshot(true), exception: "private daemon detail" },
      },
    ]) {
      vi.mocked(runtime.coordinator.enable).mockResolvedValueOnce(malformed as never);
      const result = await runtime.invoke(DESKTOP_TELEGRAM_ENABLE_CHANNEL);
      expect(result).toEqual({
        outcome: "uncertain",
        reason: "control-uncertain",
        current: ipcSnapshot(true),
      });
      expect(JSON.stringify(result)).not.toContain(TOKEN);
      expect(JSON.stringify(result)).not.toContain("private daemon detail");
    }
  });

  it("refreshes status after a side effect precedes a malformed mutation response", async () => {
    const runtime = setup({ configured: true });
    const refreshed = snapshot(true, { desiredState: "enabled", state: "online" });
    let appliedSideEffect = false;
    vi.mocked(runtime.coordinator.status).mockImplementation(async () =>
      appliedSideEffect ? refreshed : snapshot(true),
    );
    vi.mocked(runtime.coordinator.enable).mockImplementationOnce(async () => {
      appliedSideEffect = true;
      return {
        outcome: "applied",
        current: refreshed,
        privateDetail: TOKEN,
      } as never;
    });

    const result = await runtime.invoke(DESKTOP_TELEGRAM_ENABLE_CHANNEL);

    expect(appliedSideEffect).toBe(true);
    expect(runtime.coordinator.status).toHaveBeenCalledOnce();
    expect(result).toEqual({
      outcome: "uncertain",
      reason: "control-uncertain",
      current: ipcSnapshot(true, { desiredState: "enabled", state: "online" }),
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain("privateDetail");
  });

  it("returns a closed refusal when the clipboard token format is invalid", async () => {
    const runtime = setup({ configured: true });
    for (const candidate of [
      "sk-unrelated-secret",
      "password",
      "bot-id:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi",
      "123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi",
      "123456789:short",
      `123456789:${"A".repeat(34)}`,
      `123456789:${"A".repeat(36)}`,
      "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg+i",
    ]) {
      runtime.clipboard.readText.mockReturnValueOnce(candidate);
      await expect(runtime.invoke(DESKTOP_TELEGRAM_PASTE_CREDENTIAL_CHANNEL)).resolves.toEqual({
        outcome: "refused",
        reason: "invalid-token-format",
        current: ipcSnapshot(true),
      });
    }
    expect(runtime.coordinator.configure).not.toHaveBeenCalled();
    expect(runtime.coordinator.replace).not.toHaveBeenCalled();
  });

  it("closes coordinator and vault rejections without exposing dependency details", async () => {
    const privateDetail = `https://bot.example.invalid/${TOKEN} at /Users/private/id_rsa PRIVATE_KEY`;
    const coordinatorFailure = setup({ configured: true });
    vi.mocked(coordinatorFailure.coordinator.enable).mockRejectedValueOnce(
      new Error(privateDetail),
    );

    const controlResult = await coordinatorFailure.invoke(DESKTOP_TELEGRAM_ENABLE_CHANNEL);
    expect(controlResult).toEqual({
      outcome: "uncertain",
      reason: "control-uncertain",
      current: ipcSnapshot(true),
    });
    expect(JSON.stringify(controlResult)).not.toContain(privateDetail);
    expect(JSON.stringify(controlResult)).not.toContain(TOKEN);

    const vaultFailure = setup({ configured: true });
    vaultFailure.vault.profileStatus.mockRejectedValueOnce(new Error(privateDetail));
    const vaultResult = await vaultFailure.invoke(DESKTOP_TELEGRAM_PASTE_CREDENTIAL_CHANNEL);
    expect(vaultResult).toEqual({
      outcome: "uncertain",
      reason: "storage-uncertain",
      current: {
        channel: {
          desiredState: "disabled",
          state: "failed",
          errorCode: "telegram-control-failed",
        },
        bot: { state: "unconfigured" },
        pairing: { state: "unpaired" },
        credentialConfigured: false,
        gapWarning: { state: "clear" },
      },
    });
    expect(vaultFailure.coordinator.status).not.toHaveBeenCalled();
    expect(vaultFailure.coordinator.configure).not.toHaveBeenCalled();
    expect(vaultFailure.coordinator.replace).not.toHaveBeenCalled();
    expect(JSON.stringify(vaultResult)).not.toContain(privateDetail);
    expect(JSON.stringify(vaultResult)).not.toContain(TOKEN);
  });

  it("does not use clipboard contents when read, validation, or clear fails", async () => {
    const readFailure = setup();
    readFailure.clipboard.readText.mockImplementationOnce(() => {
      readFailure.trace.push("read-failed");
      throw new Error("private clipboard detail");
    });
    await expect(readFailure.invoke(DESKTOP_TELEGRAM_PASTE_CREDENTIAL_CHANNEL)).resolves.toEqual({
      outcome: "refused",
      reason: "clipboard-unavailable",
      current: ipcSnapshot(false),
    });
    expect(readFailure.clipboard.clear).toHaveBeenCalledOnce();

    const invalid = setup({ configured: true });
    invalid.clipboard.readText.mockReturnValueOnce("invalid token with spaces");
    await expect(invalid.invoke(DESKTOP_TELEGRAM_PASTE_CREDENTIAL_CHANNEL)).resolves.toEqual({
      outcome: "refused",
      reason: "invalid-token-format",
      current: ipcSnapshot(true),
    });
    expect(invalid.clipboard.clear).toHaveBeenCalledOnce();

    const clearFailure = setup();
    clearFailure.clipboard.clear.mockImplementationOnce(() => {
      clearFailure.trace.push("clear-failed");
      throw new Error("private clipboard detail");
    });
    await expect(clearFailure.invoke(DESKTOP_TELEGRAM_PASTE_CREDENTIAL_CHANNEL)).resolves.toEqual({
      outcome: "refused",
      reason: "clipboard-clear-failed",
      current: ipcSnapshot(false),
    });

    for (const runtime of [readFailure, invalid, clearFailure]) {
      expect(runtime.coordinator.configure).not.toHaveBeenCalled();
      expect(runtime.coordinator.replace).not.toHaveBeenCalled();
    }
  });

  it("exposes webhook removal, pairing, and ordinary controls as zero-argument operations", async () => {
    const runtime = setup({ configured: true });

    const results = [];
    results.push(await runtime.invoke(DESKTOP_TELEGRAM_REMOVE_WEBHOOK_CHANNEL));
    results.push(await runtime.invoke(DESKTOP_TELEGRAM_BEGIN_PAIRING_CHANNEL));
    results.push(await runtime.invoke(DESKTOP_TELEGRAM_CANCEL_PAIRING_CHANNEL));
    results.push(await runtime.invoke(DESKTOP_TELEGRAM_ENABLE_CHANNEL));
    results.push(await runtime.invoke(DESKTOP_TELEGRAM_DISABLE_CHANNEL));
    results.push(await runtime.invoke(DESKTOP_TELEGRAM_REMOVE_CHANNEL));
    results.push(await runtime.invoke(DESKTOP_TELEGRAM_RECONCILE_CHANNEL));
    results.push(await runtime.invoke(DESKTOP_TELEGRAM_ACKNOWLEDGE_GAP_WARNING_CHANNEL));

    for (const result of results) {
      expect(result).toMatchObject({
        outcome: "applied",
        current: { gapWarning: { state: "clear" } },
      });
    }

    expect(runtime.coordinator.removeWebhook).toHaveBeenCalledWith();
    expect(runtime.coordinator.beginPairing).toHaveBeenCalledWith();
    expect(runtime.coordinator.cancelPairing).toHaveBeenCalledWith();
    expect(runtime.coordinator.enable).toHaveBeenCalledWith();
    expect(runtime.coordinator.disable).toHaveBeenCalledWith();
    expect(runtime.coordinator.remove).toHaveBeenCalledWith();
    expect(runtime.coordinator.reconcile).toHaveBeenCalledWith();
    expect(runtime.power.acknowledgeWarning).toHaveBeenCalledWith();
    expect(() => runtime.invoke(DESKTOP_TELEGRAM_REMOVE_WEBHOOK_CHANNEL, {})).toThrow(TypeError);
    expect(() => runtime.invoke(DESKTOP_TELEGRAM_ACKNOWLEDGE_GAP_WARNING_CHANNEL, {})).toThrow(
      TypeError,
    );
  });

  it("projects the durable gap warning without exposing additional fields", async () => {
    const runtime = setup({ configured: true });
    runtime.power.warning.mockResolvedValueOnce({
      state: "possible-message-loss",
      detectedAt: "2026-08-03T12:00:00.000Z",
    });

    await expect(runtime.invoke(DESKTOP_TELEGRAM_STATUS_CHANNEL)).resolves.toEqual({
      ...snapshot(true),
      gapWarning: {
        state: "possible-message-loss",
        detectedAt: "2026-08-03T12:00:00.000Z",
      },
    });
  });

  it("closes gap-warning persistence and status rejections without exposing details", async () => {
    const privateDetail = `https://bot.example.invalid/${TOKEN} at /Users/private/power.json`;
    const persistenceFailure = setup({ configured: true });
    persistenceFailure.power.acknowledgeWarning.mockRejectedValueOnce(new Error(privateDetail));

    const storageResult = await persistenceFailure.invoke(
      DESKTOP_TELEGRAM_ACKNOWLEDGE_GAP_WARNING_CHANNEL,
    );
    expect(storageResult).toEqual({
      outcome: "uncertain",
      reason: "storage-uncertain",
      current: ipcSnapshot(true),
    });
    expect(JSON.stringify(storageResult)).not.toContain(privateDetail);
    expect(JSON.stringify(storageResult)).not.toContain(TOKEN);

    const statusFailure = setup({ configured: true });
    vi.mocked(statusFailure.coordinator.status).mockRejectedValueOnce(new Error(privateDetail));
    const controlResult = await statusFailure.invoke(
      DESKTOP_TELEGRAM_ACKNOWLEDGE_GAP_WARNING_CHANNEL,
    );
    expect(controlResult).toEqual({
      outcome: "uncertain",
      reason: "control-uncertain",
      current: {
        channel: {
          desiredState: "disabled",
          state: "failed",
          errorCode: "telegram-control-failed",
        },
        bot: { state: "unconfigured" },
        pairing: { state: "unpaired" },
        credentialConfigured: false,
        gapWarning: { state: "clear" },
      },
    });
    expect(JSON.stringify(controlResult)).not.toContain(privateDetail);
    expect(JSON.stringify(controlResult)).not.toContain(TOKEN);

    const malformedStatus = setup({ configured: true });
    vi.mocked(malformedStatus.coordinator.status).mockResolvedValueOnce({
      ...snapshot(true),
      source: privateDetail,
    } as never);
    const malformedResult = await malformedStatus.invoke(
      DESKTOP_TELEGRAM_ACKNOWLEDGE_GAP_WARNING_CHANNEL,
    );
    expect(malformedResult).toMatchObject({
      outcome: "uncertain",
      reason: "control-uncertain",
      current: { credentialConfigured: false },
    });
    expect(JSON.stringify(malformedResult)).not.toContain(privateDetail);
    expect(JSON.stringify(malformedResult)).not.toContain(TOKEN);
  });

  it("classifies malformed gap-warning acknowledgements as storage uncertainty", async () => {
    const privateDetail = `https://bot.example.invalid/${TOKEN} at /Users/private/id_ed25519 PRIVATE_KEY`;

    for (const malformed of [
      { state: "clear", privateKeyPath: privateDetail },
      {
        state: "possible-message-loss",
        detectedAt: "not-canonical",
        privateKeyName: privateDetail,
      },
    ]) {
      const runtime = setup({ configured: true });
      runtime.power.acknowledgeWarning.mockResolvedValueOnce(malformed as never);

      const result = await runtime.invoke(DESKTOP_TELEGRAM_ACKNOWLEDGE_GAP_WARNING_CHANNEL);

      expect(result).toEqual({
        outcome: "uncertain",
        reason: "storage-uncertain",
        current: ipcSnapshot(true),
      });
      expect(JSON.stringify(result)).not.toContain(TOKEN);
      expect(JSON.stringify(result)).not.toContain("PRIVATE_KEY");
    }
  });

  it("fails the gap warning closed when its runtime shape is not exact", async () => {
    const runtime = setup({ configured: true });
    runtime.power.warning.mockResolvedValueOnce({
      state: "possible-message-loss",
      detectedAt: "2026-08-03T12:00:00.000Z",
      privateDetail: TOKEN,
    } as never);

    await expect(runtime.invoke(DESKTOP_TELEGRAM_STATUS_CHANNEL)).resolves.toEqual({
      ...snapshot(true),
      gapWarning: { state: "clear" },
    });
  });

  it("accepts exactly one strict senderId object for add and remove", async () => {
    const runtime = setup();

    await expect(runtime.invoke(DESKTOP_TELEGRAM_LIST_ALLOWED_SENDERS_CHANNEL)).resolves.toEqual({
      senders: [PRIMARY_SENDER],
    });
    vi.mocked(runtime.coordinator.listAllowedSenders).mockResolvedValueOnce({ senders: [] });
    await expect(runtime.invoke(DESKTOP_TELEGRAM_LIST_ALLOWED_SENDERS_CHANNEL)).resolves.toEqual({
      senders: [],
    });
    await expect(
      runtime.invoke(DESKTOP_TELEGRAM_ADD_ALLOWED_SENDER_CHANNEL, { senderId: 67890 }),
    ).resolves.toEqual({
      outcome: "applied",
      current: { senders: [PRIMARY_SENDER, { senderId: 67890, role: "additional" }] },
    });
    await expect(
      runtime.invoke(DESKTOP_TELEGRAM_REMOVE_ALLOWED_SENDER_CHANNEL, { senderId: 67890 }),
    ).resolves.toEqual({ outcome: "applied", current: { senders: [PRIMARY_SENDER] } });
    expect(runtime.coordinator.addAllowedSender).toHaveBeenCalledWith({ senderId: 67890 });
    expect(runtime.coordinator.removeAllowedSender).toHaveBeenCalledWith({ senderId: 67890 });

    const privateDetail = `https://bot.example.invalid/${TOKEN} at /Users/private/id_rsa PRIVATE_KEY`;
    let malformedFailure: unknown;
    try {
      runtime.invoke(DESKTOP_TELEGRAM_ADD_ALLOWED_SENDER_CHANNEL, {
        senderId: 67890,
        privateKeyPath: privateDetail,
      });
    } catch (error) {
      malformedFailure = error;
    }
    expect(malformedFailure).toBeInstanceOf(TypeError);
    expect((malformedFailure as TypeError).message).toBe("");
    expect(String(malformedFailure)).not.toContain(TOKEN);
    expect(String(malformedFailure)).not.toContain("id_rsa");
    expect(() =>
      runtime.invoke(DESKTOP_TELEGRAM_REMOVE_ALLOWED_SENDER_CHANNEL, { senderId: "67890" }),
    ).toThrow();
    expect(() => runtime.invoke(DESKTOP_TELEGRAM_ADD_ALLOWED_SENDER_CHANNEL)).toThrow(TypeError);
    expect(() =>
      runtime.invoke(DESKTOP_TELEGRAM_REMOVE_ALLOWED_SENDER_CHANNEL, { senderId: 67890 }, {}),
    ).toThrow(TypeError);
  });

  it("propagates strict sender storage uncertainty without a current list", async () => {
    const runtime = setup();
    vi.mocked(runtime.coordinator.addAllowedSender).mockResolvedValueOnce({
      outcome: "uncertain",
      reason: "storage-uncertain",
    });

    await expect(
      runtime.invoke(DESKTOP_TELEGRAM_ADD_ALLOWED_SENDER_CHANNEL, { senderId: 67890 }),
    ).resolves.toEqual({ outcome: "uncertain", reason: "storage-uncertain" });

    let malformedSideEffectApplied = false;
    vi.mocked(runtime.coordinator.addAllowedSender).mockImplementationOnce(async () => {
      malformedSideEffectApplied = true;
      return {
        outcome: "uncertain",
        reason: "storage-uncertain",
        current: { senders: [] },
      } as never;
    });
    await expect(
      runtime.invoke(DESKTOP_TELEGRAM_ADD_ALLOWED_SENDER_CHANNEL, { senderId: 67890 }),
    ).resolves.toEqual({ outcome: "uncertain", reason: "control-uncertain" });
    expect(malformedSideEffectApplied).toBe(true);

    vi.mocked(runtime.coordinator.addAllowedSender).mockResolvedValueOnce({
      outcome: "refused",
      reason: "invalid-state",
    });
    await expect(
      runtime.invoke(DESKTOP_TELEGRAM_ADD_ALLOWED_SENDER_CHANNEL, { senderId: 67890 }),
    ).resolves.toEqual({ outcome: "refused", reason: "invalid-state" });
  });

  it.each(["malformed", "rejected"] as const)(
    "rejects a sanitized allowed-sender load failure when the coordinator response is %s",
    async (terminal) => {
      const runtime = setup();
      const privateDetail = `private daemon path with ${TOKEN}`;
      if (terminal === "malformed") {
        vi.mocked(runtime.coordinator.listAllowedSenders).mockResolvedValueOnce({
          senders: [
            { senderId: 12345, role: "primary" },
            { senderId: 12345, role: "additional" },
          ],
          privateDetail,
        } as never);
      } else {
        vi.mocked(runtime.coordinator.listAllowedSenders).mockRejectedValueOnce(
          new Error(privateDetail),
        );
      }

      const failure = await Promise.resolve(
        runtime.invoke(DESKTOP_TELEGRAM_LIST_ALLOWED_SENDERS_CHANNEL),
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(TypeError);
      expect((failure as TypeError).message).toBe("");
      expect(String(failure)).not.toContain(privateDetail);
      expect(String(failure)).not.toContain(TOKEN);
    },
  );

  it("returns control uncertainty after a side-effecting allowed-sender IPC rejects", async () => {
    const runtime = setup();
    let sideEffectApplied = false;
    vi.mocked(runtime.coordinator.removeAllowedSender).mockImplementationOnce(async () => {
      sideEffectApplied = true;
      throw new Error(`daemon unavailable at /private/path with ${TOKEN}`);
    });

    await expect(
      runtime.invoke(DESKTOP_TELEGRAM_REMOVE_ALLOWED_SENDER_CHANNEL, { senderId: 67890 }),
    ).resolves.toEqual({ outcome: "uncertain", reason: "control-uncertain" });
    expect(sideEffectApplied).toBe(true);
  });

  it("copies the redacted pairing storage uncertainty snapshot exactly", async () => {
    const runtime = setup({ configured: true });
    vi.mocked(runtime.coordinator.status).mockResolvedValueOnce({
      ...snapshot(true),
      pairing: { state: "failed", errorCode: "telegram-pairing-storage-uncertain" },
    });

    await expect(runtime.invoke(DESKTOP_TELEGRAM_STATUS_CHANNEL)).resolves.toEqual({
      ...snapshot(true),
      pairing: { state: "failed", errorCode: "telegram-pairing-storage-uncertain" },
      gapWarning: { state: "clear" },
    });
  });

  it("rejects untrusted and malformed calls before clipboard or coordinator access", () => {
    const untrusted = setup({ trusted: false });
    expect(() => untrusted.invoke(DESKTOP_TELEGRAM_STATUS_CHANNEL)).toThrow(
      "untrusted desktop Telegram request",
    );
    expect(() =>
      untrusted.invoke(DESKTOP_TELEGRAM_ADD_ALLOWED_SENDER_CHANNEL, { senderId: 12345 }),
    ).toThrow("untrusted desktop Telegram request");

    const extra = setup();
    expect(() => extra.invoke(DESKTOP_TELEGRAM_PASTE_CREDENTIAL_CHANNEL, TOKEN)).toThrow(TypeError);
    expect(extra.clipboard.readText).not.toHaveBeenCalled();
    expect(extra.clipboard.clear).not.toHaveBeenCalled();
    expect(extra.coordinator.configure).not.toHaveBeenCalled();
  });
});
