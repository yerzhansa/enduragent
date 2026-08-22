import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  KEYCHAIN_CREDENTIAL_SERVICE,
  KEYCHAIN_KEY_BYTES,
  KEYCHAIN_TEAM_IDENTIFIER,
  createKeychainBindingTransport,
  parseKeychainBindingResponse,
} from "../src/main/keychain-binding.js";

describe("keychain binding adapter", () => {
  it("validates the narrow native response shapes", () => {
    const key = randomBytes(KEYCHAIN_KEY_BYTES);
    expect(
      parseKeychainBindingResponse("probe", {
        ok: true,
        teamIdentifier: KEYCHAIN_TEAM_IDENTIFIER,
      }),
    ).toEqual({ ok: true, op: "probe", teamIdentifier: KEYCHAIN_TEAM_IDENTIFIER });
    expect(parseKeychainBindingResponse("read-key", { ok: true, key })).toEqual({
      ok: true,
      op: "read-key",
      key,
    });
    expect(parseKeychainBindingResponse("create-key", { ok: true, key: randomBytes(16) })).toEqual({
      ok: false,
      code: "unknown",
    });
    expect(parseKeychainBindingResponse("delete-key", { ok: true, deleted: false })).toEqual({
      ok: true,
      op: "delete-key",
      deleted: false,
    });
    expect(parseKeychainBindingResponse("probe", { ok: false, code: "keychain-locked" })).toEqual({
      ok: false,
      code: "keychain-locked",
    });
  });

  it("keeps the lifecycle seam asynchronous around an injected native fake", async () => {
    const key = randomBytes(KEYCHAIN_KEY_BYTES);
    const binding = {
      probe: vi.fn(() => ({ ok: true, teamIdentifier: KEYCHAIN_TEAM_IDENTIFIER })),
      readKey: vi.fn(() => ({ ok: true, key })),
      createKey: vi.fn(() => ({ ok: true, key })),
      deleteKey: vi.fn(() => ({ ok: true, deleted: true })),
    };
    const loadBinding = vi.fn(() => binding);
    const transport = createKeychainBindingTransport({
      bindingPath: "/synthetic/keychain-binding.node",
      loadBinding,
    });

    await expect(
      transport.send({ op: "probe", service: KEYCHAIN_CREDENTIAL_SERVICE }),
    ).resolves.toEqual({ ok: true, op: "probe", teamIdentifier: KEYCHAIN_TEAM_IDENTIFIER });
    await expect(
      transport.send({ op: "read-key", service: KEYCHAIN_CREDENTIAL_SERVICE }),
    ).resolves.toEqual({ ok: true, op: "read-key", key });
    expect(loadBinding).toHaveBeenCalledOnce();
    expect(binding.readKey).toHaveBeenCalledWith(KEYCHAIN_CREDENTIAL_SERVICE);
  });

  it("maps missing, replaced, and wrong-shape native modules to unknown", async () => {
    for (const loadBinding of [
      () => {
        throw new Error("missing");
      },
      () => ({ probe: () => ({ ok: true }) }),
      () => ({
        probe: () => ({ ok: true, teamIdentifier: "OTHERTEAM" }),
        readKey: () => ({ ok: true, key: Buffer.alloc(KEYCHAIN_KEY_BYTES) }),
        createKey: () => ({ ok: true, key: Buffer.alloc(KEYCHAIN_KEY_BYTES) }),
        deleteKey: () => ({ ok: true, deleted: true }),
      }),
    ]) {
      const transport = createKeychainBindingTransport({
        bindingPath: "/synthetic/keychain-binding.node",
        loadBinding,
      });
      await expect(
        transport.send({ op: "probe", service: KEYCHAIN_CREDENTIAL_SERVICE }),
      ).resolves.toEqual({ ok: false, code: "unknown" });
    }
  });
});
