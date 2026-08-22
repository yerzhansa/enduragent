import { describe, expect, it, vi } from "vitest";
import { KEYCHAIN_BINDING_ASAR_PATH } from "../scripts/package-inventory.mjs";
import {
  BACKEND_SELECTION_BACKEND,
  BACKEND_SELECTION_OUTPUT_PREFIX,
  BACKEND_SELECTION_SERVICE,
  BACKEND_SELECTION_TEAM_IDENTIFIER,
  verifyMacosBackendSelection,
} from "../scripts/verify-macos-backend-selection.mjs";

const application = "/synthetic/Enduragent.app";
const binding = `${application}/Contents/Resources/app.asar.unpacked/${KEYCHAIN_BINDING_ASAR_PATH}`;
const signature: Readonly<{
  teamIdentifier: string;
  designatedRequirement: string;
}> = Object.freeze({
  teamIdentifier: BACKEND_SELECTION_TEAM_IDENTIFIER,
  designatedRequirement: 'identifier "keychain-binding" and anchor apple generic',
});

function dependencies() {
  return {
    requireBinding: vi.fn(async () => {}),
    verifyKeychainBinding: vi.fn(async () => signature),
    runApplication: vi.fn(async () => ({
      code: 0,
      signal: null,
      stdout: `${BACKEND_SELECTION_OUTPUT_PREFIX}${JSON.stringify({
        backend: BACKEND_SELECTION_BACKEND,
        teamIdentifier: BACKEND_SELECTION_TEAM_IDENTIFIER,
      })}\n`,
      stderr: "",
    })),
    mkdtemp: vi.fn(async () => "/synthetic/probe-data"),
    rm: vi.fn(async () => {}),
  };
}

describe("macOS backend selection verification", () => {
  it("verifies the nested binding before probing through the signed application", async () => {
    const injected = dependencies();
    await expect(verifyMacosBackendSelection(application, injected)).resolves.toEqual({
      binding,
      service: BACKEND_SELECTION_SERVICE,
      backend: BACKEND_SELECTION_BACKEND,
      teamIdentifier: BACKEND_SELECTION_TEAM_IDENTIFIER,
      designatedRequirement: signature.designatedRequirement,
    });
    expect(injected.requireBinding).toHaveBeenCalledWith(binding);
    expect(injected.verifyKeychainBinding).toHaveBeenCalledWith(application);
    expect(injected.runApplication).toHaveBeenCalledWith(
      `${application}/Contents/MacOS/Enduragent`,
      "/synthetic/probe-data",
    );
    expect(injected.verifyKeychainBinding.mock.invocationCallOrder[0]).toBeLessThan(
      injected.runApplication.mock.invocationCallOrder[0]!,
    );
    expect(injected.rm).toHaveBeenCalledWith("/synthetic/probe-data", {
      recursive: true,
      force: true,
    });
  });

  it("never launches an unverified or foreign-team binding", async () => {
    const missingBinding = dependencies();
    missingBinding.requireBinding.mockRejectedValueOnce(new Error("missing binding"));
    await expect(verifyMacosBackendSelection(application, missingBinding)).rejects.toThrow(
      "missing binding",
    );
    expect(missingBinding.verifyKeychainBinding).not.toHaveBeenCalled();
    expect(missingBinding.runApplication).not.toHaveBeenCalled();

    const invalidSignature = dependencies();
    invalidSignature.verifyKeychainBinding.mockRejectedValueOnce(new Error("invalid signature"));
    await expect(verifyMacosBackendSelection(application, invalidSignature)).rejects.toThrow(
      "invalid signature",
    );
    expect(invalidSignature.runApplication).not.toHaveBeenCalled();

    const foreign = dependencies();
    foreign.verifyKeychainBinding.mockResolvedValueOnce({
      ...signature,
      teamIdentifier: "ZZZZZZZZZZ",
    });
    await expect(verifyMacosBackendSelection(application, foreign)).rejects.toThrow(
      "bundled keychain binding signing identity is invalid",
    );
    expect(foreign.runApplication).not.toHaveBeenCalled();
  });

  it.each([
    { code: 1, signal: null, stdout: "", stderr: "refused" },
    { code: 0, signal: null, stdout: "malformed\n", stderr: "" },
    {
      code: 0,
      signal: null,
      stdout: `${BACKEND_SELECTION_OUTPUT_PREFIX}${JSON.stringify({
        backend: BACKEND_SELECTION_BACKEND,
        teamIdentifier: "OTHER",
      })}\n`,
      stderr: "",
    },
    {
      code: 0,
      signal: null,
      stdout: `${BACKEND_SELECTION_OUTPUT_PREFIX}${JSON.stringify({
        backend: "safe_storage",
        teamIdentifier: BACKEND_SELECTION_TEAM_IDENTIFIER,
      })}\n`,
      stderr: "",
    },
    {
      code: 0,
      signal: null,
      stdout: `${BACKEND_SELECTION_OUTPUT_PREFIX}${JSON.stringify({
        backend: BACKEND_SELECTION_BACKEND,
        teamIdentifier: BACKEND_SELECTION_TEAM_IDENTIFIER,
        extra: true,
      })}\n`,
      stderr: "",
    },
    {
      code: 0,
      signal: null,
      stdout: `${BACKEND_SELECTION_OUTPUT_PREFIX}${JSON.stringify({
        teamIdentifier: BACKEND_SELECTION_TEAM_IDENTIFIER,
      })}\n`,
      stderr: "",
    },
    {
      code: 0,
      signal: null,
      stdout: `${BACKEND_SELECTION_OUTPUT_PREFIX}${JSON.stringify({
        backend: BACKEND_SELECTION_BACKEND,
      })}\n`,
      stderr: "",
    },
    {
      code: 0,
      signal: null,
      stdout: `${BACKEND_SELECTION_OUTPUT_PREFIX}${JSON.stringify({
        teamIdentifier: BACKEND_SELECTION_TEAM_IDENTIFIER,
        backend: BACKEND_SELECTION_BACKEND,
      })}\n`,
      stderr: "",
    },
  ])("rejects a failed or malformed signed-app probe", async (answer) => {
    const injected = dependencies();
    injected.runApplication.mockResolvedValueOnce(answer);
    await expect(verifyMacosBackendSelection(application, injected)).rejects.toThrow(
      /signed application keychain binding probe/u,
    );
    expect(injected.rm).toHaveBeenCalledOnce();
  });

  it("rejects a relative app before inspecting files", async () => {
    const injected = dependencies();
    await expect(verifyMacosBackendSelection("relative.app", injected)).rejects.toThrow(
      "application path must be absolute",
    );
    expect(injected.requireBinding).not.toHaveBeenCalled();
  });
});
