import { describe, expect, it, vi } from "vitest";
import type { CredentialEncryptionPort } from "../src/main/credential-vault.js";
import {
  createKeychainBackendSelectionProbeTransport,
  probePackagedKeychainBackendSelection,
} from "../src/main/keychain-backend-selection-probe.js";
import { KEYCHAIN_PARTITION_STORAGE_BACKEND } from "../src/main/keychain-credential-encryption.js";
import {
  KEYCHAIN_CREDENTIAL_SERVICE,
  KEYCHAIN_TEAM_IDENTIFIER,
  type KeychainBindingRequest,
  type KeychainBindingResponse,
  type KeychainBindingTransport,
} from "../src/main/keychain-binding.js";

const location = Object.freeze({
  platform: "darwin" as const,
  packaged: true,
  resourcesPath: "/synthetic/Enduragent.app/Contents/Resources",
  applicationPath: "/synthetic/Enduragent.app/Contents/Resources/app.asar",
});

function refusingSafeStorage() {
  const calls = {
    isEncryptionAvailable: vi.fn(() => {
      throw new Error("safeStorage must not be called");
    }),
    encryptString: vi.fn(() => {
      throw new Error("safeStorage must not be called");
    }),
    decryptString: vi.fn(() => {
      throw new Error("safeStorage must not be called");
    }),
    getSelectedStorageBackend: vi.fn(() => {
      throw new Error("safeStorage must not be called");
    }),
  } satisfies CredentialEncryptionPort;
  return { calls, port: calls };
}

describe("packaged keychain backend selection probe", () => {
  it("exercises production selection while only the native probe reaches the real transport", async () => {
    const requests: KeychainBindingRequest[] = [];
    const bindingTransport: KeychainBindingTransport = {
      send: vi.fn(async (request: KeychainBindingRequest): Promise<KeychainBindingResponse> => {
        requests.push(request);
        return { ok: true, op: "probe", teamIdentifier: KEYCHAIN_TEAM_IDENTIFIER };
      }),
    };
    const createTransport = vi.fn(() => bindingTransport);
    const safeStorage = refusingSafeStorage();

    await expect(
      probePackagedKeychainBackendSelection({
        credentialRoot: "/synthetic/probe-data/credentials-v1",
        telegramRoot: "/synthetic/probe-data/telegram-channel-v1",
        location,
        safeStorage: safeStorage.port,
        createTransport,
      }),
    ).resolves.toEqual({
      backend: KEYCHAIN_PARTITION_STORAGE_BACKEND,
      teamIdentifier: KEYCHAIN_TEAM_IDENTIFIER,
    });

    expect(createTransport).toHaveBeenCalledWith(
      "/synthetic/Enduragent.app/Contents/Resources/app.asar.unpacked/native/keychain-binding.node",
    );
    expect(requests).toEqual([{ op: "probe", service: KEYCHAIN_CREDENTIAL_SERVICE }]);
    for (const call of Object.values(safeStorage.calls)) expect(call).not.toHaveBeenCalled();
  });

  it("simulates a missing read and rejects every mutation without reaching the binding", async () => {
    const bindingTransport: KeychainBindingTransport = {
      send: vi.fn(
        async (): Promise<KeychainBindingResponse> => ({
          ok: true,
          op: "probe",
          teamIdentifier: KEYCHAIN_TEAM_IDENTIFIER,
        }),
      ),
    };
    const transport = createKeychainBackendSelectionProbeTransport(bindingTransport, () => {});

    await expect(
      transport.send({ op: "read-key", service: KEYCHAIN_CREDENTIAL_SERVICE }),
    ).resolves.toEqual({ ok: false, code: "item-not-found" });
    await expect(
      transport.send({ op: "create-key", service: KEYCHAIN_CREDENTIAL_SERVICE }),
    ).rejects.toThrow("release backend selection probe refused key mutation");
    await expect(
      transport.send({ op: "delete-key", service: KEYCHAIN_CREDENTIAL_SERVICE }),
    ).rejects.toThrow("release backend selection probe refused key mutation");
    expect(bindingTransport.send).not.toHaveBeenCalled();
  });

  it("fails when the native probe refuses or reports another team", async () => {
    const safeStorage = refusingSafeStorage();
    const refusal: KeychainBindingTransport = {
      send: vi.fn(
        async (): Promise<KeychainBindingResponse> => ({
          ok: false,
          code: "not-team-signed",
        }),
      ),
    };
    await expect(
      probePackagedKeychainBackendSelection({
        credentialRoot: "/synthetic/probe-data/credentials-v1",
        telegramRoot: "/synthetic/probe-data/telegram-channel-v1",
        location,
        safeStorage: safeStorage.port,
        createTransport: () => refusal,
      }),
    ).rejects.toThrow("did not select the keychain backend");

    const foreign: KeychainBindingTransport = {
      send: vi.fn(
        async (): Promise<KeychainBindingResponse> => ({
          ok: true,
          op: "probe",
          teamIdentifier: "ZZZZZZZZZZ",
        }),
      ),
    };
    await expect(
      probePackagedKeychainBackendSelection({
        credentialRoot: "/synthetic/probe-data/credentials-v1",
        telegramRoot: "/synthetic/probe-data/telegram-channel-v1",
        location,
        safeStorage: safeStorage.port,
        createTransport: () => foreign,
      }),
    ).rejects.toThrow("reported an unexpected identity");
  });

  it("refuses unpackaged and non-macOS locations before loading a binding", async () => {
    const safeStorage = refusingSafeStorage();
    const createTransport = vi.fn((): KeychainBindingTransport => {
      throw new Error("binding must not load");
    });
    for (const invalidLocation of [
      { ...location, packaged: false },
      { ...location, platform: "win32" as const },
    ]) {
      await expect(
        probePackagedKeychainBackendSelection({
          credentialRoot: "/synthetic/probe-data/credentials-v1",
          telegramRoot: "/synthetic/probe-data/telegram-channel-v1",
          location: invalidLocation,
          safeStorage: safeStorage.port,
          createTransport,
        }),
      ).rejects.toThrow("requires a packaged macOS application");
    }
    expect(createTransport).not.toHaveBeenCalled();
  });
});
