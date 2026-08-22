import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCredentialMutationLock } from "../src/main/credential-envelope-lock.js";
import {
  CREDENTIAL_DIRECTORY_MODE,
  CREDENTIAL_FILE_MODE,
  CredentialRuntimeRefusal,
  createCredentialVault,
  markUnselectedModelCredentialsInactive,
  replaceCredentialRuntimeStates,
  type CredentialEncryptionPort,
  type CredentialVaultMutation,
} from "../src/main/credential-vault.js";

const roots: string[] = [];
const posixIt = it.skipIf(process.platform === "win32");
const VERIFICATION_APPROVAL = "b".repeat(64);

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "desktop-vault-"));
  roots.push(root);
  return join(root, "credentials-v1");
}

async function createSymlinkOrReturnWindowsCapabilityReason(
  target: string,
  path: string,
): Promise<string | undefined> {
  try {
    await symlink(target, path);
    return undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) {
      return `Windows symlink capability unavailable (${code})`;
    }
    throw error;
  }
}

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

async function storeEncryptedCredential(
  root: string,
  slot: "anthropic" | "openrouter",
  value: string,
  encryptionPort: CredentialEncryptionPort,
): Promise<void> {
  const vault = createCredentialVault({
    root,
    encryption: encryptionPort,
    applyCredential: vi.fn(async () => undefined),
  });
  await expect(vault.writeCredential({ slot, value }, { activate: false })).resolves.toMatchObject({
    slot,
    status: "configured",
  });
}

async function leaveAmbiguousCredential(
  root: string,
  visible: "old" | "candidate",
  encryptionPort: CredentialEncryptionPort,
): Promise<void> {
  await storeEncryptedCredential(root, "anthropic", "synthetic-old", encryptionPort);
  let syncCount = 0;
  let renameCount = 0;
  const applyCredential = vi.fn(async () => undefined);
  const vault = createCredentialVault({
    root,
    encryption: encryptionPort,
    applyCredential,
    createId: () => `reopen-${visible}`,
    renameCredentialFile: (async (from: string, to: string) => {
      renameCount += 1;
      if (visible === "candidate" && renameCount === 2) {
        throw new TypeError("synthetic compensation rename failure");
      }
      await rename(from, to);
    }) as never,
    syncCredentialDirectory: async () => {
      syncCount += 1;
      if (syncCount > 1) throw new TypeError("synthetic unresolved directory sync failure");
      const directory = await open(root, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    },
  });

  await expect(
    vault.writeCredential({ slot: "anthropic", value: "synthetic-candidate" }),
  ).resolves.toEqual({
    slot: "anthropic",
    status: "uncertain",
    reason: "storage-uncertain",
  });
  expect(encryptionPort.decryptString(await readFile(join(root, "anthropic.bin")))).toBe(
    `synthetic-${visible}`,
  );
  expect(applyCredential).not.toHaveBeenCalled();
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("desktop credential vault", () => {
  it("finishes an active credential write before a shared reset mutation can run", async () => {
    const root = await temporaryRoot();
    const trace: string[] = [];
    let finishApply: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const applyStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const applyFinished = new Promise<void>((resolve) => {
      finishApply = resolve;
    });
    const serializeCredentialMutation = createCredentialMutationLock();
    const vault = createCredentialVault({
      root,
      encryption: encryption(),
      serializeCredentialMutation,
      async applyCredential() {
        trace.push("write-started");
        markStarted?.();
        await applyFinished;
        trace.push("write-finished");
      },
    });

    const write = vault.writeCredential({ slot: "anthropic", value: "synthetic-secret" });
    await applyStarted;
    const reset = serializeCredentialMutation(async () => {
      trace.push("reset");
    });
    await Promise.resolve();
    expect(trace).toEqual(["write-started"]);

    finishApply?.();
    await write;
    await reset;
    expect(trace).toEqual(["write-started", "write-finished", "reset"]);
  });

  it("refuses unavailable encryption and invalid input before filesystem work", async () => {
    const root = await temporaryRoot();
    const encryptString = vi.fn(() => Buffer.from("unused"));
    const vault = createCredentialVault({
      root,
      encryption: { isEncryptionAvailable: () => false, encryptString, decryptString: vi.fn() },
      applyCredential: vi.fn(),
    });
    await expect(vault.writeCredential({ slot: "anthropic", value: "synthetic" })).resolves.toEqual(
      {
        slot: "anthropic",
        status: "refused",
        reason: "encryption-unavailable",
      },
    );
    await expect(vault.writeCredential({ slot: "anthropic", value: "  " })).resolves.toEqual({
      slot: "anthropic",
      status: "refused",
      reason: "invalid-input",
    });
    await expect(
      vault.writeCredential({ slot: "unknown", value: "synthetic" } as never),
    ).resolves.toEqual({
      slot: "anthropic",
      status: "refused",
      reason: "invalid-input",
    });
    expect(encryptString).not.toHaveBeenCalled();
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a Windows encryption result containing plaintext", async () => {
    const root = await temporaryRoot();
    const vault = createCredentialVault({
      root,
      platform: "win32",
      encryption: {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.concat([Buffer.from([0]), Buffer.from(value, "utf8")]),
        decryptString: (value) => value.toString("utf8"),
      },
      applyCredential: vi.fn(),
    });

    await expect(
      vault.writeCredential({ slot: "anthropic", value: "test-token-placeholder" }),
    ).resolves.toEqual({ slot: "anthropic", status: "refused", reason: "storage-failed" });
    await expect(lstat(join(root, "anthropic.bin"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts the macOS encryption shape and writes one atomic secure ciphertext", async () => {
    const root = await temporaryRoot();
    const sentinel = "desktop-sentinel-model-key";
    const applyCredential = vi.fn(async () => {
      const committed = await readFile(join(root, "anthropic.bin"));
      expect(committed.length).toBeGreaterThan(0);
      expect(committed.includes(Buffer.from(sentinel))).toBe(false);
      expect((await readdir(root)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    });
    const vault = createCredentialVault({ root, encryption: encryption(), applyCredential });
    await expect(
      vault.writeCredential({ slot: "anthropic", value: ` ${sentinel} ` }),
    ).resolves.toEqual({
      slot: "anthropic",
      status: "configured",
      runtimeReady: true,
    });
    const directory = await lstat(root);
    const path = join(root, "anthropic.bin");
    const file = await lstat(path);
    const ciphertext = await readFile(path);
    if (process.platform !== "win32") {
      expect(directory.mode & 0o777).toBe(CREDENTIAL_DIRECTORY_MODE);
      expect(file.mode & 0o777).toBe(CREDENTIAL_FILE_MODE);
    }
    expect(ciphertext.length).toBeGreaterThan(0);
    expect(ciphertext.includes(Buffer.from(sentinel))).toBe(false);
    expect(await readdir(root)).toEqual(["anthropic.bin"]);
    expect(applyCredential).toHaveBeenCalledWith("anthropic", sentinel);
    await expect(vault.credentialStatuses()).resolves.toContainEqual({
      slot: "anthropic",
      state: "configured",
      runtimeState: "active",
    });
  });

  posixIt("anchors the credential namespace in its parent before publishing a credential", async () => {
    const root = await temporaryRoot();
    let parentSyncAvailable = false;
    const syncCredentialParentDirectory = vi.fn(async (path: string) => {
      expect(path).toBe(dirname(root));
      if (!parentSyncAvailable) throw new TypeError("synthetic parent sync failure");
      const directory = await open(path, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    });
    const applyCredential = vi.fn(async () => undefined);
    const vault = createCredentialVault({
      root,
      encryption: encryption(),
      applyCredential,
      syncCredentialParentDirectory,
    });

    await expect(
      vault.writeCredential({ slot: "anthropic", value: "synthetic-candidate" }),
    ).resolves.toEqual({ slot: "anthropic", status: "refused", reason: "storage-failed" });
    await expect(lstat(join(root, "anthropic.bin"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(applyCredential).not.toHaveBeenCalled();

    parentSyncAvailable = true;
    await expect(
      vault.writeCredential({ slot: "anthropic", value: "synthetic-candidate" }),
    ).resolves.toEqual({ slot: "anthropic", status: "configured", runtimeReady: true });
    expect(syncCredentialParentDirectory).toHaveBeenCalledTimes(2);
  });

  posixIt("zeros encryption and rollback buffers after success, refusal, and compensation", async () => {
    const scenarios = ["success", "pre-rename", "compensation"] as const;
    for (const scenario of scenarios) {
      const root = await temporaryRoot();
      const baseEncryption = encryption();
      if (scenario === "compensation") {
        await storeEncryptedCredential(root, "anthropic", "synthetic-old", baseEncryption);
      }
      const ciphertexts: Buffer[] = [];
      const rollbackBuffers: Buffer[] = [];
      let syncCount = 0;
      const vault = createCredentialVault({
        root,
        encryption: {
          ...baseEncryption,
          encryptString(value) {
            const ciphertext = baseEncryption.encryptString(value);
            ciphertexts.push(ciphertext);
            return ciphertext;
          },
        },
        applyCredential: vi.fn(async () => undefined),
        readCredentialFile:
          scenario === "compensation"
            ? ((async (path: string) => {
                const contents = await readFile(path);
                rollbackBuffers.push(contents);
                return contents;
              }) as typeof readFile)
            : undefined,
        renameCredentialFile:
          scenario === "pre-rename"
            ? (vi.fn(async () => {
                throw new TypeError("synthetic rename failure");
              }) as never)
            : undefined,
        syncCredentialDirectory:
          scenario === "compensation"
            ? async () => {
                syncCount += 1;
                if (syncCount === 2) {
                  throw new TypeError("synthetic candidate directory sync failure");
                }
                const directory = await open(root, "r");
                try {
                  await directory.sync();
                } finally {
                  await directory.close();
                }
              }
            : undefined,
      });

      const result = await vault.writeCredential({
        slot: "anthropic",
        value: `synthetic-${scenario}`,
      });

      expect(result.status).toBe(scenario === "success" ? "configured" : "refused");
      expect(ciphertexts).toHaveLength(1);
      for (const buffer of [...ciphertexts, ...rollbackBuffers]) {
        expect(buffer.every((byte) => byte === 0)).toBe(true);
      }
      if (scenario === "compensation") expect(rollbackBuffers).toHaveLength(1);
    }
  });

  it("keeps a write committed when directory cleanup fails after a successful fsync", async () => {
    const root = await temporaryRoot();
    const sync = vi.fn(async () => undefined);
    const close = vi.fn(async () => {
      throw new TypeError("synthetic directory close failure");
    });
    const openCredentialDirectory = vi.fn(async () => ({ sync, close }));
    const applyCredential = vi.fn(async () => undefined);
    const vault = createCredentialVault({
      root,
      encryption: encryption(),
      applyCredential,
      openCredentialDirectory: openCredentialDirectory as unknown as NonNullable<
        Parameters<typeof createCredentialVault>[0]["openCredentialDirectory"]
      >,
    });

    await expect(
      vault.writeCredential({ slot: "anthropic", value: "synthetic-candidate" }),
    ).resolves.toEqual({
      slot: "anthropic",
      status: "configured",
      runtimeReady: true,
    });
    if (process.platform === "win32") {
      expect(openCredentialDirectory).not.toHaveBeenCalled();
      expect(sync).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
    } else {
      expect(openCredentialDirectory).toHaveBeenCalledWith(root, "r");
      expect(sync).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
    }
    expect(applyCredential).toHaveBeenCalledWith("anthropic", "synthetic-candidate");
  });

  posixIt("restores the previous ciphertext before refusing a post-rename durability failure", async () => {
    const root = await temporaryRoot();
    const encryptionPort = encryption();
    const seed = createCredentialVault({
      root,
      encryption: encryptionPort,
      applyCredential: vi.fn(),
    });
    await seed.writeCredential({ slot: "anthropic", value: "synthetic-old" }, { activate: false });
    let syncCount = 0;
    const applyCredential = vi.fn();
    const vault = createCredentialVault({
      root,
      encryption: encryptionPort,
      applyCredential,
      createId: () => `write-${syncCount}`,
      syncCredentialDirectory: async () => {
        syncCount += 1;
        if (syncCount === 2) throw new TypeError("synthetic replacement directory sync failure");
        const directory = await open(root, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      },
    });

    await expect(
      vault.writeCredential({ slot: "anthropic", value: "synthetic-candidate" }),
    ).resolves.toEqual({
      slot: "anthropic",
      status: "refused",
      reason: "storage-failed",
    });
    const stored = await readFile(join(root, "anthropic.bin"));
    expect(encryptionPort.decryptString(stored)).toBe("synthetic-old");
    expect(applyCredential).not.toHaveBeenCalled();
  });

  posixIt("reports uncertainty and blocks replay when credential convergence cannot be proven", async () => {
    const root = await temporaryRoot();
    const encryptionPort = encryption();
    const seed = createCredentialVault({
      root,
      encryption: encryptionPort,
      applyCredential: vi.fn(),
    });
    await seed.writeCredential({ slot: "anthropic", value: "synthetic-old" }, { activate: false });
    const applyCredential = vi.fn();
    let syncCount = 0;
    const vault = createCredentialVault({
      root,
      encryption: encryptionPort,
      applyCredential,
      createId: () => "never-durable",
      syncCredentialDirectory: async () => {
        syncCount += 1;
        if (syncCount === 1) {
          const directory = await open(root, "r");
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
          return;
        }
        throw new TypeError("synthetic persistent directory sync failure");
      },
    });

    await expect(
      vault.writeCredential({ slot: "anthropic", value: "synthetic-candidate" }),
    ).resolves.toEqual({
      slot: "anthropic",
      status: "uncertain",
      reason: "storage-uncertain",
    });
    await expect(vault.credentialStatuses()).resolves.toContainEqual({
      slot: "anthropic",
      state: "re-prompt",
      runtimeState: null,
    });
    expect(applyCredential).not.toHaveBeenCalled();
  });

  it("serializes successor replay behind an in-flight replacement until storage converges", async () => {
    const root = await temporaryRoot();
    const encryptionPort = encryption();
    await storeEncryptedCredential(root, "anthropic", "synthetic-old", encryptionPort);
    let releaseReplacement!: () => void;
    const replacementBlocked = new Promise<void>((resolve) => {
      releaseReplacement = resolve;
    });
    let replacementStarted!: () => void;
    const replacementWasStarted = new Promise<void>((resolve) => {
      replacementStarted = resolve;
    });
    const writer = createCredentialVault({
      root,
      encryption: encryptionPort,
      applyCredential: vi.fn(async () => undefined),
      renameCredentialFile: (async () => {
        replacementStarted();
        await replacementBlocked;
        throw new TypeError("synthetic replacement rename failure");
      }) as never,
    });
    const write = writer.writeCredential({
      slot: "anthropic",
      value: "synthetic-candidate",
    });
    await replacementWasStarted;

    const applySuccessorCredential = vi.fn(async () => undefined);
    const successor = createCredentialVault({
      root,
      encryption: encryptionPort,
      applyCredential: applySuccessorCredential,
    });
    let replaySettled = false;
    const replay = successor.reapplyConfigured().then(() => {
      replaySettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(replaySettled).toBe(false);
    expect(applySuccessorCredential).not.toHaveBeenCalled();

    releaseReplacement();
    await expect(write).resolves.toEqual({
      slot: "anthropic",
      status: "refused",
      reason: "storage-failed",
    });
    await replay;
    expect(applySuccessorCredential).toHaveBeenCalledWith("anthropic", "synthetic-old");
  });

  it("rejects an exclusive mutation handle after its section completes", async () => {
    const root = await temporaryRoot();
    const vault = createCredentialVault({
      root,
      encryption: encryption(),
      applyCredential: vi.fn(async () => undefined),
    });
    let escaped: CredentialVaultMutation | undefined;

    await vault.runExclusiveMutation(async (mutation) => {
      escaped = mutation;
    });

    expect(() => escaped!.credentialStatuses()).toThrow(TypeError);
    expect(() =>
      escaped!.writeCredential({ slot: "anthropic", value: "synthetic-secret" }),
    ).toThrow(TypeError);
    await expect(lstat(join(root, "anthropic.bin"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  posixIt("reopens a visible old credential only after cleaning owned transients and syncing", async () => {
    const root = await temporaryRoot();
    const baseEncryption = encryption();
    await leaveAmbiguousCredential(root, "old", baseEncryption);
    const ownedTemporary = join(root, ".anthropic.bin.reopen-old.tmp");
    await writeFile(ownedTemporary, Buffer.from("synthetic abandoned ciphertext"), {
      mode: CREDENTIAL_FILE_MODE,
    });
    const syncCredentialDirectory = vi.fn(async () => {
      await expect(lstat(ownedTemporary)).rejects.toMatchObject({ code: "ENOENT" });
      const directory = await open(root, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    });
    const decryptString = vi.fn((value: Buffer) => {
      expect(syncCredentialDirectory).toHaveBeenCalledOnce();
      return baseEncryption.decryptString(value);
    });
    const applyCredential = vi.fn(async () => undefined);
    const reopened = createCredentialVault({
      root,
      encryption: { ...baseEncryption, decryptString },
      applyCredential,
      syncCredentialDirectory,
    });

    await reopened.reapplyConfigured();

    expect(applyCredential).toHaveBeenCalledWith("anthropic", "synthetic-old");
    await expect(reopened.credentialStatuses()).resolves.toContainEqual({
      slot: "anthropic",
      state: "configured",
      runtimeState: "active",
    });
    expect(syncCredentialDirectory).toHaveBeenCalledOnce();
  });

  posixIt("reopens a visible candidate only after syncing even when no transient remains", async () => {
    const root = await temporaryRoot();
    const baseEncryption = encryption();
    await leaveAmbiguousCredential(root, "candidate", baseEncryption);
    const syncCredentialDirectory = vi.fn(async () => {
      const directory = await open(root, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    });
    const decryptString = vi.fn((value: Buffer) => {
      expect(syncCredentialDirectory).toHaveBeenCalledOnce();
      return baseEncryption.decryptString(value);
    });
    const applyCredential = vi.fn(async () => undefined);
    const reopened = createCredentialVault({
      root,
      encryption: { ...baseEncryption, decryptString },
      applyCredential,
      syncCredentialDirectory,
    });

    await reopened.reapplyConfigured();

    expect(applyCredential).toHaveBeenCalledWith("anthropic", "synthetic-candidate");
    expect(syncCredentialDirectory).toHaveBeenCalledOnce();
  });

  posixIt("keeps a reopened vault indeterminate when its durability barrier fails", async () => {
    const root = await temporaryRoot();
    const baseEncryption = encryption();
    await leaveAmbiguousCredential(root, "candidate", baseEncryption);
    const decryptString = vi.fn(baseEncryption.decryptString);
    const applyCredential = vi.fn(async () => undefined);
    const syncCredentialDirectory = vi.fn(async () => {
      throw new TypeError("synthetic reopen sync failure");
    });
    const reopened = createCredentialVault({
      root,
      encryption: { ...baseEncryption, decryptString },
      applyCredential,
      syncCredentialDirectory,
    });

    await reopened.reapplyConfigured();
    await expect(reopened.credentialStatuses()).resolves.toContainEqual({
      slot: "anthropic",
      state: "re-prompt",
      runtimeState: null,
    });
    await expect(
      reopened.writeCredential({ slot: "anthropic", value: "synthetic-later" }),
    ).resolves.toEqual({
      slot: "anthropic",
      status: "uncertain",
      reason: "storage-uncertain",
    });
    expect(syncCredentialDirectory).toHaveBeenCalledOnce();
    expect(decryptString).not.toHaveBeenCalled();
    expect(applyCredential).not.toHaveBeenCalled();
  });

  it("latches a transient cleanup failure and ignores lookalike files outside its namespace", async () => {
    const root = await temporaryRoot();
    const baseEncryption = encryption();
    await storeEncryptedCredential(root, "anthropic", "synthetic-old", baseEncryption);
    const ownedTemporary = join(root, ".anthropic.bin.reopen-cleanup.tmp");
    const lookalike = join(root, ".anthropic.bin.reopen-cleanup.tmp.backup");
    await writeFile(ownedTemporary, "synthetic-owned-temporary", { mode: CREDENTIAL_FILE_MODE });
    await writeFile(lookalike, "synthetic-user-file", { mode: CREDENTIAL_FILE_MODE });
    let cleanupAvailable = false;
    const removeCredentialFile = vi.fn(async (path: string, options: { force?: boolean }) => {
      if (!cleanupAvailable && path === ownedTemporary) {
        throw new TypeError("synthetic cleanup failure");
      }
      await rm(path, options);
    });
    const decryptString = vi.fn(baseEncryption.decryptString);
    const applyCredential = vi.fn(async () => undefined);
    const reopened = createCredentialVault({
      root,
      encryption: { ...baseEncryption, decryptString },
      applyCredential,
      removeCredentialFile: removeCredentialFile as never,
    });

    await reopened.reapplyConfigured();
    cleanupAvailable = true;
    await expect(reopened.credentialStatuses()).resolves.toContainEqual({
      slot: "anthropic",
      state: "re-prompt",
      runtimeState: null,
    });

    expect(removeCredentialFile).toHaveBeenCalledTimes(1);
    expect((await lstat(ownedTemporary)).isFile()).toBe(true);
    expect((await lstat(lookalike)).isFile()).toBe(true);
    expect(decryptString).not.toHaveBeenCalled();
    expect(applyCredential).not.toHaveBeenCalled();
  });

  it("cleans every exact credential transient shape without touching near matches", async () => {
    const root = await temporaryRoot();
    await mkdir(root, { recursive: true, mode: CREDENTIAL_DIRECTORY_MODE });
    const owned = [
      ".anthropic.bin.helper-write.tmp",
      ".openrouter.legacy-write.tmp",
      ".anthropic.bin.helper-delete.deleted",
      ".openrouter.vault-delete.deleted",
    ];
    const ignored = [
      ".anthropic.bin.helper-write.tmp.backup",
      ".unknown.bin.helper-write.tmp",
      "anthropic.bin.helper-write.tmp",
    ];
    await Promise.all(
      [...owned, ...ignored].map((entry) =>
        writeFile(join(root, entry), "synthetic-artifact", { mode: CREDENTIAL_FILE_MODE }),
      ),
    );
    const reopened = createCredentialVault({
      root,
      encryption: encryption(),
      applyCredential: vi.fn(),
    });

    await reopened.credentialStatuses();

    await Promise.all(
      owned.map((entry) =>
        expect(lstat(join(root, entry))).rejects.toMatchObject({ code: "ENOENT" }),
      ),
    );
    expect((await readdir(root)).sort()).toEqual(ignored.sort());
  });

  it("clears an active runtime credential before atomically deleting its vault entry", async () => {
    const root = await temporaryRoot();
    const clearCredential = vi.fn(async () => {
      expect((await lstat(join(root, "anthropic.bin"))).isFile()).toBe(true);
      return "cleared" as const;
    });
    const vault = createCredentialVault({
      root,
      encryption: encryption(),
      applyCredential: vi.fn(async () => {}),
      clearCredential,
    });
    await vault.writeCredential({ slot: "anthropic", value: randomUUID() });

    await expect(vault.deleteCredential("anthropic")).resolves.toEqual({
      slot: "anthropic",
      status: "deleted",
      cleanupPending: false,
    });

    expect(clearCredential).toHaveBeenCalledOnce();
    await expect(lstat(join(root, "anthropic.bin"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(vault.credentialStatuses()).resolves.toContainEqual({
      slot: "anthropic",
      state: "missing",
      runtimeState: null,
    });
  });

  posixIt("deletes an unverified envelope only after the athlete requests that slot", async () => {
    const root = await temporaryRoot();
    await mkdir(root, { mode: CREDENTIAL_DIRECTORY_MODE });
    const path = join(root, "anthropic.bin");
    await writeFile(path, Buffer.from("unverified-envelope"), { mode: CREDENTIAL_FILE_MODE });
    const vault = createCredentialVault({
      root,
      encryption: encryption(),
      applyCredential: vi.fn(async () => undefined),
    });

    await expect(vault.credentialStatuses()).resolves.toContainEqual({
      slot: "anthropic",
      state: "re-prompt",
      runtimeState: null,
    });
    await expect(vault.deleteCredential("anthropic")).resolves.toEqual({
      slot: "anthropic",
      status: "deleted",
      cleanupPending: false,
    });
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("deletes a stored-inactive credential without replacing the active runtime", async () => {
    const root = await temporaryRoot();
    const clearCredential = vi.fn(async () => "cleared" as const);
    const vault = createCredentialVault({
      root,
      encryption: encryption(),
      applyCredential: vi.fn(async () => {}),
      clearCredential,
    });
    await vault.writeCredential({ slot: "openrouter", value: randomUUID() }, { activate: false });

    await expect(vault.deleteCredential("openrouter")).resolves.toMatchObject({
      status: "deleted",
      cleanupPending: false,
    });

    expect(clearCredential).not.toHaveBeenCalled();
    await expect(vault.credentialStatuses()).resolves.toContainEqual({
      slot: "openrouter",
      state: "missing",
      runtimeState: null,
    });
  });

  it("refuses an environment-managed active deletion without mutating the vault", async () => {
    const root = await temporaryRoot();
    const vault = createCredentialVault({
      root,
      encryption: encryption(),
      applyCredential: vi.fn(async () => {}),
      clearCredential: vi.fn(async () => "managed-by-environment" as const),
    });
    await vault.writeCredential({ slot: "intervals-icu", value: randomUUID() });

    await expect(vault.deleteCredential("intervals-icu")).resolves.toEqual({
      slot: "intervals-icu",
      status: "refused",
      reason: "managed-by-environment",
    });

    expect((await lstat(join(root, "intervals-icu.bin"))).isFile()).toBe(true);
  });

  it("surfaces an ambiguous runtime clear without mutating the vault", async () => {
    const root = await temporaryRoot();
    const vault = createCredentialVault({
      root,
      encryption: encryption(),
      applyCredential: vi.fn(async () => {}),
      clearCredential: vi.fn(async () => {
        throw new TypeError();
      }),
    });
    await vault.writeCredential({ slot: "anthropic", value: randomUUID() });

    await expect(vault.deleteCredential("anthropic")).resolves.toEqual({
      slot: "anthropic",
      status: "refused",
      reason: "runtime-state-diverged",
    });

    expect((await lstat(join(root, "anthropic.bin"))).isFile()).toBe(true);
    await expect(vault.credentialStatuses()).resolves.toContainEqual({
      slot: "anthropic",
      state: "configured",
      runtimeState: "failed",
    });
  });

  it("restores runtime after a retained vault delete failure and surfaces failed reconciliation", async () => {
    const root = await temporaryRoot();
    let applyCount = 0;
    let restoreFails = false;
    const applyCredential = vi.fn(async () => {
      applyCount += 1;
      if (restoreFails && applyCount > 1) throw new TypeError();
    });
    const vault = createCredentialVault({
      root,
      encryption: encryption(),
      applyCredential,
      clearCredential: vi.fn(async () => "cleared" as const),
      renameCredentialFile: vi.fn(async (from: string, to: string) => {
        if (to.endsWith(".deleted")) throw new TypeError();
        await rename(from, to);
      }) as never,
    });
    await vault.writeCredential({ slot: "anthropic", value: randomUUID() });

    await expect(vault.deleteCredential("anthropic")).resolves.toEqual({
      slot: "anthropic",
      status: "refused",
      reason: "storage-failed",
    });
    await expect(vault.credentialStatuses()).resolves.toContainEqual({
      slot: "anthropic",
      state: "configured",
      runtimeState: "active",
    });

    restoreFails = true;
    await expect(vault.deleteCredential("anthropic")).resolves.toEqual({
      slot: "anthropic",
      status: "refused",
      reason: "runtime-state-diverged",
    });
    await expect(vault.credentialStatuses()).resolves.toContainEqual({
      slot: "anthropic",
      state: "configured",
      runtimeState: "failed",
    });
  });

  it("commits logical deletion while truthfully reporting pending tombstone cleanup", async () => {
    const root = await temporaryRoot();
    const vault = createCredentialVault({
      root,
      encryption: encryption(),
      applyCredential: vi.fn(async () => {}),
      removeCredentialFile: vi.fn(async () => {
        throw new TypeError();
      }) as never,
    });
    await vault.writeCredential({ slot: "openrouter", value: randomUUID() }, { activate: false });

    await expect(vault.deleteCredential("openrouter")).resolves.toEqual({
      slot: "openrouter",
      status: "deleted",
      cleanupPending: true,
    });

    expect((await readdir(root)).some((entry) => entry.endsWith(".deleted"))).toBe(true);
    await expect(vault.credentialStatuses()).resolves.toContainEqual({
      slot: "openrouter",
      state: "missing",
      runtimeState: null,
    });
  });

  posixIt("reports deletion uncertainty when neither the visible delete nor restoration is durable", async () => {
    const root = await temporaryRoot();
    const encryptionPort = encryption();
    await storeEncryptedCredential(root, "openrouter", "synthetic-old", encryptionPort);
    let renameCount = 0;
    let syncCount = 0;
    const vault = createCredentialVault({
      root,
      encryption: encryptionPort,
      applyCredential: vi.fn(async () => undefined),
      renameCredentialFile: (async (from: string, to: string) => {
        renameCount += 1;
        if (renameCount === 2) throw new TypeError("synthetic restoration rename failure");
        await rename(from, to);
      }) as never,
      syncCredentialDirectory: async () => {
        syncCount += 1;
        if (syncCount === 2) throw new TypeError("synthetic deletion directory sync failure");
        const directory = await open(root, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      },
    });

    await expect(vault.deleteCredential("openrouter")).resolves.toEqual({
      slot: "openrouter",
      status: "uncertain",
      reason: "storage-uncertain",
    });
    await expect(vault.credentialStatuses()).resolves.toContainEqual({
      slot: "openrouter",
      state: "re-prompt",
      runtimeState: null,
    });
    expect((await readdir(root)).some((entry) => entry.endsWith(".deleted"))).toBe(true);
  });

  it("fails closed for insecure directories and targets", async ({ skip }) => {
    const root = await temporaryRoot();
    await mkdir(root, { mode: 0o755 });
    const vault = createCredentialVault({
      root,
      encryption: encryption(),
      applyCredential: vi.fn(),
      clearCredential: vi.fn(async () => "cleared" as const),
    });
    const permissiveDirectoryWrite = vault.writeCredential({
      slot: "anthropic",
      value: "synthetic",
    });
    if (process.platform === "win32") {
      await expect(permissiveDirectoryWrite).resolves.toMatchObject({ status: "configured" });
      await expect(vault.deleteCredential("anthropic")).resolves.toMatchObject({
        status: "deleted",
      });
    } else {
      await expect(permissiveDirectoryWrite).resolves.toMatchObject({
        status: "refused",
        reason: "storage-failed",
      });
      await chmod(root, 0o700);
    }
    const symlinkCapabilityReason = await createSymlinkOrReturnWindowsCapabilityReason(
      join(root, "missing"),
      join(root, "anthropic.bin"),
    );
    if (symlinkCapabilityReason) return skip(symlinkCapabilityReason);
    await expect(
      vault.writeCredential({ slot: "anthropic", value: "synthetic" }),
    ).resolves.toMatchObject({
      status: "refused",
      reason: "storage-failed",
    });
    await rm(join(root, "anthropic.bin"));
    await writeFile(join(root, "anthropic.bin"), "", { mode: 0o600 });
    await expect(
      vault.writeCredential({ slot: "anthropic", value: "synthetic" }),
    ).resolves.toMatchObject({
      status: "refused",
      reason: "storage-failed",
    });
    await rm(join(root, "anthropic.bin"));
    await mkdir(join(root, "anthropic.bin"), { mode: 0o700 });
    await expect(
      vault.writeCredential({ slot: "anthropic", value: "synthetic" }),
    ).resolves.toMatchObject({
      status: "refused",
      reason: "storage-failed",
    });
    await rm(join(root, "anthropic.bin"), { recursive: true });
    await writeFile(join(root, "anthropic.bin"), "ciphertext", { mode: 0o644 });
    const permissiveFileWrite = vault.writeCredential({
      slot: "anthropic",
      value: "synthetic",
    });
    if (process.platform === "win32") {
      await expect(permissiveFileWrite).resolves.toMatchObject({ status: "configured" });
      expect((await readFile(join(root, "anthropic.bin"))).includes("synthetic")).toBe(false);
      await expect(vault.credentialStatuses()).resolves.toContainEqual({
        slot: "anthropic",
        state: "configured",
        runtimeState: "active",
      });
    } else {
      await expect(permissiveFileWrite).resolves.toMatchObject({
        status: "refused",
        reason: "storage-failed",
      });
    }
  });

  it("minimizes encryption backend failures without touching storage", async () => {
    const root = await temporaryRoot();
    const encryptString = vi.fn(() => Buffer.from("unused"));
    const vault = createCredentialVault({
      root,
      encryption: {
        isEncryptionAvailable: () => {
          throw new TypeError("synthetic backend detail");
        },
        encryptString,
        decryptString: vi.fn(),
      },
      applyCredential: vi.fn(),
    });
    await expect(
      vault.writeCredential({ slot: "anthropic", value: "synthetic-secret" }),
    ).resolves.toEqual({
      slot: "anthropic",
      status: "refused",
      reason: "encryption-unavailable",
    });
    expect(encryptString).not.toHaveBeenCalled();
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("isolates corruption and retries a committed runtime failure in main", async () => {
    const root = await temporaryRoot();
    let failRuntime = false;
    const applied: string[] = [];
    const vault = createCredentialVault({
      root,
      encryption: encryption(),
      async applyCredential(slot) {
        if (failRuntime) throw new TypeError();
        applied.push(slot);
      },
    });
    await vault.writeCredential({ slot: "anthropic", value: "synthetic-one" });
    await vault.writeCredential({ slot: "openrouter", value: "synthetic-two" });
    failRuntime = true;
    await expect(
      vault.writeCredential({ slot: "google", value: "synthetic-three" }),
    ).resolves.toEqual({
      slot: "google",
      status: "configured",
      runtimeReady: false,
    });
    expect((await lstat(join(root, "google.bin"))).isFile()).toBe(true);
    const corrupted = await readFile(join(root, "anthropic.bin"));
    corrupted[0] = corrupted[0]! ^ 0xff;
    await writeFile(join(root, "anthropic.bin"), corrupted, { mode: 0o600 });
    const statuses = await vault.credentialStatuses();
    expect(statuses).toContainEqual({ slot: "anthropic", state: "re-prompt", runtimeState: null });
    expect(statuses).toContainEqual({
      slot: "openrouter",
      state: "configured",
      runtimeState: "active",
    });
    expect(statuses).toContainEqual({
      slot: "google",
      state: "configured",
      runtimeState: "failed",
    });
    failRuntime = false;
    await vault.reapplyConfigured();
    expect(await vault.credentialStatuses()).toContainEqual({
      slot: "google",
      state: "configured",
      runtimeState: "active",
    });
    expect(applied).toContain("google");
  });

  it("keeps a legacy write stored when runtime returns a structured refusal", async () => {
    const root = await temporaryRoot();
    const encryptionPort = encryption();
    const vault = createCredentialVault({
      root,
      encryption: encryptionPort,
      applyCredential: vi.fn(async () => {
        throw new CredentialRuntimeRefusal("ownership-unavailable");
      }),
    });

    await expect(
      vault.writeCredential({ slot: "intervals-icu", value: "synthetic-intervals-key" }),
    ).resolves.toEqual({
      slot: "intervals-icu",
      status: "configured",
      runtimeReady: false,
    });
    expect(encryptionPort.decryptString(await readFile(join(root, "intervals-icu.bin")))).toBe(
      "synthetic-intervals-key",
    );
    await expect(vault.credentialStatuses()).resolves.toContainEqual({
      slot: "intervals-icu",
      state: "configured",
      runtimeState: "failed",
    });
  });

  it("forwards an approval once without persisting or replaying it", async () => {
    const root = await temporaryRoot();
    const encryptionPort = encryption();
    const applyCredential = vi.fn(async () => {});
    const reapplyCredential = vi.fn(async () => "active" as const);
    const vault = createCredentialVault({
      root,
      encryption: encryptionPort,
      applyCredential,
      reapplyCredential,
    });

    await expect(
      vault.writeCredential(
        { slot: "intervals-icu", value: "synthetic-intervals-key" },
        { verificationApproval: VERIFICATION_APPROVAL },
      ),
    ).resolves.toEqual({
      slot: "intervals-icu",
      status: "configured",
      runtimeReady: true,
    });
    expect(applyCredential).toHaveBeenCalledWith(
      "intervals-icu",
      "synthetic-intervals-key",
      undefined,
      VERIFICATION_APPROVAL,
    );
    const persisted = await readFile(join(root, "intervals-icu.bin"));
    expect(encryptionPort.decryptString(persisted)).toBe("synthetic-intervals-key");
    expect(persisted.includes(Buffer.from(VERIFICATION_APPROVAL))).toBe(false);
    expect(JSON.stringify(await vault.credentialStatuses())).not.toContain(VERIFICATION_APPROVAL);

    applyCredential.mockClear();
    await vault.reapplyConfigured();

    expect(applyCredential).not.toHaveBeenCalled();
    expect(reapplyCredential).toHaveBeenCalledWith(
      "intervals-icu",
      "synthetic-intervals-key",
      ["intervals-icu"],
    );
    expect(JSON.stringify(reapplyCredential.mock.calls)).not.toContain(VERIFICATION_APPROVAL);
  });

  it("keeps legacy Intervals activation tokenless when no approval is present", async () => {
    const root = await temporaryRoot();
    const applyCredential = vi.fn(async () => {});
    const vault = createCredentialVault({ root, encryption: encryption(), applyCredential });

    await expect(
      vault.writeCredential(
        { slot: "intervals-icu", value: "synthetic-intervals-key" },
        { rollbackOnRuntimeRefusal: true },
      ),
    ).resolves.toEqual({
      slot: "intervals-icu",
      status: "configured",
      runtimeReady: true,
    });
    expect(applyCredential.mock.calls).toEqual([
      ["intervals-icu", "synthetic-intervals-key"],
    ]);
  });

  it("refuses approval data outside an explicit Intervals activation", async () => {
    const root = await temporaryRoot();
    const applyCredential = vi.fn(async () => {});
    const vault = createCredentialVault({ root, encryption: encryption(), applyCredential });

    await expect(
      vault.writeCredential(
        { slot: "anthropic", value: "synthetic-model-key" },
        { verificationApproval: VERIFICATION_APPROVAL },
      ),
    ).resolves.toEqual({ slot: "anthropic", status: "refused", reason: "invalid-input" });
    await expect(
      vault.writeCredential(
        { slot: "intervals-icu", value: "synthetic-intervals-key" },
        { activate: false, verificationApproval: VERIFICATION_APPROVAL },
      ),
    ).resolves.toEqual({ slot: "intervals-icu", status: "refused", reason: "invalid-input" });
    expect(applyCredential).not.toHaveBeenCalled();
    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("routes passive replay separately from an explicit credential selection", async () => {
    const root = await temporaryRoot();
    const applyCredential = vi.fn(async () => {});
    const reapplyCredential = vi.fn(async () => "stored-inactive" as const);
    const vault = createCredentialVault({
      root,
      encryption: encryption(),
      applyCredential,
      reapplyCredential,
    });
    await vault.writeCredential({
      slot: "anthropic",
      value: String.fromCharCode(115, 121, 110, 116, 104, 101, 116, 105, 99),
    });
    expect(applyCredential).toHaveBeenCalledOnce();
    expect(reapplyCredential).not.toHaveBeenCalled();

    await vault.reapplyConfigured();

    expect(reapplyCredential).toHaveBeenCalledOnce();
    expect(await vault.credentialStatuses()).toContainEqual({
      slot: "anthropic",
      state: "configured",
      runtimeState: "stored-inactive",
    });
  });

  it("retries a failed credential through selection-aware replay", async () => {
    const root = await temporaryRoot();
    let runtimeAvailable = false;
    const applyCredential = vi.fn(async () => {
      if (!runtimeAvailable) throw new TypeError();
    });
    const reapplyCredential = vi.fn(async () => {
      if (!runtimeAvailable) throw new TypeError();
      return "active" as const;
    });
    const vault = createCredentialVault({
      root,
      encryption: encryption(),
      applyCredential,
      reapplyCredential,
    });
    await vault.writeCredential({ slot: "anthropic", value: randomUUID() });
    await expect(vault.credentialStatuses()).resolves.toContainEqual({
      slot: "anthropic",
      state: "configured",
      runtimeState: "failed",
    });
    await vault.reapplyConfigured();
    await expect(vault.credentialStatuses()).resolves.toContainEqual({
      slot: "anthropic",
      state: "configured",
      runtimeState: "failed",
    });
    runtimeAvailable = true;

    await vault.retryFailed();

    expect(reapplyCredential).toHaveBeenCalledTimes(2);
    expect(applyCredential).toHaveBeenCalledOnce();
    await expect(vault.credentialStatuses()).resolves.toContainEqual({
      slot: "anthropic",
      state: "configured",
      runtimeState: "active",
    });
  });

  it("fails closed when runtime publication becomes stale after apply, replay, or retry", async () => {
    const root = await temporaryRoot();
    let current = true;
    const vault = createCredentialVault({
      root,
      encryption: encryption(),
      createRuntimePublicationGuard: () => () => current,
      async applyCredential() {
        current = false;
      },
      async reapplyCredential() {
        current = false;
        return "active";
      },
    });

    await expect(
      vault.writeCredential({ slot: "anthropic", value: randomUUID() }),
    ).resolves.toEqual({
      slot: "anthropic",
      status: "configured",
      runtimeReady: false,
    });
    current = true;
    await vault.reapplyConfigured();
    await expect(vault.credentialStatuses()).resolves.toContainEqual({
      slot: "anthropic",
      state: "configured",
      runtimeState: "failed",
    });
    current = true;
    await vault.retryFailed();
    await expect(vault.credentialStatuses()).resolves.toContainEqual({
      slot: "anthropic",
      state: "configured",
      runtimeState: "failed",
    });
  });

  it("refuses a stale failed retry after another provider becomes selected", async () => {
    const root = await temporaryRoot();
    let selectedProvider: "anthropic" | "openrouter" = "anthropic";
    const applyCredential = vi.fn(async () => {
      throw new TypeError();
    });
    const vault = createCredentialVault({
      root,
      encryption: encryption(),
      applyCredential,
      reapplyCredential: async (slot) => (slot === selectedProvider ? "active" : "stored-inactive"),
    });
    await vault.writeCredential({ slot: "anthropic", value: randomUUID() });
    await expect(vault.credentialStatuses()).resolves.toContainEqual({
      slot: "anthropic",
      state: "configured",
      runtimeState: "failed",
    });

    selectedProvider = "openrouter";
    await vault.retryFailed();
    expect(applyCredential).toHaveBeenCalledOnce();
    await expect(vault.credentialStatuses()).resolves.toContainEqual({
      slot: "anthropic",
      state: "configured",
      runtimeState: "stored-inactive",
    });
  });

  it("reports a deliberately skipped stored credential as inactive without retrying it", async () => {
    const root = await temporaryRoot();
    const applyCredential = vi.fn(async () => {});
    const reapplyCredential = vi.fn(async () => "stored-inactive" as const);
    const vault = createCredentialVault({
      root,
      encryption: encryption(),
      applyCredential,
      reapplyCredential,
    });
    await vault.writeCredential({ slot: "anthropic", value: randomUUID() });

    await vault.reapplyConfigured();

    await expect(vault.credentialStatuses()).resolves.toContainEqual({
      slot: "anthropic",
      state: "configured",
      runtimeState: "stored-inactive",
    });
    await vault.retryFailed();
    expect(applyCredential).toHaveBeenCalledOnce();
  });

  it("publishes successor replay failures into the long-lived retry state", async () => {
    const root = await temporaryRoot();
    const runtimeState = new Map();
    let applyCredentialCount = 0;
    const applyCredential = async (): Promise<void> => {
      applyCredentialCount += 1;
    };
    const vault = createCredentialVault({
      root,
      encryption: encryption(),
      runtimeState,
      applyCredential,
    });
    await vault.writeCredential({ slot: "anthropic", value: randomUUID() });

    const successor = createCredentialVault({
      root,
      encryption: encryption(),
      applyCredential: async () => {
        throw new TypeError();
      },
    });
    await successor.reapplyConfigured();
    replaceCredentialRuntimeStates(runtimeState, await successor.credentialStatuses());

    await expect(vault.credentialStatuses()).resolves.toContainEqual({
      slot: "anthropic",
      state: "configured",
      runtimeState: "failed",
    });
    await vault.retryFailed();
    expect(applyCredentialCount).toBe(2);
    await expect(vault.credentialStatuses()).resolves.toContainEqual({
      slot: "anthropic",
      state: "configured",
      runtimeState: "active",
    });
  });

  it("marks a concurrently changed slot failed instead of publishing stale successor state", () => {
    const runtimeState = new Map([["anthropic" as const, "active" as const]]);

    replaceCredentialRuntimeStates(
      runtimeState,
      [{ slot: "anthropic", state: "configured", runtimeState: "active" }],
      () => false,
    );

    expect(runtimeState.get("anthropic")).toBe("failed");
  });

  it("keeps only the selected model credential active", async () => {
    const root = await temporaryRoot();
    const vault = createCredentialVault({
      root,
      encryption: encryption(),
      applyCredential: async () => {},
    });

    await vault.writeCredential({ slot: "anthropic", value: randomUUID() });
    await vault.writeCredential({ slot: "openrouter", value: randomUUID() });

    await expect(vault.credentialStatuses()).resolves.toEqual(
      expect.arrayContaining([
        { slot: "anthropic", state: "configured", runtimeState: "stored-inactive" },
        { slot: "openrouter", state: "configured", runtimeState: "active" },
      ]),
    );
  });

  it("stores an unrelated key without replacing the selected provider's custom endpoint", async () => {
    const root = await temporaryRoot();
    let selectedProvider = "openrouter";
    let baseUrl: string | undefined = "https://private.models.example/v1";
    const applyCredential = vi.fn(async (slot, _value, selection) => {
      const providerChanged = selectedProvider !== slot;
      selectedProvider = slot;
      if (providerChanged) {
        baseUrl = slot === "openrouter" ? "https://openrouter.ai/api/v1" : undefined;
      }
      if (selection?.endpoint.mode === "default") {
        baseUrl = "https://openrouter.ai/api/v1";
      } else if (selection?.endpoint.mode === "custom") {
        baseUrl = selection.endpoint.value;
      }
    });
    const vault = createCredentialVault({
      root,
      encryption: encryption(),
      applyCredential,
    });

    await expect(
      vault.writeCredential(
        { slot: "anthropic", value: "stored-anthropic-secret" },
        { activate: false },
      ),
    ).resolves.toEqual({
      slot: "anthropic",
      status: "configured",
      runtimeReady: false,
    });
    await expect(
      vault.writeCredential({
        slot: "openrouter",
        value: "selected-openrouter-secret",
        selection: {
          provider: "openrouter",
          model: "deepseek/deepseek-v4-flash",
          endpoint: { mode: "automatic" },
        },
      }),
    ).resolves.toEqual({
      slot: "openrouter",
      status: "configured",
      runtimeReady: true,
    });

    expect(applyCredential).toHaveBeenCalledOnce();
    expect(selectedProvider).toBe("openrouter");
    expect(baseUrl).toBe("https://private.models.example/v1");
    await expect(vault.credentialStatuses()).resolves.toEqual(
      expect.arrayContaining([
        { slot: "anthropic", state: "configured", runtimeState: "stored-inactive" },
        { slot: "openrouter", state: "configured", runtimeState: "active" },
      ]),
    );
  });

  it("applies a credential and matching selection through one guarded callback", async () => {
    const root = await temporaryRoot();
    const applyCredential = vi.fn(async () => {});
    const vault = createCredentialVault({
      root,
      encryption: encryption(),
      applyCredential,
    });
    const modelSelection = {
      provider: "openrouter" as const,
      model: "athlete-model",
      endpoint: { mode: "default" as const },
    };

    await expect(
      vault.writeCredential({
        slot: "openrouter",
        value: "  obviously-fake-key  ",
        selection: modelSelection,
      }),
    ).resolves.toEqual({
      slot: "openrouter",
      status: "configured",
      runtimeReady: true,
    });
    expect(applyCredential).toHaveBeenCalledOnce();
    expect(applyCredential).toHaveBeenCalledWith(
      "openrouter",
      "obviously-fake-key",
      modelSelection,
    );
  });

  it("activates a stored key without returning it and supports a failed activation retry", async () => {
    const root = await temporaryRoot();
    let failSelection = false;
    const applyCredential = vi.fn(async (_slot, _value, selected) => {
      if (selected !== undefined && failSelection) throw new TypeError();
    });
    const vault = createCredentialVault({
      root,
      encryption: encryption(),
      applyCredential,
    });
    await vault.writeCredential({
      slot: "anthropic",
      value: "stored-anthropic-secret",
    });
    await vault.writeCredential({
      slot: "openrouter",
      value: "stored-openrouter-secret",
    });
    const modelSelection = {
      provider: "anthropic" as const,
      model: "athlete-model",
      endpoint: { mode: "automatic" as const },
    };

    failSelection = true;
    const failed = await vault.applyLlmSelection(modelSelection);
    expect(failed).toEqual({ status: "refused", reason: "runtime-unavailable" });
    expect(JSON.stringify(failed)).not.toContain("stored-anthropic-secret");
    await expect(vault.credentialStatuses()).resolves.toContainEqual({
      slot: "anthropic",
      state: "configured",
      runtimeState: "failed",
    });

    failSelection = false;
    await expect(vault.applyLlmSelection(modelSelection)).resolves.toEqual({
      status: "configured",
      runtimeReady: true,
    });
    await expect(vault.credentialStatuses()).resolves.toEqual(
      expect.arrayContaining([
        { slot: "anthropic", state: "configured", runtimeState: "active" },
        { slot: "openrouter", state: "configured", runtimeState: "stored-inactive" },
      ]),
    );
    expect(applyCredential).toHaveBeenLastCalledWith(
      "anthropic",
      "stored-anthropic-secret",
      modelSelection,
    );
  });

  it("requires a securely readable matching key before applying a selection", async () => {
    const root = await temporaryRoot();
    const applyCredential = vi.fn(async () => {});
    const vault = createCredentialVault({
      root,
      encryption: encryption(),
      applyCredential,
    });

    await expect(
      vault.applyLlmSelection({
        provider: "anthropic",
        model: "model",
        endpoint: { mode: "automatic" },
      }),
    ).resolves.toEqual({ status: "refused", reason: "credential-required" });
    await expect(
      vault.applyLlmSelection({
        provider: "openai-codex",
        model: "model",
        endpoint: { mode: "automatic" },
      }),
    ).resolves.toEqual({ status: "refused", reason: "invalid-input" });
    expect(applyCredential).not.toHaveBeenCalled();
  });

  it("reopens DPAPI-shaped Windows ciphertext without POSIX modes or directory sync", async () => {
    const root = await temporaryRoot();
    const backend = vi.fn(() => {
      throw new TypeError("Linux-only backend probe");
    });
    const encryptionPort = { ...encryption(), getSelectedStorageBackend: backend };
    const syncCredentialDirectory = vi.fn(async () => {
      throw new TypeError("Windows directory sync must stay unavailable");
    });
    const syncCredentialParentDirectory = vi.fn(async () => {
      throw new TypeError("Windows parent sync must stay unavailable");
    });
    const vault = createCredentialVault({
      root,
      platform: "win32",
      encryption: encryptionPort,
      applyCredential: vi.fn(async () => undefined),
      createId: () => randomUUID(),
      syncCredentialDirectory,
      syncCredentialParentDirectory,
    });

    await expect(
      vault.writeCredential({ slot: "anthropic", value: "synthetic-windows-anthropic" }),
    ).resolves.toMatchObject({ status: "configured" });
    await expect(
      vault.writeCredential({ slot: "openrouter", value: "synthetic-windows-openrouter" }),
    ).resolves.toMatchObject({ status: "configured" });
    expect(
      (await readFile(join(root, "anthropic.bin"))).includes("synthetic-windows-anthropic"),
    ).toBe(false);
    expect(
      (await readFile(join(root, "openrouter.bin"))).includes("synthetic-windows-openrouter"),
    ).toBe(false);

    await chmod(root, 0o755);
    await writeFile(join(root, "anthropic.bin"), "corrupt-ciphertext");
    const reopened = createCredentialVault({
      root,
      platform: "win32",
      encryption: encryptionPort,
      applyCredential: vi.fn(async () => undefined),
      syncCredentialDirectory,
      syncCredentialParentDirectory,
    });
    await expect(reopened.credentialStatuses()).resolves.toEqual(
      expect.arrayContaining([
        { slot: "anthropic", state: "re-prompt", runtimeState: null },
        { slot: "openrouter", state: "configured", runtimeState: "stored-inactive" },
      ]),
    );
    expect(backend).not.toHaveBeenCalled();
    expect(syncCredentialDirectory).not.toHaveBeenCalled();
    expect(syncCredentialParentDirectory).not.toHaveBeenCalled();
  });

  it("marks model credentials inactive when a profile becomes selected", () => {
    const runtimeState = new Map([
      ["anthropic" as const, "active" as const],
      ["openrouter" as const, "failed" as const],
      ["intervals-icu" as const, "active" as const],
    ]);

    markUnselectedModelCredentialsInactive(runtimeState, undefined);

    expect(runtimeState).toEqual(
      new Map([
        ["anthropic", "stored-inactive"],
        ["openrouter", "stored-inactive"],
        ["intervals-icu", "active"],
      ]),
    );
  });
});
