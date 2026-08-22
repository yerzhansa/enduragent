import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCredentialEnvelopeMutationLock } from "../src/main/credential-envelope-lock.js";
import { credentialEnvelopeTargets } from "../src/main/credential-envelope-inventory.js";
import { resetEncryptedCredentialStorage } from "../src/main/credential-reset.js";
import {
  CREDENTIAL_DIRECTORY_MODE,
  CREDENTIAL_FILE_MODE,
} from "../src/main/credential-vault.js";
import {
  TELEGRAM_CREDENTIAL_DIRECTORY_MODE,
  TELEGRAM_CREDENTIAL_FILE_MODE,
  TELEGRAM_PROFILE_FILE_NAME,
} from "../src/main/telegram-credential-vault.js";

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "credential-reset-"));
  roots.push(root);
  const credentialRoot = join(root, "credentials-v1");
  const telegramRoot = join(root, "telegram-channel-v1");
  await mkdir(credentialRoot, { recursive: true, mode: CREDENTIAL_DIRECTORY_MODE });
  await mkdir(telegramRoot, { recursive: true, mode: TELEGRAM_CREDENTIAL_DIRECTORY_MODE });
  return { credentialRoot, telegramRoot };
}

async function createDirectoryLinkOrReturnWindowsCapabilityReason(
  target: string,
  path: string,
): Promise<string | undefined> {
  try {
    await symlink(target, path, process.platform === "win32" ? "junction" : "dir");
    return undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) {
      return `Windows symlink capability unavailable (${code})`;
    }
    throw error;
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("encrypted credential reset", () => {
  it("removes every envelope under one shared lock and preserves unrelated files", async () => {
    const storage = await fixture();
    for (const target of credentialEnvelopeTargets(storage)) {
      await writeFile(join(target.root, target.fileName), Buffer.from("synthetic-envelope"));
    }
    const unrelated = join(storage.credentialRoot, "keep.txt");
    const credentialTemporary = join(storage.credentialRoot, ".anthropic.bin.reset-1.tmp");
    const telegramTombstone = join(
      storage.telegramRoot,
      `.${TELEGRAM_PROFILE_FILE_NAME}.reset-2.deleted`,
    );
    const unrelatedTemporary = join(storage.credentialRoot, ".unknown.bin.reset-3.tmp");
    await writeFile(unrelated, "keep");
    await writeFile(credentialTemporary, "credential-transient");
    await writeFile(telegramTombstone, "telegram-transient");
    await writeFile(unrelatedTemporary, "unrelated-transient");
    const deleteKey = vi.fn(async () => ({ status: "deleted" as const }));

    const result = await resetEncryptedCredentialStorage({
      ...storage,
      serializeEnvelopeMutation: createCredentialEnvelopeMutationLock(),
      deleteKey,
    });

    expect(result).toEqual({ status: "reset", keyCleanupPending: false });
    expect(deleteKey).toHaveBeenCalledOnce();
    await expect(readFile(unrelated, "utf8")).resolves.toBe("keep");
    await expect(readFile(unrelatedTemporary, "utf8")).resolves.toBe("unrelated-transient");
    await expect(readFile(credentialTemporary)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(telegramTombstone)).rejects.toMatchObject({ code: "ENOENT" });
    for (const target of credentialEnvelopeTargets(storage)) {
      await expect(readFile(join(target.root, target.fileName))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }
  });

  it("does not delete the shared key while any envelope survives", async () => {
    const storage = await fixture();
    const target = credentialEnvelopeTargets(storage)[0]!;
    await writeFile(join(target.root, target.fileName), Buffer.from("synthetic-envelope"));
    const deleteKey = vi.fn(async () => ({ status: "deleted" as const }));

    const result = await resetEncryptedCredentialStorage({
      ...storage,
      serializeEnvelopeMutation: createCredentialEnvelopeMutationLock(),
      deleteKey,
      removeFile: vi.fn(async () => {
        throw new Error("synthetic removal failure");
      }) as never,
    });

    expect(result).toEqual({ status: "failed" });
    expect(deleteKey).not.toHaveBeenCalled();
  });

  it("accepts missing roots without following or inspecting them", async () => {
    const storage = await fixture();
    await rm(storage.credentialRoot, { recursive: true });
    await rm(storage.telegramRoot, { recursive: true });
    const readEnvelopeFile = vi.fn(async () => Buffer.from("must not be read"));
    const readEnvelopeDirectory = vi.fn(async () => ["must-not-be-read.bin"]);
    const deleteKey = vi.fn(async () => ({ status: "deleted" as const }));

    const result = await resetEncryptedCredentialStorage({
      ...storage,
      readEnvelopeFile,
      readEnvelopeDirectory,
      serializeEnvelopeMutation: createCredentialEnvelopeMutationLock(),
      deleteKey,
    });

    expect(result).toEqual({ status: "reset", keyCleanupPending: false });
    expect(readEnvelopeFile).not.toHaveBeenCalled();
    expect(readEnvelopeDirectory).not.toHaveBeenCalled();
    expect(deleteKey).toHaveBeenCalledOnce();
  });

  it("refuses both roots atomically when one root redirects outside its vault", async ({ skip }) => {
    const storage = await fixture();
    const credentialPath = join(storage.credentialRoot, "anthropic.bin");
    const externalRoot = join(storage.telegramRoot, "..", "external-telegram-vault");
    const externalProfile = join(externalRoot, TELEGRAM_PROFILE_FILE_NAME);
    const externalUnrelated = join(externalRoot, "keep.txt");
    await writeFile(credentialPath, "credential-envelope", { mode: CREDENTIAL_FILE_MODE });
    await mkdir(externalRoot, { mode: TELEGRAM_CREDENTIAL_DIRECTORY_MODE });
    await writeFile(externalProfile, "telegram-envelope", {
      mode: TELEGRAM_CREDENTIAL_FILE_MODE,
    });
    await writeFile(externalUnrelated, "keep", { mode: TELEGRAM_CREDENTIAL_FILE_MODE });
    await rm(storage.telegramRoot, { recursive: true });
    const capabilityReason = await createDirectoryLinkOrReturnWindowsCapabilityReason(
      externalRoot,
      storage.telegramRoot,
    );
    if (capabilityReason) return skip(capabilityReason);
    const deleteKey = vi.fn(async () => ({ status: "deleted" as const }));

    const result = await resetEncryptedCredentialStorage({
      ...storage,
      serializeEnvelopeMutation: createCredentialEnvelopeMutationLock(),
      deleteKey,
    });

    expect(result).toEqual({ status: "failed" });
    expect(deleteKey).not.toHaveBeenCalled();
    await expect(readFile(credentialPath, "utf8")).resolves.toBe("credential-envelope");
    await expect(readFile(externalProfile, "utf8")).resolves.toBe("telegram-envelope");
    await expect(readFile(externalUnrelated, "utf8")).resolves.toBe("keep");
  });

  it("reports deferred key cleanup after every envelope is gone", async () => {
    const storage = await fixture();

    const result = await resetEncryptedCredentialStorage({
      ...storage,
      serializeEnvelopeMutation: createCredentialEnvelopeMutationLock(),
      deleteKey: async () => ({ status: "failed", code: "keychain-locked" }),
    });

    expect(result).toEqual({ status: "reset", keyCleanupPending: true });
  });
});
