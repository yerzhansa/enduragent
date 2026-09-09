import { createPhrasebook } from "@enduragent/i18n/messages";
import { describe, expect, it } from "vitest";
import {
  platformCredentialEncryptionUnavailable,
  platformCredentialRecoveryAction,
  rendererPlatformProjection,
  type DesktopPlatformProjection,
} from "../src/platform-copy";

describe("platform messages", () => {
  it("preserves macOS and Windows credential instructions", async () => {
    const { say } = await createPhrasebook({ tag: "en", locale: "en-US" });
    const mac = rendererPlatformProjection();
    expect(say(platformCredentialEncryptionUnavailable(mac))).toBe(
      "macOS encryption is unavailable. Make sure Keychain is available, then try again.",
    );
    expect(say(platformCredentialRecoveryAction(mac))).toBe("unlock your login keychain");
    const windows: DesktopPlatformProjection = {
      ...mac,
      platform: "win32",
      copy: { ...mac.copy, computer: "this PC", operatingSystem: "Windows" },
    };
    expect(say(platformCredentialEncryptionUnavailable(windows))).toBe(
      "Windows credential encryption (DPAPI) is unavailable. Quit and reopen Enduragent, then try again.",
    );
    expect(say(platformCredentialRecoveryAction(windows))).toBe(
      "make sure Windows credential encryption (DPAPI) is available",
    );
  });
});
