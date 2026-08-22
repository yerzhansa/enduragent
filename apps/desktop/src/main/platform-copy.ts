export interface DesktopPlatformProjection {
  readonly platform: "darwin" | "win32";
  readonly capabilities: {
    readonly codexAgent: boolean;
  };
  readonly copy: {
    readonly computer: "this Mac" | "this PC";
    readonly operatingSystem: "macOS" | "Windows";
    readonly credentialEncryptionUnavailable: string;
    readonly credentialRecoveryAction: string;
    readonly restartComputer: "restart your Mac" | "restart your PC";
    readonly rideImportDescription: string;
  };
}

const DARWIN_PLATFORM_PROJECTION: DesktopPlatformProjection = Object.freeze({
  platform: "darwin",
  capabilities: Object.freeze({ codexAgent: true }),
  copy: Object.freeze({
    computer: "this Mac",
    operatingSystem: "macOS",
    credentialEncryptionUnavailable:
      "macOS encryption is unavailable. Make sure Keychain is available, then try again.",
    credentialRecoveryAction: "unlock your login keychain",
    restartComputer: "restart your Mac",
    rideImportDescription:
      "Add FIT, TCX or GPX files from this Mac. You can also drop them onto the window.",
  }),
});

const WINDOWS_PLATFORM_PROJECTION: DesktopPlatformProjection = Object.freeze({
  platform: "win32",
  capabilities: Object.freeze({ codexAgent: false }),
  copy: Object.freeze({
    computer: "this PC",
    operatingSystem: "Windows",
    credentialEncryptionUnavailable:
      "Windows credential encryption (DPAPI) is unavailable. Quit and reopen Enduragent, then try again.",
    credentialRecoveryAction: "make sure Windows credential encryption (DPAPI) is available",
    restartComputer: "restart your PC",
    rideImportDescription:
      "Add FIT, TCX or GPX files from this PC. You can also drop them onto the window.",
  }),
});

export function desktopPlatformProjection(
  platform: NodeJS.Platform = process.platform,
): DesktopPlatformProjection {
  return platform === "win32" ? WINDOWS_PLATFORM_PROJECTION : DARWIN_PLATFORM_PROJECTION;
}
