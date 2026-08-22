import {
  AthleteHomeIdentitySchema,
  TelegramBotIdSchema,
  TelegramBotUsernameSchema,
  TelegramCredentialSchema,
  type AthleteHomeIdentity,
  type TelegramAllowedSendersResult,
  type TelegramControlMutationResult,
  type TelegramControlSnapshot,
  type TelegramCredentialInspection,
} from "@enduragent/coach-contract";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CredentialEncryptionPort } from "../src/main/credential-vault.js";
import {
  createTelegramControlCoordinator,
  type CreateTelegramControlCoordinatorInput,
  type TelegramDaemonBinding,
} from "../src/main/telegram-control.js";
import type {
  TelegramCredentialVault,
  TelegramProfileRecord,
} from "../src/main/telegram-credential-vault.js";
import { createTelegramCredentialVault } from "../src/main/telegram-credential-vault.js";
import { startDesktopTelegram } from "../src/main/telegram-startup.js";

const HOME = "/synthetic/athlete" as AthleteHomeIdentity;
const OTHER_HOME = "/synthetic/other" as AthleteHomeIdentity;
const TOKEN = TelegramCredentialSchema.parse("123456:synthetic-token");
const REPLACEMENT_TOKEN = TelegramCredentialSchema.parse("654321:replacement-token");
const BOT_ID = TelegramBotIdSchema.parse(10001);
const OTHER_BOT_ID = TelegramBotIdSchema.parse(20002);
const USERNAME = TelegramBotUsernameSchema.parse("desktop_bot");
const OTHER_USERNAME = TelegramBotUsernameSchema.parse("replacement_bot");
const PROFILE_ID = "00000000-0000-4000-8000-000000000001";
const REPLACEMENT_PROFILE_ID = "00000000-0000-4000-8000-000000000002";

function realVaultEncryption(): CredentialEncryptionPort {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, "utf8").reverse(),
    decryptString: (value) => Buffer.from(value).reverse().toString("utf8"),
  };
}

async function realVaultFixture() {
  const base = await mkdtemp(join(await realpath(tmpdir()), "telegram-control-secure-storage-"));
  const homePath = join(base, "athlete-home");
  await mkdir(homePath, { mode: 0o700 });
  return {
    base,
    root: join(base, "telegram-channel-v1"),
    athleteHome: AthleteHomeIdentitySchema.parse(await realpath(homePath)),
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const snapshot = (
  channel: TelegramControlSnapshot["channel"] = {
    desiredState: "enabled",
    state: "online",
  },
  options: {
    readonly username?: typeof USERNAME | typeof OTHER_USERNAME;
    readonly pairing?: TelegramControlSnapshot["pairing"];
  } = {},
): TelegramControlSnapshot => ({
  channel,
  bot: { state: "ready", username: options.username ?? USERNAME },
  pairing: options.pairing ?? { state: "paired" },
});

function profile(
  options: {
    readonly token?: typeof TOKEN | typeof REPLACEMENT_TOKEN;
    readonly botId?: typeof BOT_ID | typeof OTHER_BOT_ID;
    readonly username?: typeof USERNAME | typeof OTHER_USERNAME;
    readonly profileId?: string;
  } = {},
): TelegramProfileRecord {
  return {
    schemaVersion: 1,
    profileId: options.profileId ?? PROFILE_ID,
    athleteHome: HOME,
    token: options.token ?? TOKEN,
    bot: {
      id: options.botId ?? BOT_ID,
      username: options.username ?? USERNAME,
    },
  };
}

function leaseScheduler(nowIso = "2026-08-05T12:00:00.000Z") {
  let now = Date.parse(nowIso);
  const entries: Array<{ callback: () => void; cancelled: boolean; delayMs: number }> = [];
  return {
    port: {
      now: () => now,
      schedule: (callback: () => void, delayMs: number) => {
        entries.push({ callback, cancelled: false, delayMs });
        return entries.length - 1;
      },
      cancel: (handle: unknown) => {
        const entry = entries[Number(handle)];
        if (entry !== undefined) entry.cancelled = true;
      },
    },
    entries,
    setNow(value: string) {
      now = Date.parse(value);
    },
    fire(index: number, includeCancelled = false) {
      const entry = entries[index];
      if (entry !== undefined && (includeCancelled || !entry.cancelled)) entry.callback();
    },
  };
}

function harness(
  options: {
    readonly configured?: boolean;
    readonly enabled?: boolean;
    readonly supervision?: "app-supervised" | "attached";
    readonly inspection?: TelegramCredentialInspection;
    readonly daemonSnapshot?: TelegramControlSnapshot;
    readonly pairingLease?: CreateTelegramControlCoordinatorInput["pairingLease"];
  } = {},
) {
  let storedProfile = options.configured === false ? undefined : profile();
  let enabled = options.enabled ?? true;
  let currentSnapshot = options.daemonSnapshot ?? snapshot();
  let inspection: TelegramCredentialInspection = options.inspection ?? {
    status: "ready",
    bot: { id: OTHER_BOT_ID, username: OTHER_USERNAME },
  };
  let daemonBotId = BOT_ID;
  let bindingCurrent: TelegramDaemonBinding | undefined;
  const trace: string[] = [];

  const vault: TelegramCredentialVault = {
    profileStatus: vi.fn(async () =>
      storedProfile === undefined
        ? ({ state: "missing" } as const)
        : ({
            state: "configured",
            profileId: storedProfile.profileId,
            bot: storedProfile.bot,
          } as const),
    ),
    replaceProfile: vi.fn(async (input) => {
      trace.push(`vault:replace:${String(input.bot.id)}`);
      storedProfile = {
        schemaVersion: 1,
        profileId: REPLACEMENT_PROFILE_ID,
        athleteHome: input.authenticatedAthleteHome,
        token: TelegramCredentialSchema.parse(input.token),
        bot: input.bot,
      };
      return {
        outcome: "applied",
        profileId: storedProfile.profileId,
        bot: storedProfile.bot,
      } as const;
    }),
    applyStoredProfile: vi.fn(async (home, apply) => {
      trace.push("vault:apply");
      if (storedProfile === undefined) return { outcome: "refused", reason: "missing" } as const;
      if (home !== storedProfile.athleteHome) {
        return { outcome: "refused", reason: "wrong-home" } as const;
      }
      try {
        await apply(storedProfile);
        return {
          outcome: "applied",
          profileId: storedProfile.profileId,
          bot: storedProfile.bot,
        } as const;
      } catch {
        return { outcome: "refused", reason: "runtime-unavailable" } as const;
      }
    }),
    deleteProfile: vi.fn(async () => {
      trace.push("vault:delete");
      storedProfile = undefined;
      return { outcome: "applied", cleanupPending: false } as const;
    }),
    desiredState: vi.fn(async () => ({ state: "configured", enabled }) as const),
    setDesiredState: vi.fn(async (next) => {
      trace.push(`vault:desired:${String(next)}`);
      enabled = next;
      return { status: "stored", enabled: next } as const;
    }),
  };

  const applied = (): TelegramControlMutationResult => ({
    outcome: "applied",
    current: currentSnapshot,
  });
  let senders: TelegramAllowedSendersResult = {
    senders: [{ senderId: 12345, role: "primary" }],
  };
  const binding: TelegramDaemonBinding = {
    generation: 1,
    athleteHome: HOME,
    supervision: options.supervision ?? "app-supervised",
    configureTelegram: vi.fn(async ({ token }) => {
      trace.push(`daemon:configure:${token}`);
      return applied();
    }),
    replaceTelegram: vi.fn(async ({ token }) => {
      trace.push(`daemon:replace:${token}`);
      if (token === TOKEN) {
        currentSnapshot = {
          ...currentSnapshot,
          bot: { state: "ready", username: USERNAME },
        };
        daemonBotId = BOT_ID;
      } else if (
        inspection.status === "ready" ||
        inspection.status === "webhook-removal-required"
      ) {
        currentSnapshot = {
          ...currentSnapshot,
          bot: { state: inspection.status, username: inspection.bot.username },
          pairing:
            daemonBotId === inspection.bot.id ? currentSnapshot.pairing : { state: "unpaired" },
        };
        daemonBotId = inspection.bot.id;
      }
      return applied();
    }),
    enableTelegram: vi.fn(async () => {
      trace.push("daemon:enable");
      return currentSnapshot;
    }),
    disableTelegram: vi.fn(async () => {
      trace.push("daemon:disable");
      currentSnapshot = {
        ...currentSnapshot,
        channel: { desiredState: "disabled", state: "disabled" },
      };
      return currentSnapshot;
    }),
    suspendTelegramPolling: vi.fn(async () => {
      trace.push("daemon:suspend");
      currentSnapshot = {
        ...currentSnapshot,
        channel: enabled
          ? { desiredState: "enabled", state: "suspended" }
          : { desiredState: "disabled", state: "disabled" },
      };
      return currentSnapshot;
    }),
    resumeTelegramPolling: vi.fn(async () => {
      trace.push("daemon:resume");
      currentSnapshot = {
        ...currentSnapshot,
        channel: enabled
          ? { desiredState: "enabled", state: "online" }
          : { desiredState: "disabled", state: "disabled" },
      };
      return currentSnapshot;
    }),
    drainTelegram: vi.fn(async () => {
      trace.push("daemon:drain");
      return currentSnapshot;
    }),
    getTelegramStatus: vi.fn(async () => currentSnapshot),
    reconcileTelegram: vi.fn(async () => currentSnapshot),
    resetTelegramAccess: vi.fn(async () => {
      trace.push("daemon:reset-access");
      currentSnapshot = { ...currentSnapshot, pairing: { state: "unpaired" } };
      return currentSnapshot;
    }),
    inspectTelegramCredential: vi.fn(async ({ token }) => {
      trace.push(`daemon:inspect:${token}`);
      return inspection;
    }),
    deleteTelegramWebhook: vi.fn(async () => inspection),
    forgetTelegramCredential: vi.fn(async () => {
      trace.push("daemon:forget");
      return {
        channel: { desiredState: "disabled", state: "disabled" },
        bot: { state: "unconfigured" },
        pairing: { state: "unpaired" },
      } as const;
    }),
    beginTelegramPairing: vi.fn(async () => currentSnapshot),
    cancelTelegramPairing: vi.fn(async () => currentSnapshot),
    listTelegramAllowedSenders: vi.fn(async () => senders),
    addTelegramAllowedSender: vi.fn(async ({ senderId }) => {
      senders = { senders: [...senders.senders, { senderId, role: "additional" }] };
      return { outcome: "applied", current: senders };
    }),
    removeTelegramAllowedSender: vi.fn(async ({ senderId }) => {
      senders = { senders: senders.senders.filter((sender) => sender.senderId !== senderId) };
      return { outcome: "applied", current: senders };
    }),
  };
  bindingCurrent = binding;
  const coordinator = createTelegramControlCoordinator({
    selectedAthleteHome: () => HOME,
    vault,
    daemon: { current: () => bindingCurrent },
    pairingLease: options.pairingLease,
  });
  return {
    binding,
    coordinator,
    trace,
    vault,
    profile: () => storedProfile,
    desired: () => enabled,
    setBinding(value: TelegramDaemonBinding | undefined) {
      bindingCurrent = value;
    },
    setInspection(value: TelegramCredentialInspection) {
      inspection = value;
    },
    setSnapshot(value: TelegramControlSnapshot) {
      currentSnapshot = value;
    },
    setSenders(value: TelegramAllowedSendersResult) {
      senders = value;
    },
  };
}

function expectNoTelegramMutation(runtime: ReturnType<typeof harness>): void {
  for (const mutation of [
    runtime.vault.setDesiredState,
    runtime.vault.replaceProfile,
    runtime.vault.applyStoredProfile,
    runtime.vault.deleteProfile,
    runtime.binding.configureTelegram,
    runtime.binding.replaceTelegram,
    runtime.binding.enableTelegram,
    runtime.binding.disableTelegram,
    runtime.binding.suspendTelegramPolling,
    runtime.binding.resumeTelegramPolling,
    runtime.binding.drainTelegram,
    runtime.binding.reconcileTelegram,
    runtime.binding.resetTelegramAccess,
    runtime.binding.deleteTelegramWebhook,
    runtime.binding.forgetTelegramCredential,
    runtime.binding.beginTelegramPairing,
    runtime.binding.cancelTelegramPairing,
    runtime.binding.listTelegramAllowedSenders,
    runtime.binding.addTelegramAllowedSender,
    runtime.binding.removeTelegramAllowedSender,
  ]) {
    expect(mutation).not.toHaveBeenCalled();
  }
}

const repairRequiredMutationCases: ReadonlyArray<
  readonly [string, (runtime: ReturnType<typeof harness>) => Promise<unknown>]
> = [
  ["configure", (runtime) => runtime.coordinator.configure(REPLACEMENT_TOKEN)],
  ["replace", (runtime) => runtime.coordinator.replace(REPLACEMENT_TOKEN)],
  ["enable", (runtime) => runtime.coordinator.enable()],
  ["disable", (runtime) => runtime.coordinator.disable()],
  ["stop polling", (runtime) => runtime.coordinator.stopPolling()],
  ["resume polling", (runtime) => runtime.coordinator.resumePolling()],
  ["remove", (runtime) => runtime.coordinator.remove()],
  ["remove webhook", (runtime) => runtime.coordinator.removeWebhook()],
  ["reconcile", (runtime) => runtime.coordinator.reconcile()],
  ["begin pairing", (runtime) => runtime.coordinator.beginPairing()],
  ["cancel pairing", (runtime) => runtime.coordinator.cancelPairing()],
  ["add sender", (runtime) => runtime.coordinator.addAllowedSender({ senderId: 303 })],
  ["remove sender", (runtime) => runtime.coordinator.removeAllowedSender({ senderId: 303 })],
];

describe("Telegram main-process control coordinator", () => {
  it("preserves the active profile, desired state, pairing, and runtime for an invalid replacement", async () => {
    const runtime = harness({
      inspection: { status: "invalid-token" },
      daemonSnapshot: snapshot(undefined, { pairing: { state: "paired" } }),
    });
    const before = runtime.profile();

    await expect(runtime.coordinator.replace(REPLACEMENT_TOKEN)).resolves.toEqual({
      outcome: "refused",
      reason: "invalid-token",
      current: {
        channel: { desiredState: "enabled", state: "online" },
        bot: { state: "ready", username: USERNAME },
        pairing: { state: "paired" },
        credentialConfigured: true,
      },
    });
    expect(runtime.profile()).toEqual(before);
    expect(runtime.desired()).toBe(true);
    expect(runtime.vault.replaceProfile).not.toHaveBeenCalled();
    expect(runtime.binding.replaceTelegram).not.toHaveBeenCalled();
    expect(runtime.binding.disableTelegram).not.toHaveBeenCalled();
  });

  it("preserves durable enabled intent when fallback status is unavailable", async () => {
    const runtime = harness({ inspection: { status: "invalid-token" } });
    vi.mocked(runtime.binding.getTelegramStatus).mockRejectedValueOnce(
      new Error("status unavailable"),
    );

    await expect(runtime.coordinator.replace(REPLACEMENT_TOKEN)).resolves.toMatchObject({
      outcome: "refused",
      reason: "invalid-token",
      current: {
        channel: {
          desiredState: "enabled",
          state: "failed",
          errorCode: "telegram-control-failed",
        },
      },
    });
    expect(runtime.desired()).toBe(true);
  });

  it.each([
    [
      {
        status: "unavailable",
        errorCode: "telegram-validation-failed",
      } as const,
      "validation-unavailable" as const,
    ],
    [
      {
        status: "webhook-removal-required",
        bot: { id: OTHER_BOT_ID, username: OTHER_USERNAME },
      } as const,
      "webhook-removal-required" as const,
    ],
  ])("preserves profile A when replacement preflight returns %s", async (inspection, reason) => {
    const runtime = harness({ inspection });
    const before = runtime.profile();

    await expect(runtime.coordinator.replace(REPLACEMENT_TOKEN)).resolves.toMatchObject({
      outcome: "refused",
      reason,
      current: {
        channel: { desiredState: "enabled", state: "online" },
        bot: { state: "ready", username: USERNAME },
        pairing: { state: "paired" },
      },
    });
    expect(runtime.profile()).toEqual(before);
    expect(runtime.desired()).toBe(true);
    expect(runtime.vault.replaceProfile).not.toHaveBeenCalled();
    expect(runtime.binding.replaceTelegram).not.toHaveBeenCalled();
  });

  it("resumes unchanged daemon A without passing B when profile storage is uncertain", async () => {
    const runtime = harness();
    vi.mocked(runtime.vault.replaceProfile).mockResolvedValueOnce({
      outcome: "uncertain",
      reason: "storage-uncertain",
    });

    await expect(runtime.coordinator.replace(REPLACEMENT_TOKEN)).resolves.toMatchObject({
      outcome: "uncertain",
      reason: "storage-uncertain",
    });
    expect(runtime.binding.configureTelegram).not.toHaveBeenCalled();
    expect(runtime.binding.replaceTelegram).not.toHaveBeenCalled();
    expect(runtime.binding.suspendTelegramPolling).toHaveBeenCalledOnce();
    expect(runtime.binding.resumeTelegramPolling).toHaveBeenCalledOnce();
    expect(runtime.binding.enableTelegram).not.toHaveBeenCalled();
    expect(runtime.binding.disableTelegram).not.toHaveBeenCalled();
    expect(runtime.binding.resetTelegramAccess).not.toHaveBeenCalled();
  });

  it("keeps profile A durable and resumes A when profile storage refuses", async () => {
    const runtime = harness();
    const before = runtime.profile();
    vi.mocked(runtime.vault.replaceProfile).mockResolvedValueOnce({
      outcome: "refused",
      reason: "storage-failed",
    });

    await expect(runtime.coordinator.replace(REPLACEMENT_TOKEN)).resolves.toMatchObject({
      outcome: "refused",
      reason: "storage-failed",
    });
    expect(runtime.profile()).toEqual(before);
    expect(runtime.binding.replaceTelegram).not.toHaveBeenCalled();
    expect(runtime.binding.suspendTelegramPolling).toHaveBeenCalledOnce();
    expect(runtime.binding.resumeTelegramPolling).toHaveBeenCalledOnce();
  });

  it("preserves an encryption-unavailable refusal without applying the replacement token", async () => {
    const runtime = harness();
    const before = runtime.profile();
    vi.mocked(runtime.vault.replaceProfile).mockResolvedValueOnce({
      outcome: "refused",
      reason: "encryption-unavailable",
    });

    await expect(runtime.coordinator.replace(REPLACEMENT_TOKEN)).resolves.toMatchObject({
      outcome: "refused",
      reason: "encryption-unavailable",
      current: {
        channel: { desiredState: "enabled", state: "online" },
        bot: { state: "ready", username: USERNAME },
        pairing: { state: "paired" },
        credentialConfigured: true,
      },
    });
    expect(runtime.profile()).toEqual(before);
    expect(runtime.desired()).toBe(true);
    expect(runtime.binding.replaceTelegram).not.toHaveBeenCalled();
    expect(runtime.binding.resumeTelegramPolling).toHaveBeenCalledOnce();
  });

  it("keeps initial setup unchanged when secure encryption is unavailable", async () => {
    const runtime = harness({
      configured: false,
      enabled: false,
      daemonSnapshot: {
        channel: { desiredState: "disabled", state: "disabled" },
        bot: { state: "unconfigured" },
        pairing: { state: "unpaired" },
      },
    });
    vi.mocked(runtime.vault.replaceProfile).mockResolvedValueOnce({
      outcome: "refused",
      reason: "encryption-unavailable",
    });

    await expect(runtime.coordinator.configure(REPLACEMENT_TOKEN)).resolves.toEqual({
      outcome: "refused",
      reason: "encryption-unavailable",
      current: {
        channel: { desiredState: "disabled", state: "disabled" },
        bot: { state: "unconfigured" },
        pairing: { state: "unpaired" },
        credentialConfigured: false,
      },
    });
    expect(runtime.profile()).toBeUndefined();
    expect(runtime.desired()).toBe(false);
    expect(runtime.binding.configureTelegram).not.toHaveBeenCalled();
    expect(runtime.binding.suspendTelegramPolling).not.toHaveBeenCalled();
    expect(runtime.vault.setDesiredState).not.toHaveBeenCalled();
  });

  it("preserves an unsafe-backend refusal when the current profile cannot be read for replacement", async () => {
    const runtime = harness();
    const before = runtime.profile();
    vi.mocked(runtime.vault.applyStoredProfile).mockResolvedValueOnce({
      outcome: "refused",
      reason: "unsafe-backend",
    });

    await expect(runtime.coordinator.replace(REPLACEMENT_TOKEN)).resolves.toMatchObject({
      outcome: "refused",
      reason: "unsafe-backend",
      current: {
        channel: { desiredState: "enabled", state: "online" },
        bot: { state: "ready", username: USERNAME },
        pairing: { state: "paired" },
        credentialConfigured: true,
      },
    });
    expect(runtime.profile()).toEqual(before);
    expect(runtime.desired()).toBe(true);
    expect(runtime.binding.inspectTelegramCredential).not.toHaveBeenCalled();
    expect(runtime.binding.suspendTelegramPolling).not.toHaveBeenCalled();
    expect(runtime.binding.replaceTelegram).not.toHaveBeenCalled();
  });

  for (const [run, reason, available, selectedBackend, errorCode] of [
    [
      it,
      "encryption-unavailable" as const,
      false,
      undefined,
      "telegram-credential-encryption-unavailable" as const,
    ],
    [
      it.skipIf(process.platform === "win32"),
      "unsafe-backend" as const,
      true,
      "basic_text",
      "telegram-credential-unsafe-backend" as const,
    ],
  ] as const) {
    const title = `preserves a reopened real-vault ${reason} refusal across profile-dependent actions`;
    run(title, async () => {
      const value = await realVaultFixture();
      try {
        const seed = createTelegramCredentialVault({
          ...value,
          encryption: realVaultEncryption(),
          createProfileId: () => PROFILE_ID,
        });
        await expect(
          seed.replaceProfile({
            token: TOKEN,
            bot: { id: BOT_ID, username: USERNAME },
            authenticatedAthleteHome: value.athleteHome,
          }),
        ).resolves.toMatchObject({ outcome: "applied" });
        await expect(seed.setDesiredState(true)).resolves.toEqual({
          status: "stored",
          enabled: true,
        });
        const observeSecureStorageFailure = vi.fn();
        const reopened = createTelegramCredentialVault({
          ...value,
          ...(selectedBackend === undefined ? {} : { platform: "linux" as const }),
          encryption: {
            ...realVaultEncryption(),
            isEncryptionAvailable: () => available,
            ...(selectedBackend === undefined
              ? {}
              : { getSelectedStorageBackend: () => selectedBackend }),
          },
          observeSecureStorageFailure,
        });
        const runtime = harness();
        const realBinding = { ...runtime.binding, athleteHome: value.athleteHome };
        const coordinator = createTelegramControlCoordinator({
          selectedAthleteHome: () => value.athleteHome,
          vault: reopened,
          daemon: { current: () => realBinding },
          observeSecureStorageFailure,
        });

        const expectedCurrent = {
          channel: { desiredState: "enabled" as const, state: "failed" as const, errorCode },
          bot: { state: "ready" as const, username: USERNAME },
          pairing: { state: "paired" as const },
          credentialConfigured: true,
        };
        await expect(coordinator.status()).resolves.toEqual(expectedCurrent);

        for (const operation of [
          () => coordinator.replace(REPLACEMENT_TOKEN),
          () => coordinator.enable(),
          () => coordinator.reconcile(),
          () => coordinator.remove(),
          () => coordinator.removeWebhook(),
          () => coordinator.beginPairing(),
        ]) {
          await expect(operation()).resolves.toEqual({
            outcome: "refused",
            reason,
            current: expectedCurrent,
          });
        }

        expect(observeSecureStorageFailure).toHaveBeenCalledWith({
          stage: "encryption-availability",
          reason,
        });
        expect(observeSecureStorageFailure.mock.calls.flat(2)).not.toContain(TOKEN);
        expect(runtime.binding.inspectTelegramCredential).not.toHaveBeenCalled();
        expect(runtime.binding.replaceTelegram).not.toHaveBeenCalled();
        expect(runtime.binding.enableTelegram).not.toHaveBeenCalled();
        expect(runtime.binding.disableTelegram).not.toHaveBeenCalled();
        expect(runtime.binding.deleteTelegramWebhook).not.toHaveBeenCalled();
        expect(runtime.binding.beginTelegramPairing).not.toHaveBeenCalled();

        const verified = createTelegramCredentialVault({
          ...value,
          encryption: realVaultEncryption(),
        });
        const appliedProfile = vi.fn();
        await expect(
          verified.applyStoredProfile(value.athleteHome, appliedProfile),
        ).resolves.toMatchObject({ outcome: "applied" });
        expect(appliedProfile).toHaveBeenCalledWith(
          expect.objectContaining({ token: TOKEN, bot: { id: BOT_ID, username: USERNAME } }),
        );
        await expect(verified.desiredState()).resolves.toEqual({
          state: "configured",
          enabled: true,
        });
      } finally {
        await rm(value.base, { recursive: true, force: true });
      }
    });
  }

  it("returns the preserved pre-mutation snapshot when a real vault backend flips during replacement", async () => {
    const value = await realVaultFixture();
    try {
      const encryption = realVaultEncryption();
      const seed = createTelegramCredentialVault({
        ...value,
        encryption,
        createProfileId: () => PROFILE_ID,
      });
      await seed.replaceProfile({
        token: TOKEN,
        bot: { id: BOT_ID, username: USERNAME },
        authenticatedAthleteHome: value.athleteHome,
      });
      await seed.setDesiredState(true);
      let available = true;
      let decryptions = 0;
      const observeSecureStorageFailure = vi.fn();
      const dynamic = createTelegramCredentialVault({
        ...value,
        encryption: {
          ...encryption,
          isEncryptionAvailable: () => available,
          decryptString(value) {
            const plaintext = encryption.decryptString(value);
            decryptions += 1;
            if (decryptions === 2) available = false;
            return plaintext;
          },
        },
        observeSecureStorageFailure,
      });
      const runtime = harness();
      const realBinding = { ...runtime.binding, athleteHome: value.athleteHome };
      const coordinator = createTelegramControlCoordinator({
        selectedAthleteHome: () => value.athleteHome,
        vault: dynamic,
        daemon: { current: () => realBinding },
        observeSecureStorageFailure,
      });

      await expect(coordinator.replace(REPLACEMENT_TOKEN)).resolves.toEqual({
        outcome: "refused",
        reason: "encryption-unavailable",
        current: {
          channel: { desiredState: "enabled", state: "online" },
          bot: { state: "ready", username: USERNAME },
          pairing: { state: "paired" },
          credentialConfigured: true,
        },
      });
      expect(runtime.binding.resumeTelegramPolling).toHaveBeenCalledOnce();
      expect(runtime.binding.replaceTelegram).not.toHaveBeenCalled();
      expect(observeSecureStorageFailure).toHaveBeenCalledWith({
        stage: "encryption-availability",
        reason: "encryption-unavailable",
      });

      const verified = createTelegramCredentialVault({ ...value, encryption });
      const appliedProfile = vi.fn();
      await verified.applyStoredProfile(value.athleteHome, appliedProfile);
      expect(appliedProfile).toHaveBeenCalledWith(
        expect.objectContaining({ token: TOKEN, bot: { id: BOT_ID, username: USERNAME } }),
      );
      await expect(verified.desiredState()).resolves.toEqual({
        state: "configured",
        enabled: true,
      });
    } finally {
      await rm(value.base, { recursive: true, force: true });
    }
  });

  it("projects a generic unreadable profile with a closed status code", async () => {
    const runtime = harness();
    vi.mocked(runtime.vault.profileStatus).mockResolvedValue({
      state: "re-prompt",
      reason: "storage-failed",
    });
    const coordinator = createTelegramControlCoordinator({
      selectedAthleteHome: () => HOME,
      vault: runtime.vault,
      daemon: { current: () => runtime.binding },
    });

    await expect(coordinator.status()).resolves.toMatchObject({
      channel: {
        desiredState: "enabled",
        state: "failed",
        errorCode: "telegram-credential-unavailable",
      },
    });
  });

  it("emits daemon-apply at the failing daemon boundary and isolates async rejection", async () => {
    const runtime = harness({
      daemonSnapshot: {
        channel: { desiredState: "enabled", state: "waiting-for-credential" },
        bot: { state: "unconfigured" },
        pairing: { state: "unpaired" },
      },
    });
    vi.mocked(runtime.binding.configureTelegram).mockRejectedValueOnce(
      new TypeError("private daemon failure"),
    );
    const observeSecureStorageFailure = vi.fn(async () => {
      throw new TypeError("private observer failure");
    });
    const coordinator = createTelegramControlCoordinator({
      selectedAthleteHome: () => HOME,
      vault: runtime.vault,
      daemon: { current: () => runtime.binding },
      observeSecureStorageFailure,
    });

    await expect(coordinator.reconcile()).resolves.toMatchObject({
      outcome: "uncertain",
      reason: "control-uncertain",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(observeSecureStorageFailure).toHaveBeenCalledWith({
      stage: "daemon-apply",
      reason: "control-uncertain",
    });
    expect(JSON.stringify(observeSecureStorageFailure.mock.calls)).not.toMatch(
      /private daemon|private observer|synthetic-token/u,
    );
  });

  it.each([true, false])(
    "keeps configured desired=%s reconciliation uncertainty visible until repair succeeds",
    async (enabled) => {
      const runtime = harness({
        configured: true,
        enabled,
        daemonSnapshot: {
          channel: enabled
            ? { desiredState: "enabled", state: "waiting-for-credential" }
            : { desiredState: "disabled", state: "disabled" },
          bot: { state: "unconfigured" },
          pairing: { state: "unpaired" },
        },
      });
      vi.mocked(runtime.binding.configureTelegram).mockRejectedValueOnce(
        new TypeError("synthetic lost response"),
      );
      const desiredState = enabled ? "enabled" : "disabled";
      const repairChannel = {
        desiredState,
        state: "failed" as const,
        errorCode: "telegram-control-failed" as const,
      };
      const powerStart = vi.fn(async () => ({ state: "clear" as const }));

      const reconciliation = await startDesktopTelegram({
        supervision: "app-supervised",
        coordinator: runtime.coordinator,
        power: { start: powerStart },
      });
      expect(powerStart).toHaveBeenCalledOnce();
      expect(reconciliation).toMatchObject({
        outcome: "uncertain",
        reason: "control-uncertain",
        current: { channel: repairChannel, credentialConfigured: true },
      });
      await expect(runtime.coordinator.status()).resolves.toMatchObject({
        channel: repairChannel,
        credentialConfigured: true,
      });

      runtime.setSnapshot(
        snapshot(
          enabled
            ? { desiredState: "enabled", state: "online" }
            : { desiredState: "disabled", state: "disabled" },
        ),
      );
      await expect(runtime.coordinator.reconcile()).resolves.toMatchObject({
        outcome: "applied",
        current: {
          channel: enabled
            ? { desiredState: "enabled", state: "online" }
            : { desiredState: "disabled", state: "disabled" },
        },
      });
      await expect(runtime.coordinator.status()).resolves.toMatchObject({
        channel: enabled
          ? { desiredState: "enabled", state: "online" }
          : { desiredState: "disabled", state: "disabled" },
      });
    },
  );

  it.each([true, false])(
    "keeps configured desired=%s reconciliation refusal visible when its fallback looks healthy",
    async (enabled) => {
      const runtime = harness({ configured: true, enabled });
      vi.mocked(runtime.binding.getTelegramStatus).mockRejectedValueOnce(
        new TypeError("synthetic status refusal"),
      );
      const repairChannel = {
        desiredState: enabled ? ("enabled" as const) : ("disabled" as const),
        state: "failed" as const,
        errorCode: "telegram-control-failed" as const,
      };

      await expect(runtime.coordinator.reconcile()).resolves.toMatchObject({
        outcome: "refused",
        reason: "stale-operation",
        current: { channel: repairChannel, credentialConfigured: true },
      });
      await expect(runtime.coordinator.status()).resolves.toMatchObject({
        channel: repairChannel,
        credentialConfigured: true,
      });
    },
  );

  it("keeps an unexpected reconciliation throw visible as a repair state", async () => {
    const runtime = harness({ configured: true, enabled: false });
    vi.mocked(runtime.vault.desiredState)
      .mockRejectedValueOnce(new TypeError("synthetic desired-state read failure"))
      .mockRejectedValueOnce(new TypeError("synthetic fallback read failure"));

    await expect(runtime.coordinator.reconcile()).resolves.toMatchObject({
      outcome: "uncertain",
      reason: "control-uncertain",
      current: {
        channel: {
          desiredState: "disabled",
          state: "failed",
          errorCode: "telegram-control-failed",
        },
      },
    });
    await expect(runtime.coordinator.status()).resolves.toMatchObject({
      channel: {
        desiredState: "disabled",
        state: "failed",
        errorCode: "telegram-control-failed",
      },
    });
  });

  it("converges to A when daemon replacement throws after B storage", async () => {
    const runtime = harness({
      inspection: {
        status: "ready",
        bot: { id: BOT_ID, username: OTHER_USERNAME },
      },
    });
    vi.mocked(runtime.binding.replaceTelegram).mockRejectedValueOnce(new Error("lost response"));

    await expect(runtime.coordinator.replace(REPLACEMENT_TOKEN)).resolves.toMatchObject({
      outcome: "refused",
      reason: "control-unavailable",
    });
    expect(runtime.profile()).toMatchObject({ token: TOKEN, bot: { id: BOT_ID } });
    expect(runtime.binding.replaceTelegram).toHaveBeenNthCalledWith(1, {
      token: REPLACEMENT_TOKEN,
    });
    expect(runtime.binding.replaceTelegram).toHaveBeenNthCalledWith(2, { token: TOKEN });
    expect(runtime.binding.resumeTelegramPolling).toHaveBeenCalledOnce();
  });

  it.each(["throw", "malformed"] as const)(
    "reports uncertainty when a different-bot replacement may have applied before a %s terminal",
    async (terminal) => {
      const runtime = harness();
      const replace = vi.mocked(runtime.binding.replaceTelegram);
      const appliedReplacement = replace.getMockImplementation()!;
      replace.mockImplementationOnce(async (input) => {
        const result = await appliedReplacement(input);
        if (terminal === "throw") throw new Error("replacement response unavailable");
        return { ...(result as object), unexpected: "private-detail" };
      });

      await expect(runtime.coordinator.replace(REPLACEMENT_TOKEN)).resolves.toMatchObject({
        outcome: "uncertain",
        reason: "control-uncertain",
      });
      expect(runtime.profile()).toMatchObject({ token: TOKEN, bot: { id: BOT_ID } });
      expect(runtime.desired()).toBe(true);
      expect(replace).toHaveBeenNthCalledWith(1, { token: REPLACEMENT_TOKEN });
      expect(replace).toHaveBeenNthCalledWith(2, { token: TOKEN });
    },
  );

  it("reports uncertainty when different-bot storage refusal cannot restore desired intent", async () => {
    const runtime = harness();
    vi.mocked(runtime.vault.setDesiredState)
      .mockResolvedValueOnce({ status: "stored", enabled: false })
      .mockResolvedValueOnce({ status: "uncertain", reason: "storage-uncertain" });
    vi.mocked(runtime.vault.replaceProfile).mockResolvedValueOnce({
      outcome: "refused",
      reason: "storage-failed",
    });

    await expect(runtime.coordinator.replace(REPLACEMENT_TOKEN)).resolves.toMatchObject({
      outcome: "uncertain",
      reason: "storage-uncertain",
    });
    expect(runtime.binding.replaceTelegram).not.toHaveBeenCalled();
    expect(runtime.binding.resumeTelegramPolling).toHaveBeenCalledOnce();
  });

  it("never labels an applied B uncertain final resume as refusal", async () => {
    const runtime = harness({
      inspection: {
        status: "ready",
        bot: { id: BOT_ID, username: OTHER_USERNAME },
      },
    });
    vi.mocked(runtime.binding.resumeTelegramPolling).mockRejectedValueOnce(
      new Error("resume result unavailable"),
    );

    const result = await runtime.coordinator.replace(REPLACEMENT_TOKEN);

    expect(result).toMatchObject({ outcome: "uncertain", reason: "control-uncertain" });
    expect(result.outcome).not.toBe("refused");
    expect(runtime.profile()).toMatchObject({ token: REPLACEMENT_TOKEN });
    expect(runtime.binding.replaceTelegram).toHaveBeenCalledWith({ token: REPLACEMENT_TOKEN });
  });

  it("does not treat a still-suspended final resume as lease release", async () => {
    const runtime = harness({
      inspection: {
        status: "ready",
        bot: { id: BOT_ID, username: OTHER_USERNAME },
      },
    });
    vi.mocked(runtime.binding.resumeTelegramPolling).mockResolvedValueOnce(
      snapshot({ desiredState: "enabled", state: "suspended" }),
    );

    await expect(runtime.coordinator.replace(REPLACEMENT_TOKEN)).resolves.toMatchObject({
      outcome: "uncertain",
      reason: "control-uncertain",
    });
    expect(runtime.profile()).toMatchObject({ token: REPLACEMENT_TOKEN });
  });

  it("does not refuse storage rollback while its owned suspension remains unreleased", async () => {
    const runtime = harness();
    vi.mocked(runtime.vault.replaceProfile).mockResolvedValueOnce({
      outcome: "refused",
      reason: "storage-failed",
    });
    vi.mocked(runtime.binding.resumeTelegramPolling).mockResolvedValueOnce(
      snapshot({ desiredState: "enabled", state: "suspended" }),
    );

    await expect(runtime.coordinator.replace(REPLACEMENT_TOKEN)).resolves.toMatchObject({
      outcome: "uncertain",
      reason: "control-uncertain",
    });
    expect(runtime.profile()).toMatchObject({ token: TOKEN });
  });

  it("clears an unknown initial daemon configure and restores missing profile before refusal", async () => {
    const runtime = harness({
      configured: false,
      enabled: false,
      daemonSnapshot: {
        channel: { desiredState: "disabled", state: "disabled" },
        bot: { state: "unconfigured" },
        pairing: { state: "unpaired" },
      },
    });
    vi.mocked(runtime.binding.configureTelegram).mockRejectedValueOnce(
      new Error("configure response lost"),
    );

    await expect(runtime.coordinator.configure(REPLACEMENT_TOKEN)).resolves.toMatchObject({
      outcome: "refused",
      reason: "control-unavailable",
    });
    expect(runtime.profile()).toBeUndefined();
    expect(runtime.binding.forgetTelegramCredential).toHaveBeenCalledOnce();
    expect(runtime.vault.deleteProfile).toHaveBeenCalledOnce();
  });

  it("does not infer initial configure success from a healthy refused daemon snapshot", async () => {
    const runtime = harness({ configured: false, enabled: false });
    vi.mocked(runtime.binding.configureTelegram).mockResolvedValueOnce({
      outcome: "refused",
      reason: "invalid-state",
      current: snapshot(),
    });

    await expect(runtime.coordinator.configure(REPLACEMENT_TOKEN)).resolves.toMatchObject({
      outcome: "refused",
      reason: "invalid-state",
    });
    expect(runtime.profile()).toBeUndefined();
    expect(runtime.vault.deleteProfile).toHaveBeenCalledOnce();
  });

  it("forgets the released daemon profile before deleting the coherent vault profile", async () => {
    const runtime = harness();
    runtime.trace.length = 0;

    await expect(runtime.coordinator.remove()).resolves.toMatchObject({ outcome: "applied" });
    expect(runtime.trace).toEqual([
      "vault:apply",
      "daemon:disable",
      "daemon:reset-access",
      "daemon:forget",
      "vault:desired:false",
      "vault:delete",
    ]);
    expect(runtime.profile()).toBeUndefined();
  });

  it("stops Telegram for a global reset without decrypting or deleting the profile itself", async () => {
    const runtime = harness();
    runtime.trace.length = 0;

    await expect(runtime.coordinator.resetRuntimeForCredentialReset()).resolves.toBe(true);

    expect(runtime.trace).toEqual([
      "daemon:disable",
      "daemon:reset-access",
      "daemon:forget",
      "vault:desired:false",
    ]);
    expect(runtime.vault.applyStoredProfile).not.toHaveBeenCalled();
    expect(runtime.vault.deleteProfile).not.toHaveBeenCalled();
    expect(runtime.profile()).toMatchObject({ token: TOKEN });
  });

  it("keeps durable profile A and reports uncertainty when daemon forget lacks release proof", async () => {
    const runtime = harness();
    const before = runtime.profile();
    vi.mocked(runtime.binding.forgetTelegramCredential).mockResolvedValueOnce(
      snapshot({ desiredState: "disabled", state: "disabled" }),
    );

    await expect(runtime.coordinator.remove()).resolves.toMatchObject({
      outcome: "uncertain",
      reason: "control-uncertain",
    });
    expect(runtime.profile()).toEqual(before);
    expect(runtime.vault.setDesiredState).not.toHaveBeenCalled();
    expect(runtime.vault.deleteProfile).not.toHaveBeenCalled();
  });

  it.each([
    ["disable", "throw"],
    ["disable", "malformed"],
    ["disable", "stale"],
    ["reset", "throw"],
    ["reset", "malformed"],
    ["reset", "stale"],
    ["forget", "throw"],
    ["forget", "malformed"],
    ["forget", "stale"],
  ] as const)(
    "reports uncertainty when post-applied %s returns a %s terminal during removal",
    async (stage, terminal) => {
      const runtime = harness();
      const before = runtime.profile();
      const postApplied = async <T>(operation: () => Promise<T>): Promise<T> => {
        const result = await operation();
        if (terminal === "throw") throw new Error("mutation response unavailable");
        if (terminal === "stale") {
          runtime.setBinding({ ...runtime.binding, generation: 2 });
          return result;
        }
        return { ...(result as object), unexpected: "private-detail" } as T;
      };
      if (stage === "disable") {
        const operation = vi.mocked(runtime.binding.disableTelegram).getMockImplementation()!;
        vi.mocked(runtime.binding.disableTelegram).mockImplementationOnce((input) =>
          postApplied(() => operation(input)),
        );
      } else if (stage === "reset") {
        const operation = vi.mocked(runtime.binding.resetTelegramAccess).getMockImplementation()!;
        vi.mocked(runtime.binding.resetTelegramAccess).mockImplementationOnce((input) =>
          postApplied(() => operation(input)),
        );
      } else {
        const operation = vi
          .mocked(runtime.binding.forgetTelegramCredential)
          .getMockImplementation()!;
        vi.mocked(runtime.binding.forgetTelegramCredential).mockImplementationOnce((input) =>
          postApplied(() => operation(input)),
        );
      }

      await expect(runtime.coordinator.remove()).resolves.toMatchObject({
        outcome: "uncertain",
        reason: "control-uncertain",
      });
      expect(runtime.profile()).toEqual(before);
      expect(runtime.vault.setDesiredState).not.toHaveBeenCalled();
      expect(runtime.vault.deleteProfile).not.toHaveBeenCalled();
    },
  );

  it("returns only schema-valid allowed-sender lists, including an authoritative empty list", async () => {
    const runtime = harness();

    await expect(runtime.coordinator.listAllowedSenders()).resolves.toEqual({
      senders: [{ senderId: 12345, role: "primary" }],
    });
    runtime.setSenders({ senders: [] });
    await expect(runtime.coordinator.listAllowedSenders()).resolves.toEqual({ senders: [] });
    runtime.setSenders({ senders: [{ senderId: 12345, role: "primary" }] });
    await expect(runtime.coordinator.addAllowedSender({ senderId: 67890 })).resolves.toEqual({
      outcome: "applied",
      current: {
        senders: [
          { senderId: 12345, role: "primary" },
          { senderId: 67890, role: "additional" },
        ],
      },
    });
    await expect(runtime.coordinator.removeAllowedSender({ senderId: 67890 })).resolves.toEqual({
      outcome: "applied",
      current: { senders: [{ senderId: 12345, role: "primary" }] },
    });
    expect(runtime.binding.addTelegramAllowedSender).toHaveBeenCalledWith({ senderId: 67890 });
    expect(runtime.binding.removeTelegramAllowedSender).toHaveBeenCalledWith({ senderId: 67890 });
  });

  it("propagates sender storage uncertainty without projecting a list", async () => {
    const runtime = harness();
    vi.mocked(runtime.binding.addTelegramAllowedSender).mockResolvedValueOnce({
      outcome: "uncertain",
      reason: "storage-uncertain",
    });

    await expect(runtime.coordinator.addAllowedSender({ senderId: 67890 })).resolves.toEqual({
      outcome: "uncertain",
      reason: "storage-uncertain",
    });
  });

  it.each([
    ["add", "rejected"],
    ["remove", "malformed"],
    ["add", "generation-swap"],
  ] as const)(
    "returns control uncertainty after a side-effecting %s RPC becomes %s",
    async (operation, terminal) => {
      const runtime = harness();
      const privateDetail = `private daemon path with ${TOKEN}`;
      if (operation === "remove") {
        runtime.setSenders({
          senders: [
            { senderId: 12345, role: "primary" },
            { senderId: 67890, role: "additional" },
          ],
        });
        const invoke = vi.mocked(runtime.binding.removeTelegramAllowedSender);
        const implementation = invoke.getMockImplementation()!;
        invoke.mockImplementationOnce(async (input) => {
          const result = await implementation(input);
          return { ...(result as object), privateDetail } as never;
        });
      } else {
        const invoke = vi.mocked(runtime.binding.addTelegramAllowedSender);
        const implementation = invoke.getMockImplementation()!;
        invoke.mockImplementationOnce(async (input) => {
          const result = await implementation(input);
          if (terminal === "rejected") throw new Error(privateDetail);
          runtime.setBinding({ ...runtime.binding, generation: 2 });
          return result;
        });
      }

      const result =
        operation === "add"
          ? await runtime.coordinator.addAllowedSender({ senderId: 67890 })
          : await runtime.coordinator.removeAllowedSender({ senderId: 67890 });

      expect(result).toEqual({ outcome: "uncertain", reason: "control-uncertain" });
      const persisted = (await runtime.binding.listTelegramAllowedSenders(
        {},
      )) as TelegramAllowedSendersResult;
      expect(persisted.senders.some((sender) => sender.senderId === 67890)).toBe(
        operation === "add",
      );
      expect(JSON.stringify(result)).not.toContain(privateDetail);
    },
  );

  it.each(["add", "remove"] as const)(
    "returns a definite control refusal before an unavailable %s RPC can be admitted",
    async (operation) => {
      const runtime = harness();
      runtime.setBinding(undefined);

      const result =
        operation === "add"
          ? await runtime.coordinator.addAllowedSender({ senderId: 67890 })
          : await runtime.coordinator.removeAllowedSender({ senderId: 67890 });

      expect(result).toEqual({ outcome: "refused", reason: "control-unavailable" });
      expect(runtime.binding.addTelegramAllowedSender).not.toHaveBeenCalled();
      expect(runtime.binding.removeTelegramAllowedSender).not.toHaveBeenCalled();
    },
  );

  it.each(["unavailable", "stale", "malformed", "rejected"] as const)(
    "rejects a sanitized allowed-sender load failure when the daemon response is %s",
    async (terminal) => {
      const runtime = harness();
      const privateDetail = "private daemon sender detail";
      if (terminal === "unavailable") {
        runtime.setBinding(undefined);
      } else if (terminal === "stale") {
        const list = vi.mocked(runtime.binding.listTelegramAllowedSenders);
        const implementation = list.getMockImplementation()!;
        list.mockImplementationOnce(async (input) => {
          const result = await implementation(input);
          runtime.setBinding({ ...runtime.binding, generation: 2 });
          return result;
        });
      } else if (terminal === "malformed") {
        vi.mocked(runtime.binding.listTelegramAllowedSenders).mockResolvedValueOnce({
          senders: [{ senderId: 12345, role: "primary" }],
          privateDetail,
        });
      } else {
        vi.mocked(runtime.binding.listTelegramAllowedSenders).mockRejectedValueOnce(
          new Error(privateDetail),
        );
      }

      const failure = await runtime.coordinator.listAllowedSenders().catch((error) => error);

      expect(failure).toBeInstanceOf(TypeError);
      expect((failure as TypeError).message).toBe("");
      expect(String(failure)).not.toContain(privateDetail);
    },
  );

  it("restores profile A and maps daemon release refusal to control-unavailable", async () => {
    const runtime = harness();
    vi.mocked(runtime.binding.replaceTelegram).mockResolvedValueOnce({
      outcome: "refused",
      reason: "release-refused",
      current: snapshot(),
    });

    await expect(runtime.coordinator.replace(REPLACEMENT_TOKEN)).resolves.toMatchObject({
      outcome: "refused",
      reason: "control-unavailable",
      current: {
        bot: { state: "ready", username: USERNAME },
        pairing: { state: "paired" },
      },
    });
    expect(runtime.profile()).toMatchObject({ token: TOKEN, bot: { id: BOT_ID } });
    expect(runtime.desired()).toBe(true);
    expect(runtime.vault.replaceProfile).toHaveBeenCalledTimes(2);
  });

  it("preserves desired state and pairing for a same-bot token rotation", async () => {
    const runtime = harness({
      inspection: {
        status: "ready",
        bot: { id: BOT_ID, username: OTHER_USERNAME },
      },
    });

    await expect(runtime.coordinator.replace(REPLACEMENT_TOKEN)).resolves.toEqual({
      outcome: "applied",
      current: {
        channel: { desiredState: "enabled", state: "online" },
        bot: { state: "ready", username: OTHER_USERNAME },
        pairing: { state: "paired" },
        credentialConfigured: true,
      },
    });
    expect(runtime.desired()).toBe(true);
    expect(runtime.vault.setDesiredState).not.toHaveBeenCalled();
    expect(runtime.profile()).toMatchObject({
      token: REPLACEMENT_TOKEN,
      bot: { id: BOT_ID, username: OTHER_USERNAME },
    });
    const suspendAt = runtime.trace.indexOf("daemon:suspend");
    const drainAt = runtime.trace.indexOf("daemon:drain");
    const storeAt = runtime.trace.indexOf(`vault:replace:${String(BOT_ID)}`);
    const replaceAt = runtime.trace.indexOf(`daemon:replace:${REPLACEMENT_TOKEN}`);
    const resumeAt = runtime.trace.indexOf("daemon:resume");
    expect(suspendAt).toBeLessThan(storeAt);
    expect(suspendAt).toBeLessThan(drainAt);
    expect(drainAt).toBeLessThan(storeAt);
    expect(storeAt).toBeLessThan(replaceAt);
    expect(replaceAt).toBeLessThan(resumeAt);
  });

  it("preserves an already-suspended same-bot replacement without resuming", async () => {
    const runtime = harness({
      inspection: {
        status: "ready",
        bot: { id: BOT_ID, username: OTHER_USERNAME },
      },
      daemonSnapshot: snapshot({ desiredState: "enabled", state: "suspended" }),
    });

    await expect(runtime.coordinator.replace(REPLACEMENT_TOKEN)).resolves.toMatchObject({
      outcome: "applied",
      current: {
        channel: { desiredState: "enabled", state: "suspended" },
        pairing: { state: "paired" },
      },
    });
    expect(runtime.binding.drainTelegram).toHaveBeenCalledOnce();
    expect(runtime.binding.resumeTelegramPolling).not.toHaveBeenCalled();
  });

  it("does not publish or pass B until the suspend release barrier settles", async () => {
    const runtime = harness({
      inspection: {
        status: "ready",
        bot: { id: BOT_ID, username: OTHER_USERNAME },
      },
    });
    let release!: (value: TelegramControlSnapshot) => void;
    vi.mocked(runtime.binding.suspendTelegramPolling).mockReturnValueOnce(
      new Promise<TelegramControlSnapshot>((resolve) => {
        release = resolve;
      }),
    );

    const replacement = runtime.coordinator.replace(REPLACEMENT_TOKEN);
    await vi.waitFor(() => expect(runtime.binding.suspendTelegramPolling).toHaveBeenCalledOnce());
    expect(runtime.vault.replaceProfile).not.toHaveBeenCalled();
    expect(runtime.binding.replaceTelegram).not.toHaveBeenCalled();

    release(snapshot({ desiredState: "enabled", state: "suspended" }));
    await expect(replacement).resolves.toMatchObject({ outcome: "applied" });
    expect(runtime.vault.replaceProfile).toHaveBeenCalledOnce();
    expect(runtime.binding.replaceTelegram).toHaveBeenCalledWith({ token: REPLACEMENT_TOKEN });
  });

  it("does not publish or pass B until the full drain barrier settles", async () => {
    const runtime = harness({
      inspection: {
        status: "ready",
        bot: { id: BOT_ID, username: OTHER_USERNAME },
      },
    });
    let release!: (value: TelegramControlSnapshot) => void;
    vi.mocked(runtime.binding.drainTelegram).mockReturnValueOnce(
      new Promise<TelegramControlSnapshot>((resolve) => {
        release = resolve;
      }),
    );

    const replacement = runtime.coordinator.replace(REPLACEMENT_TOKEN);
    await vi.waitFor(() => expect(runtime.binding.drainTelegram).toHaveBeenCalledOnce());
    expect(runtime.vault.replaceProfile).not.toHaveBeenCalled();
    expect(runtime.vault.setDesiredState).not.toHaveBeenCalled();
    expect(runtime.binding.replaceTelegram).not.toHaveBeenCalled();

    release(snapshot({ desiredState: "enabled", state: "suspended" }));
    await expect(replacement).resolves.toMatchObject({ outcome: "applied" });
    expect(runtime.vault.replaceProfile).toHaveBeenCalledOnce();
    expect(runtime.binding.replaceTelegram).toHaveBeenCalledWith({ token: REPLACEMENT_TOKEN });
  });

  it("fails uncertain without publishing B when generation changes during drain", async () => {
    const runtime = harness();
    vi.mocked(runtime.binding.drainTelegram).mockImplementationOnce(async () => {
      runtime.setBinding({ ...runtime.binding, generation: 2 });
      return snapshot({ desiredState: "enabled", state: "suspended" });
    });

    await expect(runtime.coordinator.replace(REPLACEMENT_TOKEN)).resolves.toMatchObject({
      outcome: "uncertain",
      reason: "control-uncertain",
    });
    expect(runtime.vault.replaceProfile).not.toHaveBeenCalled();
    expect(runtime.vault.setDesiredState).not.toHaveBeenCalled();
    expect(runtime.binding.replaceTelegram).not.toHaveBeenCalled();
  });

  it("never sends candidate B when the generation changes inside profile persistence", async () => {
    const runtime = harness();
    const replaceProfile = vi.mocked(runtime.vault.replaceProfile);
    const persistProfile = replaceProfile.getMockImplementation()!;
    replaceProfile.mockImplementationOnce(async (input) => {
      const result = await persistProfile(input);
      runtime.setBinding({ ...runtime.binding, generation: 2 });
      return result;
    });

    await expect(runtime.coordinator.replace(REPLACEMENT_TOKEN)).resolves.toMatchObject({
      outcome: "uncertain",
      reason: "control-uncertain",
    });
    expect(runtime.profile()).toMatchObject({ token: TOKEN, bot: { id: BOT_ID } });
    expect(runtime.desired()).toBe(true);
    expect(runtime.binding.replaceTelegram).not.toHaveBeenCalled();
    expect(runtime.binding.configureTelegram).not.toHaveBeenCalled();
  });

  it("never configures candidate B when initial profile persistence changes generation", async () => {
    const runtime = harness({
      configured: false,
      enabled: false,
      daemonSnapshot: {
        channel: { desiredState: "disabled", state: "disabled" },
        bot: { state: "unconfigured" },
        pairing: { state: "unpaired" },
      },
    });
    const replaceProfile = vi.mocked(runtime.vault.replaceProfile);
    const persistProfile = replaceProfile.getMockImplementation()!;
    replaceProfile.mockImplementationOnce(async (input) => {
      const result = await persistProfile(input);
      runtime.setBinding({ ...runtime.binding, generation: 2 });
      return result;
    });

    await expect(runtime.coordinator.configure(REPLACEMENT_TOKEN)).resolves.toMatchObject({
      outcome: "uncertain",
      reason: "control-uncertain",
    });
    expect(runtime.profile()).toBeUndefined();
    expect(runtime.desired()).toBe(false);
    expect(runtime.binding.configureTelegram).not.toHaveBeenCalled();
    expect(runtime.binding.replaceTelegram).not.toHaveBeenCalled();
  });

  it("resumes A and leaves persistence untouched when the drain deadline rejects", async () => {
    const runtime = harness();
    const before = runtime.profile();
    vi.mocked(runtime.binding.drainTelegram).mockRejectedValueOnce(
      new Error("drain deadline exceeded"),
    );

    await expect(runtime.coordinator.replace(REPLACEMENT_TOKEN)).resolves.toMatchObject({
      outcome: "refused",
      reason: "control-unavailable",
    });
    expect(runtime.profile()).toEqual(before);
    expect(runtime.desired()).toBe(true);
    expect(runtime.vault.replaceProfile).not.toHaveBeenCalled();
    expect(runtime.vault.setDesiredState).not.toHaveBeenCalled();
    expect(runtime.binding.replaceTelegram).not.toHaveBeenCalled();
    expect(runtime.binding.resumeTelegramPolling).toHaveBeenCalledOnce();
  });

  it("disables and requires pairing again for a different-bot replacement", async () => {
    const runtime = harness();

    await expect(runtime.coordinator.replace(REPLACEMENT_TOKEN)).resolves.toEqual({
      outcome: "applied",
      current: {
        channel: { desiredState: "disabled", state: "disabled" },
        bot: { state: "ready", username: OTHER_USERNAME },
        pairing: { state: "unpaired" },
        credentialConfigured: true,
      },
    });
    expect(runtime.desired()).toBe(false);
    expect(runtime.vault.setDesiredState).toHaveBeenCalledWith(false);
    expect(runtime.profile()).toMatchObject({
      token: REPLACEMENT_TOKEN,
      bot: { id: OTHER_BOT_ID, username: OTHER_USERNAME },
    });
    expect(runtime.trace.slice(runtime.trace.indexOf("daemon:drain"))).toEqual([
      "daemon:drain",
      "vault:desired:false",
      `vault:replace:${String(OTHER_BOT_ID)}`,
      `daemon:replace:${REPLACEMENT_TOKEN}`,
      "daemon:disable",
      "daemon:resume",
    ]);
    expect(runtime.binding.resumeTelegramPolling).toHaveBeenCalledOnce();
  });

  it("preserves a pre-existing power suspension after a different-bot replacement", async () => {
    const runtime = harness({
      daemonSnapshot: snapshot({ desiredState: "enabled", state: "suspended" }),
    });

    await expect(runtime.coordinator.replace(REPLACEMENT_TOKEN)).resolves.toMatchObject({
      outcome: "applied",
      current: {
        channel: { desiredState: "disabled", state: "disabled" },
        pairing: { state: "unpaired" },
      },
    });
    expect(runtime.binding.disableTelegram).toHaveBeenCalledOnce();
    expect(runtime.binding.resumeTelegramPolling).not.toHaveBeenCalled();
  });

  it("preserves a disabled power suspension whose snapshot cannot expose the lease", async () => {
    const runtime = harness({
      enabled: false,
      daemonSnapshot: snapshot({ desiredState: "disabled", state: "disabled" }),
    });

    await expect(runtime.coordinator.stopPolling()).resolves.toMatchObject({
      channel: { desiredState: "disabled", state: "disabled" },
    });
    await expect(runtime.coordinator.replace(REPLACEMENT_TOKEN)).resolves.toMatchObject({
      outcome: "applied",
      current: { channel: { desiredState: "disabled", state: "disabled" } },
    });
    expect(runtime.binding.resumeTelegramPolling).not.toHaveBeenCalled();

    await runtime.coordinator.resumePolling();
    expect(runtime.binding.resumeTelegramPolling).toHaveBeenCalledOnce();
  });

  it("conservatively preserves a power lease after losing the suspend response", async () => {
    const runtime = harness({
      enabled: false,
      daemonSnapshot: snapshot({ desiredState: "disabled", state: "disabled" }),
    });
    vi.mocked(runtime.binding.suspendTelegramPolling).mockRejectedValueOnce(
      new Error("suspend response unavailable"),
    );

    await runtime.coordinator.stopPolling();
    await expect(runtime.coordinator.replace(REPLACEMENT_TOKEN)).resolves.toMatchObject({
      outcome: "applied",
      current: { channel: { desiredState: "disabled", state: "disabled" } },
    });
    expect(runtime.binding.suspendTelegramPolling).toHaveBeenCalledTimes(2);
    expect(runtime.binding.resumeTelegramPolling).not.toHaveBeenCalled();

    await runtime.coordinator.resumePolling();
    expect(runtime.binding.resumeTelegramPolling).toHaveBeenCalledOnce();
  });

  it("retains power suspension ownership when resume still reports suspended", async () => {
    const runtime = harness({
      enabled: false,
      daemonSnapshot: snapshot({ desiredState: "disabled", state: "disabled" }),
    });
    await runtime.coordinator.stopPolling();
    vi.mocked(runtime.binding.resumeTelegramPolling).mockResolvedValueOnce(
      snapshot({ desiredState: "enabled", state: "suspended" }),
    );

    await runtime.coordinator.resumePolling();
    await expect(runtime.coordinator.replace(REPLACEMENT_TOKEN)).resolves.toMatchObject({
      outcome: "applied",
    });
    expect(runtime.binding.resumeTelegramPolling).toHaveBeenCalledOnce();
  });

  it("keeps a live pairing attempt durably enabled", async () => {
    const runtime = harness({
      enabled: true,
      daemonSnapshot: snapshot(undefined, { pairing: { state: "unpaired" } }),
    });
    vi.mocked(runtime.binding.replaceTelegram).mockResolvedValueOnce({
      outcome: "applied",
      current: snapshot(undefined, { pairing: { state: "unpaired" } }),
    });
    vi.mocked(runtime.binding.beginTelegramPairing).mockResolvedValueOnce(
      snapshot(
        { desiredState: "enabled", state: "online" },
        {
          pairing: {
            state: "awaiting-code",
            code: "ABCDEF",
            expiresAt: "2026-08-05T12:01:00.000Z",
          },
        },
      ),
    );

    await expect(runtime.coordinator.beginPairing()).resolves.toMatchObject({
      outcome: "applied",
      current: {
        channel: { desiredState: "enabled", state: "online" },
        pairing: { state: "awaiting-code", code: "ABCDEF" },
      },
    });
    expect(runtime.desired()).toBe(true);
    expect(runtime.vault.setDesiredState).toHaveBeenCalledWith(true);
    expect(runtime.vault.setDesiredState).not.toHaveBeenCalledWith(false);
    expect(runtime.binding.enableTelegram).not.toHaveBeenCalled();
  });

  it("preserves an already paired bot when begin pairing is invoked idempotently", async () => {
    const runtime = harness({ enabled: true });

    await expect(runtime.coordinator.beginPairing()).resolves.toMatchObject({
      outcome: "applied",
      current: {
        channel: { desiredState: "enabled", state: "online" },
        pairing: { state: "paired" },
      },
    });
    expect(runtime.desired()).toBe(true);
    expect(runtime.vault.setDesiredState).toHaveBeenCalledOnce();
    expect(runtime.vault.setDesiredState).toHaveBeenCalledWith(true);
    expect(runtime.binding.beginTelegramPairing).not.toHaveBeenCalled();
  });

  it("fails closed when a pairing profile load is refused with stale enabled intent", async () => {
    const runtime = harness({
      enabled: true,
      daemonSnapshot: snapshot(undefined, { pairing: { state: "unpaired" } }),
    });
    runtime.setSenders({ senders: [] });
    vi.mocked(runtime.vault.applyStoredProfile).mockResolvedValueOnce({
      outcome: "refused",
      reason: "missing",
    });

    await expect(runtime.coordinator.beginPairing()).resolves.toMatchObject({
      outcome: "refused",
      reason: "invalid-state",
    });
    expect(runtime.desired()).toBe(false);
    expect(runtime.vault.setDesiredState).toHaveBeenNthCalledWith(1, true);
    expect(runtime.vault.setDesiredState).toHaveBeenNthCalledWith(2, false);
    expect(runtime.binding.cancelTelegramPairing).toHaveBeenCalledOnce();
    expect(runtime.binding.disableTelegram).toHaveBeenCalledOnce();
    expect(runtime.binding.drainTelegram).toHaveBeenCalledOnce();
    expect(runtime.binding.beginTelegramPairing).not.toHaveBeenCalled();
  });

  it("does not project a contradictory unconfigured paired daemon as applied", async () => {
    const runtime = harness({
      daemonSnapshot: {
        channel: { desiredState: "enabled", state: "online" },
        bot: { state: "unconfigured" },
        pairing: { state: "paired" },
      },
    });

    await expect(runtime.coordinator.beginPairing()).resolves.toMatchObject({
      outcome: "uncertain",
      reason: "control-uncertain",
    });
    expect(runtime.vault.applyStoredProfile).toHaveBeenCalledOnce();
    expect(runtime.binding.configureTelegram).toHaveBeenCalledWith({ token: TOKEN });
    expect(runtime.binding.beginTelegramPairing).not.toHaveBeenCalled();
  });

  it("enables a successful explicit pairing settlement from disabled intent", async () => {
    const runtime = harness({
      enabled: false,
      daemonSnapshot: snapshot(
        { desiredState: "disabled", state: "disabled" },
        { pairing: { state: "unpaired" } },
      ),
    });
    const paired = snapshot(undefined, { pairing: { state: "paired" } });
    vi.mocked(runtime.binding.beginTelegramPairing).mockImplementationOnce(async () => {
      runtime.setSnapshot(paired);
      return paired;
    });

    await expect(runtime.coordinator.beginPairing()).resolves.toMatchObject({
      outcome: "applied",
      current: {
        channel: { desiredState: "enabled" },
        pairing: { state: "paired" },
      },
    });
    expect(runtime.desired()).toBe(true);
    expect(runtime.vault.setDesiredState).toHaveBeenCalledWith(true);
    expect(runtime.vault.setDesiredState).not.toHaveBeenCalledWith(false);
  });

  it("restores durable intent when pairing loses its daemon generation", async () => {
    const runtime = harness({
      enabled: true,
      daemonSnapshot: snapshot(undefined, { pairing: { state: "unpaired" } }),
    });
    vi.mocked(runtime.binding.beginTelegramPairing).mockImplementationOnce(async () => {
      runtime.setBinding({ ...runtime.binding, generation: 2 });
      return snapshot(undefined, {
        pairing: {
          state: "awaiting-code",
          code: "ABCDEF",
          expiresAt: "2026-08-05T12:01:00.000Z",
        },
      });
    });

    await expect(runtime.coordinator.beginPairing()).resolves.toMatchObject({
      outcome: "uncertain",
      reason: "control-uncertain",
    });
    expect(runtime.desired()).toBe(true);
    expect(runtime.vault.setDesiredState).not.toHaveBeenCalledWith(false);
  });

  it("refuses a failed pairing only after restoring disabled runtime intent", async () => {
    const runtime = harness({
      enabled: false,
      daemonSnapshot: snapshot(
        { desiredState: "disabled", state: "disabled" },
        { pairing: { state: "unpaired" } },
      ),
    });
    runtime.setSenders({ senders: [] });
    vi.mocked(runtime.binding.beginTelegramPairing).mockResolvedValueOnce({
      channel: { desiredState: "enabled", state: "failed", errorCode: "telegram-start-failed" },
      bot: { state: "ready", username: USERNAME },
      pairing: { state: "failed", errorCode: "telegram-pairing-unavailable" },
    });
    vi.mocked(runtime.binding.cancelTelegramPairing).mockResolvedValueOnce(
      snapshot({ desiredState: "disabled", state: "disabled" }, { pairing: { state: "unpaired" } }),
    );

    await expect(runtime.coordinator.beginPairing()).resolves.toMatchObject({
      outcome: "refused",
      reason: "invalid-state",
      current: { channel: { desiredState: "disabled", state: "disabled" } },
    });
    expect(runtime.desired()).toBe(false);
    expect(runtime.binding.cancelTelegramPairing).toHaveBeenCalledOnce();
    expect(runtime.binding.disableTelegram).toHaveBeenCalledOnce();
  });

  it("preserves pairing storage uncertainty while sealing and draining temporary admission", async () => {
    const uncertainPairing = {
      state: "failed" as const,
      errorCode: "telegram-pairing-storage-uncertain" as const,
    };
    const runtime = harness({
      enabled: true,
      daemonSnapshot: snapshot(
        { desiredState: "disabled", state: "disabled" },
        { pairing: uncertainPairing },
      ),
    });

    await expect(runtime.coordinator.status()).resolves.toMatchObject({
      channel: { desiredState: "disabled", state: "disabled" },
      pairing: uncertainPairing,
    });
    expect(runtime.desired()).toBe(false);
    expect(runtime.vault.setDesiredState).toHaveBeenCalledWith(false);
    expect(runtime.binding.disableTelegram).toHaveBeenCalledOnce();
    expect(runtime.binding.drainTelegram).toHaveBeenCalledOnce();
    expect(runtime.binding.cancelTelegramPairing).not.toHaveBeenCalled();
  });

  it("returns a warning outcome when pairing reaches storage uncertainty during begin", async () => {
    const uncertain = snapshot(
      { desiredState: "disabled", state: "disabled" },
      {
        pairing: { state: "failed", errorCode: "telegram-pairing-storage-uncertain" },
      },
    );
    const runtime = harness({
      enabled: false,
      daemonSnapshot: snapshot(
        { desiredState: "disabled", state: "disabled" },
        { pairing: { state: "unpaired" } },
      ),
    });
    runtime.setSenders({ senders: [] });
    vi.mocked(runtime.binding.beginTelegramPairing).mockImplementationOnce(async () => {
      runtime.setSnapshot(uncertain);
      return uncertain;
    });

    await expect(runtime.coordinator.beginPairing()).resolves.toMatchObject({
      outcome: "uncertain",
      reason: "storage-uncertain",
      current: {
        channel: { desiredState: "disabled", state: "disabled" },
        pairing: { state: "failed", errorCode: "telegram-pairing-storage-uncertain" },
      },
    });
    expect(runtime.desired()).toBe(false);
    expect(runtime.binding.disableTelegram).toHaveBeenCalledOnce();
    expect(runtime.binding.drainTelegram).toHaveBeenCalledOnce();
    expect(runtime.binding.cancelTelegramPairing).not.toHaveBeenCalled();
  });

  it("does not label an unchanged awaiting-code cancellation as applied", async () => {
    const awaiting = {
      state: "awaiting-code" as const,
      code: "ABCDEF",
      expiresAt: "2026-08-05T12:01:00.000Z",
    };
    const runtime = harness({
      enabled: true,
      daemonSnapshot: snapshot(
        { desiredState: "enabled", state: "starting" },
        { pairing: awaiting },
      ),
    });

    await expect(runtime.coordinator.cancelPairing()).resolves.toMatchObject({
      outcome: "refused",
      reason: "invalid-state",
      current: { pairing: awaiting },
    });
    expect(runtime.desired()).toBe(true);
    expect(runtime.vault.setDesiredState).not.toHaveBeenCalledWith(false);
  });

  it("keeps durable disabled intent when cancellation leaves pairing active", async () => {
    const awaiting = {
      state: "awaiting-code" as const,
      code: "ABCDEF",
      expiresAt: "2026-08-05T12:01:00.000Z",
    };
    const runtime = harness({
      enabled: false,
      daemonSnapshot: snapshot(
        { desiredState: "enabled", state: "starting" },
        { pairing: awaiting },
      ),
    });

    await expect(runtime.coordinator.cancelPairing()).resolves.toMatchObject({
      outcome: "refused",
      reason: "invalid-state",
      current: {
        channel: { desiredState: "disabled", state: "disabled" },
        pairing: awaiting,
      },
    });
    expect(runtime.desired()).toBe(false);
    expect(runtime.vault.setDesiredState).not.toHaveBeenCalled();
    expect(runtime.binding.enableTelegram).not.toHaveBeenCalled();
    expect(runtime.binding.disableTelegram).toHaveBeenCalledOnce();
  });

  it("fences new work, clears pairing timers, and drains an accepted removal on close", async () => {
    const clock = leaseScheduler();
    const awaiting = snapshot(
      { desiredState: "enabled", state: "starting" },
      {
        pairing: {
          state: "awaiting-code",
          code: "ABCDEF",
          expiresAt: "2026-08-05T12:01:00.000Z",
        },
      },
    );
    const runtime = harness({
      enabled: false,
      pairingLease: clock.port,
      daemonSnapshot: snapshot(undefined, { pairing: { state: "unpaired" } }),
    });
    vi.mocked(runtime.binding.beginTelegramPairing).mockImplementationOnce(async () => {
      runtime.setSnapshot(awaiting);
      return awaiting;
    });
    await runtime.coordinator.beginPairing();
    expect(clock.entries).toHaveLength(1);

    const disabled = deferred<TelegramControlSnapshot>();
    vi.mocked(runtime.binding.disableTelegram).mockReturnValueOnce(disabled.promise);
    const removal = runtime.coordinator.remove();
    await vi.waitFor(() => expect(runtime.binding.disableTelegram).toHaveBeenCalledOnce());

    const firstClose = runtime.coordinator.close();
    const secondClose = runtime.coordinator.close();
    const daemonClose = vi.fn();
    const exit = vi.fn();
    const shutdown = (async () => {
      await firstClose;
      daemonClose();
      exit();
    })();
    let closeSettled = false;
    void firstClose.then(() => {
      closeSettled = true;
    });

    expect(secondClose).toBe(firstClose);
    expect(clock.entries[0]?.cancelled).toBe(true);
    clock.fire(0, true);
    await Promise.resolve();
    expect(runtime.binding.cancelTelegramPairing).not.toHaveBeenCalled();
    await expect(runtime.coordinator.status()).rejects.toBeInstanceOf(TypeError);
    expect(closeSettled).toBe(false);
    expect(daemonClose).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();

    const disabledSnapshot = snapshot(
      { desiredState: "disabled", state: "disabled" },
      { pairing: awaiting.pairing },
    );
    runtime.setSnapshot(disabledSnapshot);
    disabled.resolve(disabledSnapshot);
    await expect(removal).resolves.toMatchObject({ outcome: "applied" });
    await shutdown;
    expect(closeSettled).toBe(true);
    expect(daemonClose).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });

  it("expires a live app-owned pairing lease without renderer polling", async () => {
    const clock = leaseScheduler();
    const awaiting = snapshot(undefined, {
      pairing: {
        state: "awaiting-code",
        code: "ABCDEF",
        expiresAt: "2026-08-05T12:01:00.000Z",
      },
    });
    const runtime = harness({
      enabled: false,
      pairingLease: clock.port,
      daemonSnapshot: snapshot(undefined, { pairing: { state: "unpaired" } }),
    });
    runtime.setSenders({ senders: [] });
    vi.mocked(runtime.binding.beginTelegramPairing).mockImplementationOnce(async () => {
      runtime.setSnapshot(awaiting);
      return awaiting;
    });
    vi.mocked(runtime.binding.cancelTelegramPairing).mockImplementationOnce(async () => {
      const unpaired = snapshot(undefined, { pairing: { state: "unpaired" } });
      runtime.setSnapshot(unpaired);
      return unpaired;
    });

    await expect(runtime.coordinator.beginPairing()).resolves.toMatchObject({
      outcome: "applied",
      current: { pairing: { state: "awaiting-code" } },
    });
    expect(clock.entries[0]?.delayMs).toBe(60_000);

    clock.setNow("2026-08-05T12:01:00.000Z");
    clock.fire(0);
    await vi.waitFor(() => expect(runtime.desired()).toBe(false));
    expect(runtime.binding.cancelTelegramPairing).toHaveBeenCalledOnce();
    expect(runtime.binding.disableTelegram).toHaveBeenCalledOnce();
    expect(runtime.binding.drainTelegram).toHaveBeenCalledOnce();
  });

  it("cancels an armed pairing lease after deletion", async () => {
    const clock = leaseScheduler();
    const awaiting = snapshot(undefined, {
      pairing: {
        state: "awaiting-code",
        code: "ABCDEF",
        expiresAt: "2026-08-05T12:01:00.000Z",
      },
    });
    const runtime = harness({
      enabled: false,
      pairingLease: clock.port,
      daemonSnapshot: snapshot(undefined, { pairing: { state: "unpaired" } }),
    });
    runtime.setSenders({ senders: [] });
    vi.mocked(runtime.binding.beginTelegramPairing).mockImplementationOnce(async () => {
      runtime.setSnapshot(awaiting);
      return awaiting;
    });

    await runtime.coordinator.beginPairing();
    expect(clock.entries).toHaveLength(1);
    await expect(runtime.coordinator.remove()).resolves.toMatchObject({ outcome: "applied" });
    expect(runtime.vault.deleteProfile).toHaveBeenCalledOnce();
    expect(clock.entries[0]?.cancelled).toBe(true);

    vi.mocked(runtime.binding.cancelTelegramPairing).mockClear();
    vi.mocked(runtime.binding.disableTelegram).mockClear();
    vi.mocked(runtime.binding.drainTelegram).mockClear();
    vi.mocked(runtime.binding.enableTelegram).mockClear();
    vi.mocked(runtime.binding.reconcileTelegram).mockClear();
    clock.setNow("2026-08-05T12:01:00.000Z");
    clock.fire(0, true);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(runtime.binding.cancelTelegramPairing).not.toHaveBeenCalled();
    expect(runtime.binding.disableTelegram).not.toHaveBeenCalled();
    expect(runtime.binding.drainTelegram).not.toHaveBeenCalled();
    expect(runtime.binding.enableTelegram).not.toHaveBeenCalled();
    expect(runtime.binding.reconcileTelegram).not.toHaveBeenCalled();
  });

  it("preserves durable enabled truth when a pairing claim wins at lease expiry", async () => {
    const clock = leaseScheduler();
    const awaiting = snapshot(undefined, {
      pairing: {
        state: "awaiting-code",
        code: "ABCDEF",
        expiresAt: "2026-08-05T12:01:00.000Z",
      },
    });
    const runtime = harness({ pairingLease: clock.port, daemonSnapshot: awaiting });
    vi.mocked(runtime.binding.beginTelegramPairing).mockResolvedValueOnce(awaiting);

    await runtime.coordinator.beginPairing();
    runtime.setSnapshot(snapshot(undefined, { pairing: { state: "paired" } }));
    clock.setNow("2026-08-05T12:01:00.000Z");
    clock.fire(0);

    await vi.waitFor(() => expect(runtime.binding.getTelegramStatus).toHaveBeenCalled());
    expect(runtime.desired()).toBe(true);
    expect(runtime.binding.cancelTelegramPairing).not.toHaveBeenCalled();
    expect(runtime.binding.disableTelegram).not.toHaveBeenCalled();
  });

  it("prevents a cancelled pairing lease from re-enabling an explicitly disabled bot", async () => {
    const clock = leaseScheduler();
    const awaiting = snapshot(undefined, {
      pairing: {
        state: "awaiting-code",
        code: "ABCDEF",
        expiresAt: "2026-08-05T12:01:00.000Z",
      },
    });
    const runtime = harness({
      enabled: false,
      pairingLease: clock.port,
      daemonSnapshot: snapshot(
        { desiredState: "disabled", state: "disabled" },
        { pairing: { state: "unpaired" } },
      ),
    });
    vi.mocked(runtime.binding.beginTelegramPairing).mockImplementationOnce(async () => {
      runtime.setSnapshot(awaiting);
      return awaiting;
    });

    await runtime.coordinator.beginPairing();
    expect(clock.entries).toHaveLength(1);
    vi.mocked(runtime.vault.setDesiredState).mockClear();
    vi.mocked(runtime.binding.enableTelegram).mockClear();
    vi.mocked(runtime.binding.disableTelegram).mockClear();

    await runtime.coordinator.disable();
    expect(clock.entries[0]?.cancelled).toBe(true);
    runtime.setSnapshot(
      snapshot({ desiredState: "disabled", state: "disabled" }, { pairing: { state: "paired" } }),
    );
    clock.fire(0, true);

    await expect(runtime.coordinator.status()).resolves.toMatchObject({
      channel: { desiredState: "disabled", state: "disabled" },
      pairing: { state: "paired" },
    });
    expect(runtime.desired()).toBe(false);
    expect(vi.mocked(runtime.vault.setDesiredState).mock.calls).toEqual([[false]]);
    expect(runtime.binding.enableTelegram).not.toHaveBeenCalled();
    expect(runtime.binding.disableTelegram).toHaveBeenCalledOnce();
  });

  it("consumes a failed paired-lease expiry and retries until the lease is cleared", async () => {
    const clock = leaseScheduler();
    const awaiting = snapshot(undefined, {
      pairing: {
        state: "awaiting-code",
        code: "ABCDEF",
        expiresAt: "2026-08-05T12:01:00.000Z",
      },
    });
    const runtime = harness({ pairingLease: clock.port, daemonSnapshot: awaiting });
    vi.mocked(runtime.binding.beginTelegramPairing).mockResolvedValueOnce(awaiting);
    await runtime.coordinator.beginPairing();
    runtime.setSnapshot(snapshot(undefined, { pairing: { state: "paired" } }));

    const profileStatus = vi.mocked(runtime.vault.profileStatus);
    const readProfile = profileStatus.getMockImplementation()!;
    let rejectProfile!: (reason: unknown) => void;
    profileStatus.mockClear();
    profileStatus.mockImplementationOnce(
      () =>
        new Promise<Awaited<ReturnType<typeof readProfile>>>((_resolve, reject) => {
          rejectProfile = reject;
        }),
    );
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      clock.setNow("2026-08-05T12:01:00.000Z");
      clock.fire(0);
      await vi.waitFor(() => expect(profileStatus).toHaveBeenCalledOnce());
      rejectProfile(new Error("synthetic profile read failure"));

      await vi.waitFor(() => expect(clock.entries).toHaveLength(2));
      expect(clock.entries[1]?.delayMs).toBe(1_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();

      clock.fire(1);
      await vi.waitFor(() => expect(profileStatus).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(clock.entries[1]?.cancelled).toBe(true));
      expect(runtime.desired()).toBe(true);
      expect(runtime.binding.cancelTelegramPairing).not.toHaveBeenCalled();
      expect(runtime.binding.disableTelegram).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
      await runtime.coordinator.close();
    }
  });

  it("prevents an expired lease from mutating a successor generation", async () => {
    const clock = leaseScheduler();
    const first = snapshot(undefined, {
      pairing: {
        state: "awaiting-code",
        code: "ABCDEF",
        expiresAt: "2026-08-05T12:01:00.000Z",
      },
    });
    const runtime = harness({ pairingLease: clock.port, daemonSnapshot: first });
    vi.mocked(runtime.binding.beginTelegramPairing).mockResolvedValueOnce(first);
    await runtime.coordinator.beginPairing();
    const successor = { ...runtime.binding, generation: 2 };
    runtime.setBinding(successor);
    runtime.setSnapshot(
      snapshot(undefined, {
        pairing: {
          state: "awaiting-code",
          code: "FEDCBA",
          expiresAt: "2026-08-05T12:02:00.000Z",
        },
      }),
    );
    await runtime.coordinator.status();

    clock.setNow("2026-08-05T12:01:00.000Z");
    clock.fire(0, true);
    await Promise.resolve();
    await Promise.resolve();

    expect(runtime.desired()).toBe(true);
    expect(runtime.binding.cancelTelegramPairing).not.toHaveBeenCalled();
    expect(clock.entries).toHaveLength(2);
  });

  it("compensates an expired generation whose durable write completes after takeover", async () => {
    const clock = leaseScheduler();
    const awaiting = snapshot(undefined, {
      pairing: {
        state: "awaiting-code",
        code: "ABCDEF",
        expiresAt: "2026-08-05T12:01:00.000Z",
      },
    });
    const runtime = harness({
      enabled: false,
      pairingLease: clock.port,
      daemonSnapshot: snapshot(undefined, { pairing: { state: "unpaired" } }),
    });
    runtime.setSenders({ senders: [] });
    vi.mocked(runtime.binding.beginTelegramPairing).mockImplementationOnce(async () => {
      runtime.setSnapshot(awaiting);
      return awaiting;
    });
    vi.mocked(runtime.binding.cancelTelegramPairing).mockImplementationOnce(async () => {
      const unpaired = snapshot(undefined, { pairing: { state: "unpaired" } });
      runtime.setSnapshot(unpaired);
      return unpaired;
    });

    await runtime.coordinator.beginPairing();
    const setDesired = vi.mocked(runtime.vault.setDesiredState);
    const writeDesired = setDesired.getMockImplementation()!;
    setDesired.mockClear();
    let releaseWrite!: () => Promise<void>;
    setDesired.mockImplementationOnce(
      (enabled) =>
        new Promise((resolve) => {
          releaseWrite = async () => resolve(await writeDesired(enabled));
        }),
    );

    clock.setNow("2026-08-05T12:01:00.000Z");
    clock.fire(0);
    await vi.waitFor(() => expect(setDesired).toHaveBeenCalledWith(false));
    runtime.setBinding({ ...runtime.binding, generation: 2 });
    runtime.setSnapshot(snapshot(undefined, { pairing: { state: "paired" } }));
    await releaseWrite();

    await vi.waitFor(() => expect(runtime.desired()).toBe(true));
    expect(setDesired.mock.calls).toEqual([[false], [true]]);
  });

  it("keeps shared durable disabled intent during a paired coordinator takeover", async () => {
    const runtime = harness({ enabled: false });
    const profileReadStarted = deferred<void>();
    const releaseProfileRead = deferred<void>();
    const profileStatus = vi.mocked(runtime.vault.profileStatus);
    const readProfile = profileStatus.getMockImplementation()!;
    profileStatus.mockImplementationOnce(async () => {
      profileReadStarted.resolve();
      await releaseProfileRead.promise;
      return readProfile();
    });
    const successor = { ...runtime.binding, generation: 2 };
    let staleCurrent: TelegramDaemonBinding | undefined = runtime.binding;
    const stale = createTelegramControlCoordinator({
      selectedAthleteHome: () => HOME,
      vault: runtime.vault,
      daemon: { current: () => staleCurrent },
    });
    const current = createTelegramControlCoordinator({
      selectedAthleteHome: () => HOME,
      vault: runtime.vault,
      daemon: { current: () => successor },
    });

    const staleStatus = stale.status();
    await profileReadStarted.promise;
    staleCurrent = successor;
    releaseProfileRead.resolve();

    await expect(staleStatus).resolves.toMatchObject({
      channel: { desiredState: "disabled", state: "disabled" },
      pairing: { state: "paired" },
    });
    await expect(current.status()).resolves.toMatchObject({
      channel: { desiredState: "disabled", state: "disabled" },
      pairing: { state: "paired" },
    });
    expect(runtime.desired()).toBe(false);
    expect(runtime.vault.setDesiredState).not.toHaveBeenCalled();
    expect(runtime.binding.enableTelegram).not.toHaveBeenCalled();
    expect(runtime.binding.disableTelegram).toHaveBeenCalledOnce();
  });

  it("repairs a restart crash window with no primary or live pairing", async () => {
    const runtime = harness({
      enabled: true,
      daemonSnapshot: snapshot(undefined, { pairing: { state: "unpaired" } }),
    });
    runtime.setSenders({ senders: [] });

    await expect(runtime.coordinator.status()).resolves.toMatchObject({
      channel: { desiredState: "disabled", state: "disabled" },
      pairing: { state: "unpaired" },
    });
    expect(runtime.desired()).toBe(false);
    expect(runtime.binding.cancelTelegramPairing).toHaveBeenCalledOnce();
    expect(runtime.binding.disableTelegram).toHaveBeenCalledOnce();
    expect(runtime.binding.drainTelegram).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "uncertain",
      { state: "uncertain", enabled: false } as const,
      "telegram-settings-storage-uncertain" as const,
    ],
    [
      "wrong-home",
      { state: "wrong-home", enabled: false } as const,
      "telegram-home-mismatch" as const,
    ],
    [
      "re-prompt",
      { state: "re-prompt", enabled: false } as const,
      "telegram-settings-storage-uncertain" as const,
    ],
  ])(
    "projects repair-required %s desired state without letting status or reconcile rewrite intent",
    async (_state, desiredState, errorCode) => {
      const statusRuntime = harness({
        daemonSnapshot: snapshot(undefined, { pairing: { state: "unpaired" } }),
      });
      vi.mocked(statusRuntime.vault.desiredState).mockResolvedValue(desiredState);

      await expect(statusRuntime.coordinator.status()).resolves.toMatchObject({
        channel: { desiredState: "enabled", state: "failed", errorCode },
        bot: { state: "ready", username: USERNAME },
        pairing: { state: "unpaired" },
        credentialConfigured: true,
      });
      expectNoTelegramMutation(statusRuntime);

      const reconcileRuntime = harness({
        daemonSnapshot: snapshot(
          { desiredState: "disabled", state: "disabled" },
          { pairing: { state: "unpaired" } },
        ),
      });
      vi.mocked(reconcileRuntime.vault.desiredState).mockResolvedValue(desiredState);

      await expect(reconcileRuntime.coordinator.reconcile()).resolves.toMatchObject({
        outcome: "uncertain",
        reason: "storage-uncertain",
        current: {
          channel: { desiredState: "disabled", state: "failed", errorCode },
          pairing: { state: "unpaired" },
        },
      });
      expectNoTelegramMutation(reconcileRuntime);
    },
  );

  it("projects repair-required settings conservatively without a trustworthy daemon snapshot", async () => {
    const runtime = harness();
    runtime.setBinding(undefined);
    vi.mocked(runtime.vault.desiredState).mockResolvedValue({ state: "uncertain", enabled: false });

    await expect(runtime.coordinator.status()).resolves.toMatchObject({
      channel: {
        desiredState: "enabled",
        state: "failed",
        errorCode: "telegram-settings-storage-uncertain",
      },
    });
    await expect(runtime.coordinator.addAllowedSender({ senderId: 303 })).resolves.toEqual({
      outcome: "uncertain",
      reason: "storage-uncertain",
    });
    expectNoTelegramMutation(runtime);
  });

  it.each(repairRequiredMutationCases)(
    "blocks %s before daemon or vault mutation when desired intent requires repair",
    async (_operation, invoke) => {
      const runtime = harness();
      vi.mocked(runtime.vault.desiredState).mockResolvedValue({
        state: "uncertain",
        enabled: false,
      });

      await invoke(runtime);

      expectNoTelegramMutation(runtime);
    },
  );

  it("reconciles a paired online daemon to durable disabled intent", async () => {
    const runtime = harness({
      enabled: false,
      daemonSnapshot: snapshot(undefined, { pairing: { state: "paired" } }),
    });

    await expect(runtime.coordinator.reconcile()).resolves.toMatchObject({
      outcome: "applied",
      current: {
        channel: { desiredState: "disabled", state: "disabled" },
        pairing: { state: "paired" },
      },
    });
    expect(runtime.desired()).toBe(false);
    expect(runtime.vault.setDesiredState).not.toHaveBeenCalled();
    expect(runtime.binding.enableTelegram).not.toHaveBeenCalled();
    expect(runtime.binding.disableTelegram).toHaveBeenCalledOnce();
  });

  it("preserves an encryption-unavailable refusal while reconciling a stored profile", async () => {
    const runtime = harness();
    vi.mocked(runtime.vault.applyStoredProfile).mockResolvedValueOnce({
      outcome: "refused",
      reason: "encryption-unavailable",
    });

    await expect(runtime.coordinator.reconcile()).resolves.toMatchObject({
      outcome: "refused",
      reason: "encryption-unavailable",
      current: {
        channel: {
          desiredState: "enabled",
          state: "failed",
          errorCode: "telegram-credential-encryption-unavailable",
        },
        bot: { state: "ready", username: USERNAME },
        pairing: { state: "paired" },
        credentialConfigured: true,
      },
    });
    expect(runtime.desired()).toBe(true);
    expect(runtime.binding.configureTelegram).not.toHaveBeenCalled();
    expect(runtime.binding.replaceTelegram).not.toHaveBeenCalled();
    expect(runtime.binding.enableTelegram).not.toHaveBeenCalled();
    expect(runtime.binding.disableTelegram).not.toHaveBeenCalled();
  });

  it("reconciles stale enabled intent to disabled when no pairing or primary exists", async () => {
    const runtime = harness({
      enabled: true,
      daemonSnapshot: snapshot(
        { desiredState: "disabled", state: "disabled" },
        { pairing: { state: "unpaired" } },
      ),
    });
    runtime.setSenders({ senders: [] });

    await expect(runtime.coordinator.reconcile()).resolves.toMatchObject({
      outcome: "applied",
      current: {
        channel: { desiredState: "disabled", state: "disabled" },
        pairing: { state: "unpaired" },
      },
    });
    expect(runtime.desired()).toBe(false);
    expect(runtime.binding.cancelTelegramPairing).toHaveBeenCalled();
    expect(runtime.binding.disableTelegram).toHaveBeenCalled();
    expect(runtime.binding.drainTelegram).toHaveBeenCalled();
  });

  it("uses terminal cancel truth when a claim wins the cancel race", async () => {
    const runtime = harness({
      enabled: true,
      daemonSnapshot: snapshot(undefined, {
        pairing: {
          state: "awaiting-code",
          code: "ABCDEF",
          expiresAt: "2026-08-05T12:01:00.000Z",
        },
      }),
    });
    vi.mocked(runtime.binding.cancelTelegramPairing).mockResolvedValueOnce(
      snapshot(undefined, { pairing: { state: "paired" } }),
    );

    await expect(runtime.coordinator.cancelPairing()).resolves.toMatchObject({
      outcome: "applied",
      current: { pairing: { state: "paired" } },
    });
    expect(runtime.desired()).toBe(true);
    expect(runtime.vault.setDesiredState).not.toHaveBeenCalledWith(false);
    expect(runtime.binding.disableTelegram).not.toHaveBeenCalled();
  });

  it("keeps durable disabled intent when cancellation observes a paired bot", async () => {
    const runtime = harness({
      enabled: false,
      daemonSnapshot: snapshot(undefined, { pairing: { state: "paired" } }),
    });

    await expect(runtime.coordinator.cancelPairing()).resolves.toMatchObject({
      outcome: "applied",
      current: {
        channel: { desiredState: "disabled", state: "disabled" },
        pairing: { state: "paired" },
      },
    });
    expect(runtime.desired()).toBe(false);
    expect(runtime.vault.setDesiredState).not.toHaveBeenCalled();
    expect(runtime.binding.enableTelegram).not.toHaveBeenCalled();
    expect(runtime.binding.disableTelegram).toHaveBeenCalledOnce();
  });

  it("restores prior durable intent after an uncertain pairing profile load", async () => {
    const runtime = harness({
      enabled: false,
      daemonSnapshot: snapshot(undefined, { pairing: { state: "unpaired" } }),
    });
    runtime.setSenders({ senders: [] });
    vi.mocked(runtime.vault.applyStoredProfile).mockResolvedValueOnce({
      outcome: "uncertain",
      reason: "storage-uncertain",
    });

    await expect(runtime.coordinator.beginPairing()).resolves.toMatchObject({
      outcome: "uncertain",
      reason: "storage-uncertain",
    });
    expect(runtime.desired()).toBe(false);
    expect(runtime.vault.setDesiredState).toHaveBeenNthCalledWith(1, true);
    expect(runtime.vault.setDesiredState).toHaveBeenNthCalledWith(2, false);
    expect(runtime.binding.beginTelegramPairing).not.toHaveBeenCalled();
  });

  it.each([
    ["unconfigured", { state: "unconfigured" } as const],
    ["wrong username", { state: "ready", username: USERNAME } as const],
  ])(
    "rolls back an initially configured daemon that reports %s as applied",
    async (_label, bot) => {
      const runtime = harness({
        configured: false,
        enabled: false,
        daemonSnapshot: {
          channel: { desiredState: "disabled", state: "disabled" },
          bot: { state: "unconfigured" },
          pairing: { state: "unpaired" },
        },
      });
      vi.mocked(runtime.binding.configureTelegram).mockResolvedValueOnce({
        outcome: "applied",
        current: {
          channel: { desiredState: "disabled", state: "disabled" },
          bot,
          pairing: { state: "unpaired" },
        },
      });

      await expect(runtime.coordinator.configure(REPLACEMENT_TOKEN)).resolves.toMatchObject({
        outcome: "refused",
        reason: "invalid-state",
      });
      expect(runtime.profile()).toBeUndefined();
      expect(runtime.binding.forgetTelegramCredential).toHaveBeenCalledOnce();
    },
  );

  it("reports access uncertainty when a different-bot applied response has the wrong username", async () => {
    const runtime = harness();
    const resetAccess = snapshot(
      { desiredState: "disabled", state: "disabled" },
      { username: USERNAME, pairing: { state: "unpaired" } },
    );
    vi.mocked(runtime.binding.replaceTelegram).mockImplementationOnce(async () => {
      runtime.setSnapshot(resetAccess);
      return { outcome: "applied", current: resetAccess };
    });

    const result = await runtime.coordinator.replace(REPLACEMENT_TOKEN);

    expect(result).toMatchObject({
      outcome: "uncertain",
      reason: "control-uncertain",
      current: { pairing: { state: "unpaired" } },
    });
    expect(result.outcome).not.toBe("refused");
    expect(runtime.profile()).toMatchObject({ token: TOKEN, bot: { username: USERNAME } });
    expect(runtime.desired()).toBe(true);
    expect(runtime.binding.replaceTelegram).toHaveBeenNthCalledWith(2, { token: TOKEN });
  });

  it("refuses a fully restored same-bot response with the wrong username", async () => {
    const runtime = harness({
      inspection: { status: "ready", bot: { id: BOT_ID, username: OTHER_USERNAME } },
    });
    vi.mocked(runtime.binding.replaceTelegram).mockResolvedValueOnce({
      outcome: "applied",
      current: snapshot(undefined, { username: USERNAME }),
    });

    await expect(runtime.coordinator.replace(REPLACEMENT_TOKEN)).resolves.toMatchObject({
      outcome: "refused",
      reason: "invalid-state",
      current: { pairing: { state: "paired" } },
    });
    expect(runtime.profile()).toMatchObject({ token: TOKEN, bot: { username: USERNAME } });
    expect(runtime.desired()).toBe(true);
  });

  it("refuses a non-polling awaiting-code response and restores prior intent", async () => {
    const runtime = harness({
      enabled: false,
      daemonSnapshot: snapshot(undefined, { pairing: { state: "unpaired" } }),
    });
    runtime.setSenders({ senders: [] });
    vi.mocked(runtime.binding.beginTelegramPairing).mockResolvedValueOnce(
      snapshot(
        { desiredState: "enabled", state: "suspended" },
        {
          pairing: {
            state: "awaiting-code",
            code: "ABCDEF",
            expiresAt: "2026-08-05T12:01:00.000Z",
          },
        },
      ),
    );
    vi.mocked(runtime.binding.cancelTelegramPairing).mockResolvedValueOnce(
      snapshot({ desiredState: "disabled", state: "disabled" }, { pairing: { state: "unpaired" } }),
    );

    await expect(runtime.coordinator.beginPairing()).resolves.toMatchObject({
      outcome: "refused",
      reason: "invalid-state",
    });
    expect(runtime.desired()).toBe(false);
  });

  it("reports control uncertainty when a mutation generation dies during vault projection", async () => {
    const runtime = harness();
    const profileStatus = vi.mocked(runtime.vault.profileStatus);
    const readProfile = profileStatus.getMockImplementation()!;
    let releaseProjection!: (value: Awaited<ReturnType<typeof readProfile>>) => void;
    profileStatus.mockImplementationOnce(readProfile).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseProjection = resolve;
        }),
    );

    const disabling = runtime.coordinator.disable();
    await vi.waitFor(() => expect(profileStatus).toHaveBeenCalledTimes(2));
    runtime.setBinding({ ...runtime.binding, generation: 2 });
    releaseProjection(await readProfile());

    await expect(disabling).resolves.toEqual({
      outcome: "uncertain",
      reason: "control-uncertain",
      current: {
        channel: { desiredState: "disabled", state: "disabled" },
        bot: { state: "ready", username: USERNAME },
        pairing: { state: "paired" },
        credentialConfigured: true,
      },
    });
  });

  it("re-reads current daemon truth when status generation dies during vault projection", async () => {
    const runtime = harness();
    const profileStatus = vi.mocked(runtime.vault.profileStatus);
    const readProfile = profileStatus.getMockImplementation()!;
    let releaseProjection!: (value: Awaited<ReturnType<typeof readProfile>>) => void;
    profileStatus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseProjection = resolve;
        }),
    );
    const current = snapshot(
      { desiredState: "enabled", state: "offline-retrying" },
      { pairing: { state: "unpaired" } },
    );
    const successor: TelegramDaemonBinding = {
      ...runtime.binding,
      generation: 2,
      getTelegramStatus: vi.fn(async () => current),
    };

    const status = runtime.coordinator.status();
    await vi.waitFor(() => expect(profileStatus).toHaveBeenCalledOnce());
    runtime.setBinding(successor);
    releaseProjection(await readProfile());

    await expect(status).resolves.toEqual({
      channel: { desiredState: "enabled", state: "offline-retrying" },
      bot: { state: "ready", username: USERNAME },
      pairing: { state: "unpaired" },
      credentialConfigured: true,
    });
    expect(successor.getTelegramStatus).toHaveBeenCalledOnce();
  });

  it("stores an initial webhook-blocked profile disabled without claiming configure applied", async () => {
    const runtime = harness({
      configured: false,
      enabled: false,
      inspection: {
        status: "webhook-removal-required",
        bot: { id: OTHER_BOT_ID, username: OTHER_USERNAME },
      },
      daemonSnapshot: {
        channel: { desiredState: "disabled", state: "disabled" },
        bot: { state: "unconfigured" },
        pairing: { state: "unpaired" },
      },
    });

    await expect(runtime.coordinator.configure(REPLACEMENT_TOKEN)).resolves.toEqual({
      outcome: "refused",
      reason: "webhook-removal-required",
      current: {
        channel: { desiredState: "disabled", state: "disabled" },
        bot: { state: "webhook-removal-required", username: OTHER_USERNAME },
        pairing: { state: "unpaired" },
        credentialConfigured: true,
      },
    });
    expect(runtime.profile()).toMatchObject({
      token: REPLACEMENT_TOKEN,
      bot: { id: OTHER_BOT_ID, username: OTHER_USERNAME },
    });
    expect(runtime.desired()).toBe(false);
    expect(runtime.binding.configureTelegram).not.toHaveBeenCalled();
    expect(runtime.binding.replaceTelegram).not.toHaveBeenCalled();
  });

  it("preserves an unsafe-backend refusal before attempting webhook removal", async () => {
    const runtime = harness();
    const applyStoredProfile = vi.mocked(runtime.vault.applyStoredProfile);
    const readProfile = applyStoredProfile.getMockImplementation()!;
    applyStoredProfile
      .mockImplementationOnce(readProfile)
      .mockResolvedValueOnce({ outcome: "refused", reason: "unsafe-backend" });

    await expect(runtime.coordinator.removeWebhook()).resolves.toMatchObject({
      outcome: "refused",
      reason: "unsafe-backend",
      current: {
        channel: { desiredState: "enabled", state: "online" },
        bot: { state: "ready", username: USERNAME },
        pairing: { state: "paired" },
        credentialConfigured: true,
      },
    });
    expect(runtime.binding.deleteTelegramWebhook).not.toHaveBeenCalled();
    expect(runtime.profile()).toMatchObject({ token: TOKEN, bot: { id: BOT_ID } });
    expect(runtime.desired()).toBe(true);
  });

  it.each([
    ["refuses", { outcome: "refused", reason: "storage-failed" } as const],
    ["is uncertain", { outcome: "uncertain", reason: "storage-uncertain" } as const],
  ])(
    "reports storage uncertainty when remote webhook deletion succeeds but profile rewrite %s",
    async (_terminal, profileWrite) => {
      const runtime = harness({
        inspection: { status: "ready", bot: { id: BOT_ID, username: USERNAME } },
      });
      vi.mocked(runtime.vault.replaceProfile).mockResolvedValueOnce(profileWrite);

      const result = await runtime.coordinator.removeWebhook();

      expect(result).toMatchObject({ outcome: "uncertain", reason: "storage-uncertain" });
      expect(result.outcome).not.toBe("refused");
      expect(runtime.binding.deleteTelegramWebhook).toHaveBeenCalledWith({ token: TOKEN });
    },
  );

  it("reports control uncertainty when webhook deletion returns a different bot identity", async () => {
    const runtime = harness({
      inspection: { status: "ready", bot: { id: OTHER_BOT_ID, username: OTHER_USERNAME } },
    });

    const result = await runtime.coordinator.removeWebhook();

    expect(result).toMatchObject({ outcome: "uncertain", reason: "control-uncertain" });
    expect(result.outcome).not.toBe("refused");
    expect(runtime.binding.deleteTelegramWebhook).toHaveBeenCalledWith({ token: TOKEN });
    expect(runtime.vault.replaceProfile).not.toHaveBeenCalled();
  });

  it("refuses attached replacement before any coherent profile write", async () => {
    const runtime = harness({ supervision: "attached" });
    const before = runtime.profile();

    await expect(runtime.coordinator.replace(REPLACEMENT_TOKEN)).resolves.toMatchObject({
      outcome: "refused",
      reason: "transfer-required",
    });
    expect(runtime.profile()).toEqual(before);
    expect(runtime.vault.replaceProfile).not.toHaveBeenCalled();
    expect(runtime.vault.setDesiredState).not.toHaveBeenCalled();
    expect(runtime.binding.suspendTelegramPolling).not.toHaveBeenCalled();
    expect(runtime.binding.drainTelegram).not.toHaveBeenCalled();
    expect(runtime.binding.configureTelegram).not.toHaveBeenCalled();
    expect(runtime.binding.replaceTelegram).not.toHaveBeenCalled();
    expect(runtime.binding.disableTelegram).not.toHaveBeenCalled();
    expect(runtime.binding.resetTelegramAccess).not.toHaveBeenCalled();
    expect(runtime.binding.forgetTelegramCredential).not.toHaveBeenCalled();
    expect(runtime.binding.enableTelegram).not.toHaveBeenCalled();
    expect(runtime.binding.resumeTelegramPolling).not.toHaveBeenCalled();
  });

  it("refuses attached enablement before changing durable desired intent", async () => {
    const runtime = harness({ supervision: "attached", enabled: false });

    await expect(runtime.coordinator.enable()).resolves.toMatchObject({
      outcome: "refused",
      reason: "transfer-required",
    });
    expect(runtime.desired()).toBe(false);
    expect(runtime.vault.setDesiredState).not.toHaveBeenCalled();
    expect(runtime.binding.enableTelegram).not.toHaveBeenCalled();
  });

  it("refuses attached pairing cancellation without mutating external ownership", async () => {
    const runtime = harness({
      supervision: "attached",
      enabled: false,
      daemonSnapshot: snapshot(
        { desiredState: "enabled", state: "online" },
        {
          pairing: {
            state: "awaiting-code",
            code: "ABCDEF",
            expiresAt: "2026-08-05T12:01:00.000Z",
          },
        },
      ),
    });
    runtime.setSenders({ senders: [] });

    await expect(runtime.coordinator.cancelPairing()).resolves.toMatchObject({
      outcome: "refused",
      reason: "transfer-required",
    });
    expect(runtime.desired()).toBe(false);
    expect(runtime.binding.cancelTelegramPairing).not.toHaveBeenCalled();
    expect(runtime.binding.disableTelegram).not.toHaveBeenCalled();
    expect(runtime.binding.drainTelegram).not.toHaveBeenCalled();
    expect(runtime.vault.setDesiredState).not.toHaveBeenCalled();
  });

  it("restores disabled intent when paired cleanup debt refuses the first enable", async () => {
    const runtime = harness({ enabled: false });
    vi.mocked(runtime.binding.enableTelegram).mockResolvedValueOnce(
      snapshot({ desiredState: "disabled", state: "disabled" }),
    );

    await expect(runtime.coordinator.enable()).resolves.toMatchObject({
      outcome: "refused",
      reason: "invalid-state",
      current: { channel: { desiredState: "disabled", state: "disabled" } },
    });
    expect(runtime.desired()).toBe(false);
    expect(runtime.vault.setDesiredState).toHaveBeenNthCalledWith(1, true);
    expect(runtime.vault.setDesiredState).toHaveBeenNthCalledWith(2, false);

    await expect(runtime.coordinator.enable()).resolves.toMatchObject({
      outcome: "applied",
      current: { channel: { desiredState: "enabled", state: "online" } },
    });
    expect(runtime.desired()).toBe(true);
    expect(runtime.vault.setDesiredState).toHaveBeenNthCalledWith(3, true);
    expect(runtime.binding.enableTelegram).toHaveBeenCalledTimes(2);
  });

  it("reports control uncertainty when an idempotent enable returns disabled runtime intent", async () => {
    const runtime = harness({
      enabled: true,
      daemonSnapshot: snapshot({ desiredState: "disabled", state: "disabled" }),
    });

    await expect(runtime.coordinator.enable()).resolves.toMatchObject({
      outcome: "uncertain",
      reason: "control-uncertain",
      current: { channel: { desiredState: "disabled", state: "disabled" } },
    });
    expect(runtime.desired()).toBe(true);
    expect(runtime.vault.setDesiredState).toHaveBeenNthCalledWith(1, true);
    expect(runtime.vault.setDesiredState).toHaveBeenNthCalledWith(2, true);
  });

  it("restores disabled intent and runtime before refusing an enable conflict", async () => {
    const runtime = harness({
      enabled: false,
      daemonSnapshot: snapshot({ desiredState: "disabled", state: "disabled" }),
    });
    vi.mocked(runtime.binding.enableTelegram).mockResolvedValueOnce(
      snapshot({
        desiredState: "enabled",
        state: "conflict",
        errorCode: "telegram-polling-conflict",
      }),
    );

    await expect(runtime.coordinator.enable()).resolves.toEqual({
      outcome: "refused",
      reason: "polling-conflict",
      current: {
        channel: { desiredState: "disabled", state: "disabled" },
        bot: { state: "ready", username: USERNAME },
        pairing: { state: "paired" },
        credentialConfigured: true,
      },
    });
    expect(runtime.desired()).toBe(false);
    expect(runtime.vault.setDesiredState).toHaveBeenNthCalledWith(1, true);
    expect(runtime.vault.setDesiredState).toHaveBeenNthCalledWith(2, false);
    expect(runtime.binding.disableTelegram).toHaveBeenCalledOnce();
  });

  it("reports storage uncertainty when an enable conflict cannot restore disabled intent", async () => {
    const runtime = harness({
      enabled: false,
      daemonSnapshot: snapshot({ desiredState: "disabled", state: "disabled" }),
    });
    const setDesiredState = vi.mocked(runtime.vault.setDesiredState);
    const persistDesired = setDesiredState.getMockImplementation()!;
    setDesiredState
      .mockImplementationOnce(persistDesired)
      .mockResolvedValueOnce({ status: "uncertain", reason: "storage-uncertain" });
    vi.mocked(runtime.binding.enableTelegram).mockResolvedValueOnce(
      snapshot({
        desiredState: "enabled",
        state: "conflict",
        errorCode: "telegram-polling-conflict",
      }),
    );

    await expect(runtime.coordinator.enable()).resolves.toMatchObject({
      outcome: "uncertain",
      reason: "storage-uncertain",
    });
    expect(runtime.desired()).toBe(true);
    expect(runtime.binding.disableTelegram).toHaveBeenCalledOnce();
  });

  it("reports control uncertainty when an enable conflict cannot prove daemon disable", async () => {
    const runtime = harness({
      enabled: false,
      daemonSnapshot: snapshot({ desiredState: "disabled", state: "disabled" }),
    });
    vi.mocked(runtime.binding.enableTelegram).mockResolvedValueOnce(
      snapshot({
        desiredState: "enabled",
        state: "conflict",
        errorCode: "telegram-polling-conflict",
      }),
    );
    vi.mocked(runtime.binding.disableTelegram).mockRejectedValueOnce(
      new Error("disable response unavailable"),
    );

    await expect(runtime.coordinator.enable()).resolves.toMatchObject({
      outcome: "uncertain",
      reason: "control-uncertain",
    });
    expect(runtime.desired()).toBe(false);
    expect(runtime.binding.disableTelegram).toHaveBeenCalledOnce();
  });

  it("reports control uncertainty when contradictory disable intent cannot be restored", async () => {
    const runtime = harness({ enabled: true });
    vi.mocked(runtime.vault.setDesiredState)
      .mockResolvedValueOnce({ status: "stored", enabled: false })
      .mockResolvedValueOnce({ status: "uncertain", reason: "storage-uncertain" });
    vi.mocked(runtime.binding.disableTelegram).mockResolvedValueOnce(snapshot());

    await expect(runtime.coordinator.disable()).resolves.toMatchObject({
      outcome: "uncertain",
      reason: "control-uncertain",
      current: { channel: { desiredState: "enabled", state: "online" } },
    });
    expect(runtime.vault.setDesiredState).toHaveBeenNthCalledWith(1, false);
    expect(runtime.vault.setDesiredState).toHaveBeenNthCalledWith(2, true);
  });

  it("persists disabled intent and permanently disables the app-supervised daemon", async () => {
    const runtime = harness();
    runtime.trace.length = 0;

    await expect(runtime.coordinator.disable()).resolves.toEqual({
      outcome: "applied",
      current: {
        channel: { desiredState: "disabled", state: "disabled" },
        bot: { state: "ready", username: USERNAME },
        pairing: { state: "paired" },
        credentialConfigured: true,
      },
    });

    expect(runtime.desired()).toBe(false);
    expect(runtime.vault.setDesiredState).toHaveBeenCalledOnce();
    expect(runtime.vault.setDesiredState).toHaveBeenCalledWith(false);
    expect(runtime.binding.disableTelegram).toHaveBeenCalledOnce();
    expect(runtime.binding.disableTelegram).toHaveBeenCalledWith({});
    expect(runtime.binding.suspendTelegramPolling).not.toHaveBeenCalled();
    expect(runtime.trace).toEqual(["vault:desired:false", "daemon:disable"]);
  });

  it("keeps a paired bot durably disabled across repeated status polls", async () => {
    const runtime = harness();

    await runtime.coordinator.disable();

    await expect(runtime.coordinator.status()).resolves.toMatchObject({
      channel: { desiredState: "disabled", state: "disabled" },
      pairing: { state: "paired" },
    });
    await expect(runtime.coordinator.status()).resolves.toMatchObject({
      channel: { desiredState: "disabled", state: "disabled" },
      pairing: { state: "paired" },
    });

    expect(runtime.desired()).toBe(false);
    expect(runtime.vault.setDesiredState).toHaveBeenCalledOnce();
    expect(runtime.vault.setDesiredState).toHaveBeenCalledWith(false);
    expect(runtime.binding.enableTelegram).not.toHaveBeenCalled();
    expect(runtime.binding.disableTelegram).toHaveBeenCalledOnce();
  });

  it("keeps a paired bot durably disabled when the coordinator reconciles", async () => {
    const runtime = harness();

    await runtime.coordinator.disable();

    await expect(runtime.coordinator.reconcile()).resolves.toMatchObject({
      outcome: "applied",
      current: {
        channel: { desiredState: "disabled", state: "disabled" },
        bot: { state: "ready", username: USERNAME },
        pairing: { state: "paired" },
      },
    });

    expect(runtime.desired()).toBe(false);
    expect(runtime.vault.setDesiredState).toHaveBeenCalledOnce();
    expect(runtime.vault.setDesiredState).toHaveBeenCalledWith(false);
    expect(runtime.binding.enableTelegram).not.toHaveBeenCalled();
    expect(runtime.binding.disableTelegram).toHaveBeenCalledOnce();
  });

  it("preserves durable disabled intent after coordinator reconstruction", async () => {
    const runtime = harness({
      enabled: false,
      daemonSnapshot: snapshot(
        { desiredState: "disabled", state: "disabled" },
        { pairing: { state: "paired" } },
      ),
    });

    await expect(runtime.coordinator.status()).resolves.toMatchObject({
      channel: { desiredState: "disabled", state: "disabled" },
      bot: { state: "ready", username: USERNAME },
      pairing: { state: "paired" },
    });

    expect(runtime.desired()).toBe(false);
    expect(runtime.vault.setDesiredState).not.toHaveBeenCalled();
    expect(runtime.binding.enableTelegram).not.toHaveBeenCalled();
    expect(runtime.binding.disableTelegram).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "keeps attached power suspend/resume token-blind when desired enabled is %s",
    async (enabled) => {
      const runtime = harness({ supervision: "attached", enabled });

      const stopped = await runtime.coordinator.stopPolling();
      const resumed = await runtime.coordinator.resumePolling();

      expect(stopped.channel).toEqual(
        enabled
          ? { desiredState: "enabled", state: "suspended" }
          : { desiredState: "disabled", state: "disabled" },
      );
      expect(resumed.channel).toEqual(
        enabled
          ? { desiredState: "enabled", state: "online" }
          : { desiredState: "disabled", state: "disabled" },
      );
      expect(runtime.vault.profileStatus).not.toHaveBeenCalled();
      expect(runtime.vault.applyStoredProfile).not.toHaveBeenCalled();
      expect(runtime.vault.replaceProfile).not.toHaveBeenCalled();
      expect(runtime.vault.deleteProfile).not.toHaveBeenCalled();
      expect(runtime.binding.suspendTelegramPolling).toHaveBeenCalledOnce();
      expect(runtime.binding.resumeTelegramPolling).toHaveBeenCalledOnce();
      expect(runtime.binding.drainTelegram).not.toHaveBeenCalled();
      expect(runtime.binding.configureTelegram).not.toHaveBeenCalled();
      expect(runtime.binding.replaceTelegram).not.toHaveBeenCalled();
      expect(runtime.binding.disableTelegram).not.toHaveBeenCalled();
    },
  );

  it("fails transient polling closed for a stale home or generation without profile access", async () => {
    const wrongHome = harness({ supervision: "attached" });
    wrongHome.setBinding({ ...wrongHome.binding, athleteHome: OTHER_HOME });

    await expect(wrongHome.coordinator.stopPolling()).resolves.toMatchObject({
      channel: { state: "failed", errorCode: "telegram-stale-operation" },
    });
    expect(wrongHome.binding.suspendTelegramPolling).not.toHaveBeenCalled();
    expect(wrongHome.vault.profileStatus).not.toHaveBeenCalled();
    expect(wrongHome.vault.applyStoredProfile).not.toHaveBeenCalled();

    const staleGeneration = harness({ supervision: "attached" });
    vi.mocked(staleGeneration.binding.resumeTelegramPolling).mockImplementationOnce(async () => {
      staleGeneration.setBinding({ ...staleGeneration.binding, generation: 2 });
      return snapshot({ desiredState: "enabled", state: "online" });
    });
    await expect(staleGeneration.coordinator.resumePolling()).resolves.toMatchObject({
      channel: { state: "failed", errorCode: "telegram-stale-operation" },
    });
    expect(staleGeneration.vault.profileStatus).not.toHaveBeenCalled();
    expect(staleGeneration.vault.applyStoredProfile).not.toHaveBeenCalled();
  });

  it("keeps transient daemon failures token-blind", async () => {
    const runtime = harness({ supervision: "attached" });
    vi.mocked(runtime.binding.suspendTelegramPolling).mockRejectedValueOnce(
      new Error("suspend unavailable"),
    );

    await expect(runtime.coordinator.stopPolling()).resolves.toMatchObject({
      channel: { state: "failed", errorCode: "telegram-control-failed" },
    });
    expect(runtime.vault.profileStatus).not.toHaveBeenCalled();
    expect(runtime.vault.applyStoredProfile).not.toHaveBeenCalled();
    expect(runtime.vault.replaceProfile).not.toHaveBeenCalled();
    expect(runtime.vault.deleteProfile).not.toHaveBeenCalled();
  });

  it.each([
    [false, "applied" as const],
    [true, "refused" as const],
  ])(
    "never permanently disables an attached daemon during reconcile (desired=%s)",
    async (enabled, outcome) => {
      const runtime = harness({ supervision: "attached", enabled });

      await expect(runtime.coordinator.reconcile()).resolves.toMatchObject({
        outcome,
        ...(enabled ? { reason: "transfer-required" } : {}),
      });
      expect(runtime.binding.disableTelegram).not.toHaveBeenCalled();
      expect(runtime.binding.configureTelegram).not.toHaveBeenCalled();
      expect(runtime.binding.replaceTelegram).not.toHaveBeenCalled();
      expect(runtime.vault.applyStoredProfile).not.toHaveBeenCalled();
    },
  );

  it("durably compensates an uncertain desired-state write before refusing without daemon mutation", async () => {
    const runtime = harness();
    vi.mocked(runtime.vault.setDesiredState)
      .mockResolvedValueOnce({ status: "uncertain", reason: "storage-uncertain" })
      .mockResolvedValueOnce({ status: "stored", enabled: true });

    await expect(runtime.coordinator.replace(REPLACEMENT_TOKEN)).resolves.toMatchObject({
      outcome: "refused",
      reason: "storage-failed",
    });
    expect(runtime.profile()).toMatchObject({ token: TOKEN, bot: { id: BOT_ID } });
    expect(runtime.binding.replaceTelegram).not.toHaveBeenCalled();
    expect(runtime.binding.configureTelegram).not.toHaveBeenCalled();
  });
});
