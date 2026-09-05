import { prepareDesktopCredentialEncryption } from "../src/main/desktop-credential-encryption.js";
import { createAcceptanceKeychainTransport } from "../src/main/acceptance-credential-backend.js";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadStoredProfileSnapshot,
  recoverAndSaveStoredProfile,
  compareAndSaveStoredProfile,
  DESKTOP_OAUTH_OWNERSHIP_FILE,
  type CodexCredentials,
} from "@enduragent/core";
import { syntheticOAuthOwner } from "./helpers/oauth-owner.js";
import { createCredentialEnvelopeMutationLock } from "../src/main/credential-envelope-lock.js";
import { durableAtomicReplace } from "../src/main/durable-atomic-replace.js";
import { scanCredentialEnvelopes } from "../src/main/credential-envelope-inventory.js";
import { resetEncryptedCredentialStorage } from "../src/main/credential-reset.js";
import {
  sealCredentialEnvelope,
  openCredentialEnvelope,
} from "../src/main/keychain-credential-encryption.js";

const directories: string[] = [];
const synthetic = (suffix = "initial"): CodexCredentials => ({
  access: `synthetic-access-${suffix}`,
  refresh: `synthetic-refresh-${suffix}`,
  expires: 4_102_444_800_000,
  accountId: "synthetic-account",
});

async function fixture(overrides: Parameters<typeof syntheticOAuthOwner>[1] = {}) {
  const directory = await mkdtemp(join(tmpdir(), "desktop-oauth-owner-"));
  directories.push(directory);
  const configDir = join(directory, "config");
  const root = join(directory, "credentials-v1");
  const key = randomBytes(32);
  const encryption = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => sealCredentialEnvelope(key, value),
    decryptString: (bytes: Buffer) => openCredentialEnvelope(key, bytes),
  };
  const serializeEnvelopeMutation = createCredentialEnvelopeMutationLock();
  const options = { encryption, serializeEnvelopeMutation, ...overrides };
  const owner = syntheticOAuthOwner(configDir, options);
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const profilesPath = join(configDir, "auth-profiles.json");
  const seed = async (extra = {}) =>
    writeFile(
      profilesPath,
      JSON.stringify({
        "openai-codex": { type: "oauth", ...synthetic() },
        ...extra,
      }),
      { mode: 0o600 },
    );
  return {
    directory,
    configDir,
    root,
    profilesPath,
    owner,
    options,
    seed,
    restart: () => syntheticOAuthOwner(configDir, options),
  };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("desktop OAuth credential ownership", () => {
  it.each(["fresh-login", "legacy-migration"] as const)(
    "prepares a lazily created key before %s",
    async (scenario) => {
      const f = await fixture();
      const backend = await prepareDesktopCredentialEncryption({
        credentialRoot: f.root,
        telegramRoot: join(f.directory, "telegram-channel-v1"),
        location: {
          platform: "darwin",
          packaged: false,
          resourcesPath: f.directory,
          applicationPath: f.directory,
        },
        safeStorage: f.options.encryption,
        serializeEnvelopeMutation: f.options.serializeEnvelopeMutation,
        createTransport: () =>
          createAcceptanceKeychainTransport({ kind: "memory", key: randomBytes(32) }),
      });
      expect(backend.selection.status).toBe("keychain");
      expect(backend.encryption.isEncryptionAvailable()).toBe(false);
      const owner = syntheticOAuthOwner(f.configDir, {
        ...f.options,
        encryption: backend.encryption,
        prepareEnvelopeWrite: (proof) => backend.prepareEnvelopeWrite(proof),
        revalidateEnvelopeRemoval: (proof) => backend.revalidateEnvelopeRemoval(proof),
      });
      if (scenario === "legacy-migration") {
        await f.seed();
        await owner.initialize();
      } else {
        await owner.initialize();
        await owner.writeProfile(synthetic());
      }
      await expect(owner.getAccessToken("openai-codex")).resolves.toBe(synthetic().access);
      expect(backend.encryption.isEncryptionAvailable()).toBe(true);
      await writeFile(join(f.root, "oauth.bin"), "synthetic-corrupt-envelope");
      await expect(owner.recoveryRequired()).resolves.toBe(true);
      await expect(backend.credentialRecoverySnapshot()).resolves.toMatchObject({
        unverifiedEnvelopes: 1,
        oauthEnvelopeUnverified: true,
      });
    },
  );

  it("verifies encrypted migration, retains unrelated profiles, and refuses shared CLI access", async () => {
    const f = await fixture({ selectedProfile: "selected-custom" });
    await f.seed({
      other: { marker: "preserved" },
      "selected-custom": { type: "oauth", ...synthetic("custom") },
    });
    const stale = loadStoredProfileSnapshot(f.profilesPath, "openai-codex")!;
    await f.owner.initialize();
    expect(JSON.parse(await readFile(f.profilesPath, "utf8"))).toEqual({
      other: { marker: "preserved" },
    });
    expect(await readFile(join(f.configDir, DESKTOP_OAUTH_OWNERSHIP_FILE), "utf8")).not.toContain(
      "synthetic-",
    );
    const encrypted = await readFile(join(f.root, "oauth.bin"));
    expect(encrypted.includes(Buffer.from("synthetic-access"))).toBe(false);
    expect(encrypted.includes(Buffer.from("synthetic-refresh"))).toBe(false);
    await expect(f.restart().getAccessToken("selected-custom")).resolves.toBe(
      synthetic("custom").access,
    );
    expect(() => loadStoredProfileSnapshot(f.profilesPath, "openai-codex")).toThrow(
      "separate CLI home",
    );
    expect(() =>
      recoverAndSaveStoredProfile(f.profilesPath, "openai-codex", stale.profile),
    ).toThrow("separate CLI home");
    await expect(
      compareAndSaveStoredProfile(f.profilesPath, "openai-codex", stale, stale.profile),
    ).rejects.toThrow("separate CLI home");
    if (process.platform !== "win32")
      expect((await stat(join(f.root, "oauth.bin"))).mode & 0o777).toBe(0o600);
  });

  it("allows independent CLI profiles to save and refresh", async () => {
    const f = await fixture();
    const profile = { type: "oauth", ...synthetic() };
    recoverAndSaveStoredProfile(f.profilesPath, "openai-codex", profile);
    const snapshot = loadStoredProfileSnapshot(f.profilesPath, "openai-codex")!;
    await expect(
      compareAndSaveStoredProfile(f.profilesPath, "openai-codex", snapshot, {
        type: "oauth",
        ...synthetic("refreshed"),
      }),
    ).resolves.toMatchObject({ status: "saved" });
    expect(loadStoredProfileSnapshot(f.profilesPath, "openai-codex")?.profile.access).toBe(
      synthetic("refreshed").access,
    );
  });

  it.each(["before-write", "after-write"] as const)(
    "retains source and resumes after %s failure",
    async (stage) => {
      let failing = true;
      const f = await fixture({
        replaceEnvelope: async (input) => {
          if (failing && stage === "before-write")
            throw new Error("synthetic secret must not escape");
          const result = await durableAtomicReplace(input);
          if (failing) return { state: "commit-uncertain" };
          return result;
        },
      });
      await f.seed({ other: { preserved: true } });
      const original = await readFile(f.profilesPath);
      await expect(f.owner.initialize()).rejects.toThrow("credentials are unavailable");
      expect(await readFile(f.profilesPath)).toEqual(original);
      await expect(readFile(join(f.configDir, DESKTOP_OAUTH_OWNERSHIP_FILE))).rejects.toMatchObject(
        { code: "ENOENT" },
      );
      failing = false;
      await f.restart().initialize();
      expect(JSON.parse(await readFile(f.profilesPath, "utf8"))).toEqual({
        other: { preserved: true },
      });
      await expect(f.restart().getAccessToken("openai-codex")).resolves.toBe(synthetic().access);
    },
  );

  it("does not overwrite a legacy revision changed after an interrupted migration", async () => {
    const f = await fixture({
      replaceEnvelope: async (input) => {
        await durableAtomicReplace(input);
        return { state: "commit-uncertain" };
      },
    });
    await f.seed();
    await expect(f.owner.initialize()).rejects.toThrow();
    const changed = { "openai-codex": { type: "oauth", ...synthetic("changed") } };
    await writeFile(f.profilesPath, JSON.stringify(changed));
    await expect(f.restart().initialize()).rejects.toThrow();
    expect(JSON.parse(await readFile(f.profilesPath, "utf8"))).toEqual(changed);
  });

  it.each(["locked", "unsafe", "corrupted"] as const)(
    "refuses %s storage without plaintext fallback",
    async (failure) => {
      let locked = false;
      let unsafe = false;
      const f = await fixture();
      const encryption = {
        ...f.options.encryption,
        isEncryptionAvailable: () => !locked,
        getSelectedStorageBackend: () => (unsafe ? "basic_text" : "synthetic"),
      };
      const owner = syntheticOAuthOwner(f.configDir, { ...f.options, encryption });
      await f.seed();
      await owner.initialize();
      await f.seed();
      if (failure === "locked") locked = true;
      if (failure === "unsafe") unsafe = true;
      if (failure === "corrupted") await writeFile(join(f.root, "oauth.bin"), "corrupt");
      await expect(owner.getAccessToken("openai-codex")).rejects.toThrow(
        "credentials are unavailable",
      );
      await expect(owner.hasProfile("openai-codex")).resolves.toBe(false);
    },
  );

  it("serializes refreshes and cannot resurrect a deleted credential", async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const refreshToken = vi.fn(async () => {
      started();
      await gate;
      return synthetic("refreshed");
    });
    const f = await fixture({ refreshToken });
    await f.owner.writeProfile(synthetic());
    const first = f.owner.getAccessToken("openai-codex", undefined, synthetic().access);
    await ready;
    const second = f.owner.getAccessToken("openai-codex", undefined, synthetic().access);
    const deletion = f.owner.deleteProfile("openai-codex");
    release();
    await expect(first).resolves.toBe(synthetic("refreshed").access);
    await expect(second).resolves.toBe(synthetic("refreshed").access);
    await deletion;
    expect(refreshToken).toHaveBeenCalledOnce();
    await expect(f.restart().hasProfile("openai-codex")).resolves.toBe(false);
  });

  it("includes OAuth in the key census and serializes refresh with complete reset", async () => {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const f = await fixture({
      refreshToken: async () => {
        started();
        await gate;
        return synthetic("refreshed");
      },
    });
    await f.owner.writeProfile(synthetic());
    const roots = {
      credentialRoot: f.root,
      telegramRoot: join(f.directory, "telegram-channel-v1"),
    };
    expect((await scanCredentialEnvelopes(roots)).keychainDependents).toBe(1);
    const refresh = f.owner.getAccessToken("openai-codex", undefined, synthetic().access);
    await ready;
    const deleteKey = vi.fn(async () => {
      expect((await scanCredentialEnvelopes(roots)).deletionBlockers).toEqual([]);
      return { status: "deleted" as const };
    });
    const reset = resetEncryptedCredentialStorage({
      ...roots,
      serializeEnvelopeMutation: f.options.serializeEnvelopeMutation,
      deleteKey,
    });
    expect(deleteKey).not.toHaveBeenCalled();
    release();
    await refresh;
    await expect(reset).resolves.toEqual({ status: "reset", keyCleanupPending: false });
    await expect(f.restart().hasProfile("openai-codex")).resolves.toBe(false);
  });

  it("does not create plaintext quarantine copies for malformed legacy data", async () => {
    const f = await fixture();
    await writeFile(f.profilesPath, '{"synthetic-refresh":"malformed');
    await expect(f.owner.initialize()).rejects.toThrow();
    expect(await readdir(f.configDir)).toEqual(["auth-profiles.json"]);
    await expect(f.owner.writeProfile(synthetic())).rejects.toThrow();
    expect(await readdir(f.configDir)).toEqual(["auth-profiles.json"]);
  });
});
