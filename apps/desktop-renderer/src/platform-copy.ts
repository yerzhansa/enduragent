import { msg, type Message } from "@enduragent/i18n";

export interface DesktopPlatformProjection {
  readonly platform: "darwin" | "win32";
  readonly firstDayOfWeek: 1 | 2 | 3 | 4 | 5 | 6 | 7;
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
  firstDayOfWeek: 1,
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
  const auth: { readonly platform?: DesktopPlatformProjection } | undefined = window.enduragentAuth;
  return auth?.platform ?? DARWIN_FALLBACK;
}

export const PLATFORM_COPY = rendererPlatformProjection().copy;

export function platformCredentialEncryptionUnavailable(
  projection: DesktopPlatformProjection = rendererPlatformProjection(),
): Message {
  return projection.platform === "win32"
    ? msg("shell.platform.credentialEncryptionUnavailable.windows", {
        operatingSystem: projection.copy.operatingSystem,
        encryption: "DPAPI",
        product: "Enduragent",
      })
    : msg("shell.platform.credentialEncryptionUnavailable.mac", {
        operatingSystem: projection.copy.operatingSystem,
        keychain: "Keychain",
      });
}

export function platformCredentialRecoveryAction(
  projection: DesktopPlatformProjection = rendererPlatformProjection(),
): Message {
  return projection.platform === "win32"
    ? msg("shell.platform.credentialRecoveryAction.windows", {
        operatingSystem: projection.copy.operatingSystem,
        encryption: "DPAPI",
      })
    : msg("shell.platform.credentialRecoveryAction.mac");
}
