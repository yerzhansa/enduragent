// Repro for llm-picker G5 (gemini verify, P1): after the credential vault latches
// "storage uncertain" at startup, "Remove all credentials" succeeds but the vault
// stays latched, so Setup keeps asking to re-enter the key and every save fails
// until the app restarts.
//
// Real: createCredentialVault, createDesktopCredentialReset and the real
// resetEncryptedCredentialStorage, on real files in a temp folder. Faked: the
// encryption backend (a reversible synthetic codec), one transient file-removal failure
// at startup (the trigger), and the coach edge (runtime binding).
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCredentialEnvelopeMutationLock,
  createCredentialMutationLock,
} from "../src/main/credential-envelope-lock.js";
import { createDesktopCredentialReset } from "../src/main/credential-reset-orchestration.js";
import {
  CREDENTIAL_FILE_MODE,
  createCredentialVault,
  type CredentialEncryptionPort,
} from "../src/main/credential-vault.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function encryption(): CredentialEncryptionPort {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) =>
      Buffer.concat([Buffer.from("SAFE:"), Buffer.from(value).reverse(), Buffer.from(":END")]),
    decryptString(value) {
      if (
        !value.subarray(0, 5).equals(Buffer.from("SAFE:")) ||
        !value.subarray(-4).equals(Buffer.from(":END"))
      ) {
        throw new TypeError();
      }
      return value.subarray(5, -4).reverse().toString();
    },
  };
}

describe("llm-picker G5: Remove all credentials after a startup storage-uncertain latch", () => {
  it("lets the athlete save a key again after a successful Remove all", async () => {
    const base = await mkdtemp(join(tmpdir(), "repro-llm-picker-reset-"));
    roots.push(base);
    const credentialRoot = join(base, "credentials-v1");
    const telegramRoot = join(base, "telegram-v1");
    const configDir = join(base, "config");
    await mkdir(configDir, { recursive: true });

    // A key saved in an earlier session.
    const seed = createCredentialVault({
      root: credentialRoot,
      encryption: encryption(),
      applyCredential: vi.fn(async () => undefined),
    });
    await expect(
      seed.writeCredential({ slot: "anthropic", value: "synthetic-old" }, { activate: false }),
    ).resolves.toMatchObject({ status: "configured" });

    // This launch: a leftover temporary file cannot be cleaned once (a transient
    // filesystem failure), so the vault latches "uncertain" (credential-vault.ts:372-415).
    const leftover = join(credentialRoot, ".anthropic.bin.startup-cleanup.tmp");
    await writeFile(leftover, "synthetic-leftover", { mode: CREDENTIAL_FILE_MODE });
    let cleanupAvailable = false;
    const vault = createCredentialVault({
      root: credentialRoot,
      encryption: encryption(),
      applyCredential: vi.fn(async () => undefined),
      removeCredentialFile: (async (path: string, options: { force?: boolean }) => {
        if (!cleanupAvailable && path === leftover)
          throw new TypeError("synthetic cleanup failure");
        await rm(path, options);
      }) as never,
    });
    await vault.reapplyConfigured();
    cleanupAvailable = true;
    await expect(vault.credentialStatuses()).resolves.toContainEqual({
      slot: "anthropic",
      state: "re-prompt",
      runtimeState: null,
    });

    // Settings -> Remove all credentials, as main wires it.
    const runtimeBinding = {
      authority: {
        getRuntimeConfig: async () => ({
          schemaVersion: 3 as const,
          llm: {
            provider: "anthropic" as const,
            model: "claude-sonnet-5",
            credential_configured: false,
          },
          intervals: {
            athlete_id: "0",
            credential_configured: false,
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
        }),
      },
      credentials: { clearCredential: async () => "cleared" as const },
    };
    const reset = createDesktopCredentialReset({
      serializeCredentialMutation: createCredentialMutationLock(),
      serializeEnvelopeMutation: createCredentialEnvelopeMutationLock(),
      currentRuntimeBinding: () => runtimeBinding,
      lifecycleSnapshot: () => ({ status: "ready", generation: 1 }),
      managedModelCredentials: new Set(["anthropic", "openrouter"]),
      resetTelegramRuntime: async () => true,
      configDir,
      deleteChatGptProfile: () => {},
      credentialRoot,
      telegramRoot,
      deleteKeyForCredentialReset: async () => ({ status: "already-absent" as const }),
      credentialRuntimeState: new Map(),
      onRuntimeStateChange: () => {},
      vault,
    });
    await expect(reset()).resolves.toMatchObject({ status: "reset" });

    // Setup: the athlete pastes a new key and saves.
    const saved = await vault.writeCredential({ slot: "anthropic", value: "synthetic-new" });
    const statuses = await vault.credentialStatuses();

    expect({
      save: saved.status,
      anthropic: statuses.find((status) => status.slot === "anthropic")?.state,
    }).toEqual({ save: "configured", anthropic: "configured" });
  });
});
