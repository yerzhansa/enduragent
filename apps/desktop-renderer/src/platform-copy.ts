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

const DARWIN_FALLBACK: DesktopPlatformProjection = Object.freeze({
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

export function rendererPlatformProjection(
  projection?: DesktopPlatformProjection,
): DesktopPlatformProjection {
  if (projection !== undefined) return projection;
  if (typeof window === "undefined") return DARWIN_FALLBACK;
  return (
    (
      window as unknown as {
        readonly enduragentAuth?: { readonly platform?: DesktopPlatformProjection };
      }
    ).enduragentAuth?.platform ?? DARWIN_FALLBACK
  );
}

export const PLATFORM_COPY = rendererPlatformProjection().copy;
