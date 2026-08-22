import { describe, expect, it } from "vitest";
import { desktopPlatformProjection } from "../src/main/platform-copy.js";
import { startupRefusalCopy } from "../src/main/lifecycle-messages.js";

describe("desktop platform projection", () => {
  it("keeps the Darwin capability and rendered copy byte-identical", () => {
    expect(desktopPlatformProjection("darwin")).toEqual({
      platform: "darwin",
      capabilities: { codexAgent: true },
      copy: {
        computer: "this Mac",
        operatingSystem: "macOS",
        credentialEncryptionUnavailable:
          "macOS encryption is unavailable. Make sure Keychain is available, then try again.",
        credentialRecoveryAction: "unlock your login keychain",
        restartComputer: "restart your Mac",
        rideImportDescription:
          "Add FIT, TCX or GPX files from this Mac. You can also drop them onto the window.",
      },
    });
  });

  it("projects Windows capability and path-free DPAPI-backed wording", () => {
    const projection = desktopPlatformProjection("win32");

    expect(projection).toEqual({
      platform: "win32",
      capabilities: { codexAgent: false },
      copy: {
        computer: "this PC",
        operatingSystem: "Windows",
        credentialEncryptionUnavailable:
          "Windows credential encryption (DPAPI) is unavailable. Quit and reopen Enduragent, then try again.",
        credentialRecoveryAction: "make sure Windows credential encryption (DPAPI) is available",
        restartComputer: "restart your PC",
        rideImportDescription:
          "Add FIT, TCX or GPX files from this PC. You can also drop them onto the window.",
      },
    });
    expect(JSON.stringify(projection)).not.toMatch(/[\\/](?:Users|home|tmp)[\\/]/u);
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.capabilities)).toBe(true);
    expect(Object.isFrozen(projection.copy)).toBe(true);
  });

  it("retains legacy non-Windows copy and changes only the Windows restart noun", () => {
    expect(startupRefusalCopy("unavailable", "darwin").content).toBe(
      "The background service could not start or its saved connection state could not be read. Quit Enduragent and reopen it. If the problem continues, restart your Mac before trying again.",
    );
    expect(startupRefusalCopy("unavailable", "win32").content).toBe(
      "The background service could not start or its saved connection state could not be read. Quit Enduragent and reopen it. If the problem continues, restart your PC before trying again.",
    );
  });
});
