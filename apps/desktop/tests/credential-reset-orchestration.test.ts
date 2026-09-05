import { readFile } from "node:fs/promises";
import type { RuntimeConfigSnapshot } from "@enduragent/coach-contract";
import { describe, expect, it, vi } from "vitest";
import type {
  CredentialEnvelopeLockProof,
  SerializeCredentialEnvelopeMutation,
  SerializeCredentialMutation,
} from "../src/main/credential-envelope-lock.js";
import {
  createDesktopCredentialReset,
  type DesktopCredentialResetLifecycleSnapshot,
  type DesktopCredentialResetRuntimeBinding,
} from "../src/main/credential-reset-orchestration.js";
import type {
  EncryptedCredentialResetResult,
  ResetEncryptedCredentialStorageOptions,
} from "../src/main/credential-reset.js";
import type { DesktopManagedCredential } from "../src/main/credential-runtime.js";
import type {
  CredentialRuntimeState,
  DesktopCredentialSlot,
} from "../src/main/credential-vault.js";
import type { KeychainKeyDeletion } from "../src/main/keychain-credential-encryption.js";

function runtimeSnapshot(): RuntimeConfigSnapshot {
  return {
    schemaVersion: 3,
    llm: {
      provider: "anthropic",
      model: "synthetic-model",
      credential_configured: true,
    },
    intervals: {
      athlete_id: "synthetic-athlete",
      credential_configured: true,
      managedByEnvironment: { athleteId: false },
    },
    session: {
      historyTokenBudgetRatio: 0.3,
      idleMinutes: 0,
      dailyResetHour: 4,
      resetArchiveRetentionDays: 0,
      timezone: "UTC",
      managedByEnvironment: {
        historyTokenBudgetRatio: false,
        idleMinutes: false,
        dailyResetHour: false,
        resetArchiveRetentionDays: false,
        timezone: false,
      },
    },
  };
}

function harness(
  options: {
    readonly serializeCredentialMutation?: SerializeCredentialMutation;
  } = {},
) {
  const events: string[] = [];
  const proof = {} as CredentialEnvelopeLockProof;
  const getRuntimeConfig = vi.fn(async () => runtimeSnapshot());
  const clearCredential = vi.fn<
    DesktopCredentialResetRuntimeBinding["credentials"]["clearCredential"]
  >(async (credential: DesktopManagedCredential) => {
    events.push(`clear:${credential}`);
    return "cleared";
  });
  const initialBinding: DesktopCredentialResetRuntimeBinding = {
    authority: { getRuntimeConfig },
    credentials: { clearCredential },
  };
  let binding: DesktopCredentialResetRuntimeBinding | undefined = initialBinding;
  let lifecycle: DesktopCredentialResetLifecycleSnapshot | undefined = {
    status: "ready",
    generation: 1,
  };
  const resetTelegramRuntime = vi.fn(async () => {
    events.push("telegram-reset");
    return true;
  });
  const deleteKeyForCredentialReset = vi.fn(async (): Promise<KeychainKeyDeletion> => {
    events.push("key-delete");
    return { status: "deleted" };
  });
  const serializeEnvelopeMutation: SerializeCredentialEnvelopeMutation = (operation) => {
    events.push("envelope-mutation");
    return operation(proof);
  };
  const resetEncryptedCredentialStorage = vi.fn(
    async (
      options: ResetEncryptedCredentialStorageOptions,
    ): Promise<EncryptedCredentialResetResult> => {
      events.push("storage-reset");
      return await options.serializeEnvelopeMutation(async (currentProof) => {
        const deletion = await options.deleteKey(currentProof);
        return { status: "reset", keyCleanupPending: deletion.status === "failed" };
      });
    },
  );
  const credentialRuntimeState = new Map<DesktopCredentialSlot, CredentialRuntimeState>([
    ["anthropic", "active"],
    ["intervals-icu", "active"],
  ]);
  const onRuntimeStateChange = vi.fn<(slot: DesktopCredentialSlot) => void>();
  const reset = createDesktopCredentialReset({
    serializeCredentialMutation:
      options.serializeCredentialMutation ?? ((operation) => operation()),
    currentRuntimeBinding: () => binding,
    lifecycleSnapshot: () => lifecycle,
    managedModelCredentials: new Set(["anthropic", "openai"]),
    resetTelegramRuntime,
    credentialRoot: "/synthetic/credentials",
    telegramRoot: "/synthetic/telegram",
    serializeEnvelopeMutation,
    deleteKeyForCredentialReset,
    credentialRuntimeState,
    onRuntimeStateChange,
    resetEncryptedCredentialStorage,
  });
  return {
    events,
    proof,
    initialBinding,
    getRuntimeConfig,
    clearCredential,
    resetTelegramRuntime,
    deleteKeyForCredentialReset,
    serializeEnvelopeMutation,
    resetEncryptedCredentialStorage,
    credentialRuntimeState,
    onRuntimeStateChange,
    reset,
    setBinding(next: DesktopCredentialResetRuntimeBinding | undefined) {
      binding = next;
    },
    setLifecycle(next: DesktopCredentialResetLifecycleSnapshot | undefined) {
      lifecycle = next;
    },
  };
}

describe("desktop credential reset orchestration", () => {
  it("refuses an unavailable runtime binding without mutating credentials", async () => {
    const subject = harness();
    subject.setBinding(undefined);

    await expect(subject.reset()).resolves.toEqual({
      status: "refused",
      reason: "runtime-unavailable",
    });

    expect(subject.getRuntimeConfig).not.toHaveBeenCalled();
    expect(subject.clearCredential).not.toHaveBeenCalled();
    expect(subject.resetTelegramRuntime).not.toHaveBeenCalled();
    expect(subject.resetEncryptedCredentialStorage).not.toHaveBeenCalled();
    expect(subject.deleteKeyForCredentialReset).not.toHaveBeenCalled();
    expect(subject.credentialRuntimeState.get("anthropic")).toBe("active");
  });

  it("clears active model and Intervals credentials before resetting Telegram", async () => {
    const subject = harness();

    await expect(subject.reset()).resolves.toEqual({
      status: "reset",
      keyCleanupPending: false,
    });

    expect(subject.events).toEqual([
      "clear:anthropic",
      "clear:intervals-icu",
      "telegram-reset",
      "storage-reset",
      "envelope-mutation",
      "key-delete",
    ]);
  });

  it("runs the reset only through the credential mutation serializer", async () => {
    const serializerFailure = new Error("synthetic serializer refusal");
    const serializeCredentialMutation: SerializeCredentialMutation = async () => {
      throw serializerFailure;
    };
    const subject = harness({ serializeCredentialMutation });

    await expect(subject.reset()).rejects.toBe(serializerFailure);

    expect(subject.getRuntimeConfig).not.toHaveBeenCalled();
    expect(subject.clearCredential).not.toHaveBeenCalled();
    expect(subject.resetTelegramRuntime).not.toHaveBeenCalled();
    expect(subject.resetEncryptedCredentialStorage).not.toHaveBeenCalled();
  });

  it.each(["false", "throw"] as const)(
    "stops before local deletion when Telegram reset returns %s",
    async (outcome) => {
      const subject = harness();
      subject.resetTelegramRuntime.mockImplementationOnce(async () => {
        subject.events.push("telegram-reset");
        if (outcome === "throw") throw new Error("synthetic Telegram failure");
        return false;
      });

      await expect(subject.reset()).resolves.toEqual({
        status: "refused",
        reason: "runtime-unavailable",
      });

      expect(subject.resetEncryptedCredentialStorage).not.toHaveBeenCalled();
      expect(subject.deleteKeyForCredentialReset).not.toHaveBeenCalled();
      expect(subject.credentialRuntimeState.get("anthropic")).toBe("failed");
      expect(subject.credentialRuntimeState.get("intervals-icu")).toBe("failed");
      expect(subject.onRuntimeStateChange.mock.calls).toEqual([["anthropic"], ["intervals-icu"]]);
    },
  );

  it.each(["binding", "generation"] as const)(
    "stops before durable deletion when the runtime %s changes after Telegram reset",
    async (change) => {
      const subject = harness();
      subject.resetTelegramRuntime.mockImplementationOnce(async () => {
        subject.events.push("telegram-reset");
        if (change === "binding") {
          subject.setBinding({ ...subject.initialBinding });
        } else {
          subject.setLifecycle({ status: "ready", generation: 2 });
        }
        return true;
      });

      await expect(subject.reset()).resolves.toEqual({
        status: "refused",
        reason: "runtime-unavailable",
      });

      expect(subject.resetEncryptedCredentialStorage).not.toHaveBeenCalled();
      expect(subject.deleteKeyForCredentialReset).not.toHaveBeenCalled();
      expect(subject.credentialRuntimeState.get("anthropic")).toBe("failed");
      expect(subject.credentialRuntimeState.get("intervals-icu")).toBe("failed");
    },
  );

  it("updates only credentials cleared before a later daemon clear fails", async () => {
    const subject = harness();
    subject.clearCredential
      .mockImplementationOnce(async (credential) => {
        subject.events.push(`clear:${credential}`);
        return "cleared" as const;
      })
      .mockImplementationOnce(async (credential) => {
        subject.events.push(`clear:${credential}`);
        throw new Error("synthetic credential clear failure");
      });

    await expect(subject.reset()).resolves.toEqual({
      status: "refused",
      reason: "runtime-unavailable",
    });

    expect(subject.credentialRuntimeState.get("anthropic")).toBe("failed");
    expect(subject.credentialRuntimeState.get("intervals-icu")).toBe("active");
    expect(subject.onRuntimeStateChange).toHaveBeenCalledOnce();
    expect(subject.onRuntimeStateChange).toHaveBeenCalledWith("anthropic");
    expect(subject.resetTelegramRuntime).not.toHaveBeenCalled();
    expect(subject.resetEncryptedCredentialStorage).not.toHaveBeenCalled();
  });

  it("keeps environment-managed runtime state through a later reset refusal", async () => {
    const subject = harness();
    subject.clearCredential
      .mockImplementationOnce(async (credential) => {
        subject.events.push(`clear:${credential}`);
        return "managed-by-environment";
      })
      .mockImplementationOnce(async (credential) => {
        subject.events.push(`clear:${credential}`);
        return "cleared";
      });
    subject.resetTelegramRuntime.mockImplementationOnce(async () => {
      subject.events.push("telegram-reset");
      return false;
    });

    await expect(subject.reset()).resolves.toEqual({
      status: "refused",
      reason: "runtime-unavailable",
    });

    expect(subject.credentialRuntimeState.get("anthropic")).toBe("active");
    expect(subject.credentialRuntimeState.get("intervals-icu")).toBe("failed");
    expect(subject.onRuntimeStateChange.mock.calls).toEqual([["intervals-icu"]]);
    expect(subject.resetEncryptedCredentialStorage).not.toHaveBeenCalled();
  });

  it("keeps runtime state unchanged when the daemon credential is not active", async () => {
    const subject = harness();
    const snapshot = runtimeSnapshot();
    subject.getRuntimeConfig.mockResolvedValueOnce({
      ...snapshot,
      intervals: { ...snapshot.intervals, credential_configured: false },
    });
    subject.clearCredential.mockImplementationOnce(async (credential) => {
      subject.events.push(`clear:${credential}`);
      return "not-active";
    });
    subject.resetTelegramRuntime.mockImplementationOnce(async () => {
      subject.events.push("telegram-reset");
      return false;
    });

    await expect(subject.reset()).resolves.toEqual({
      status: "refused",
      reason: "runtime-unavailable",
    });

    expect(subject.credentialRuntimeState.get("anthropic")).toBe("active");
    expect(subject.clearCredential).toHaveBeenCalledOnce();
    expect(subject.clearCredential).toHaveBeenCalledWith("anthropic");
    expect(subject.onRuntimeStateChange).not.toHaveBeenCalled();
    expect(subject.resetEncryptedCredentialStorage).not.toHaveBeenCalled();
  });

  it("maps durable storage reset failure to storage-failed", async () => {
    const subject = harness();
    subject.resetEncryptedCredentialStorage.mockResolvedValueOnce({ status: "failed" });

    await expect(subject.reset()).resolves.toEqual({
      status: "refused",
      reason: "storage-failed",
    });

    expect(subject.credentialRuntimeState.get("anthropic")).toBe("failed");
    expect(subject.credentialRuntimeState.get("intervals-icu")).toBe("failed");
  });

  it("returns reset with pending cleanup when Keychain deletion fails", async () => {
    const subject = harness();
    subject.deleteKeyForCredentialReset.mockResolvedValueOnce({
      status: "failed",
      code: "keychain-locked",
    });

    await expect(subject.reset()).resolves.toEqual({
      status: "reset",
      keyCleanupPending: true,
    });

    expect(subject.resetEncryptedCredentialStorage).toHaveBeenCalledOnce();
    expect(subject.resetEncryptedCredentialStorage.mock.calls[0]![0].deleteKey).toBe(
      subject.deleteKeyForCredentialReset,
    );
    expect(
      subject.resetEncryptedCredentialStorage.mock.calls[0]![0].serializeEnvelopeMutation,
    ).toBe(subject.serializeEnvelopeMutation);
    expect(subject.deleteKeyForCredentialReset).toHaveBeenCalledWith(subject.proof);
  });

  it("marks cleared runtime slots failed until durable storage reset succeeds", async () => {
    const subject = harness();
    let resolveStorage!: (result: { status: "reset"; keyCleanupPending: false }) => void;
    let markStorageStarted!: () => void;
    const storageStarted = new Promise<void>((resolve) => {
      markStorageStarted = resolve;
    });
    const storageFinished = new Promise<{
      status: "reset";
      keyCleanupPending: false;
    }>((resolve) => {
      resolveStorage = resolve;
    });
    subject.resetEncryptedCredentialStorage.mockImplementationOnce(async () => {
      markStorageStarted();
      return await storageFinished;
    });

    const reset = subject.reset();
    await storageStarted;
    expect(subject.credentialRuntimeState.get("anthropic")).toBe("failed");
    expect(subject.credentialRuntimeState.get("intervals-icu")).toBe("failed");

    resolveStorage({ status: "reset", keyCleanupPending: false });
    await expect(reset).resolves.toEqual({ status: "reset", keyCleanupPending: false });
    expect(subject.credentialRuntimeState.size).toBe(0);
  });

  it("wires the shared envelope lock and reset-only Keychain deletion in production", async () => {
    const source = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");
    const start = source.indexOf("createDesktopCredentialReset({");
    const end = source.indexOf("const claudeCli =", start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const composition = source.slice(start, end);
    expect(composition).toContain("serializeCredentialMutation,");
    expect(composition).toContain(
      "serializeEnvelopeMutation: serializeCredentialEnvelopeMutation,",
    );
    expect(composition).toMatch(
      /deleteKeyForCredentialReset: \(proof\) =>\s+credentialEncryption\.deleteKeyForCredentialReset\(proof\)/u,
    );
    expect(composition).toContain("onRuntimeStateChange: markCredentialRuntimeChange,");
  });
});
