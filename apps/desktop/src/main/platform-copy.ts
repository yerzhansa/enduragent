import type { Phrasebook } from "@enduragent/i18n/messages";
import englishCatalog from "../../../../packages/i18n/catalogs/en.json" with { type: "json" };

export interface DesktopPlatformProjection {
  readonly platform: "darwin" | "win32";
  readonly capabilities: { readonly codexAgent: boolean };
  readonly copy: {
    readonly computer: string;
    readonly operatingSystem: "macOS" | "Windows";
    readonly credentialEncryptionUnavailable: string;
    readonly credentialRecoveryAction: string;
    readonly restartComputer: string;
    readonly rideImportDescription: string;
  };
}

export function desktopPlatformTokens(platform: NodeJS.Platform = process.platform) {
  return {
    product: "Enduragent",
    operatingSystem: platform === "win32" ? "Windows" : "macOS",
  } as const;
}

export function desktopPlatformProjection(
  platform: NodeJS.Platform = process.platform,
  phrasebook?: Phrasebook,
): DesktopPlatformProjection {
  const windows = platform === "win32";
  const tokens = desktopPlatformTokens(platform);
  const english = englishCatalog.desktop;
  const computer = windows
    ? (phrasebook?.say("desktop.platform.computerPc") ?? english.platform.computerPc)
    : (phrasebook?.say("desktop.platform.computerMac") ?? english.platform.computerMac);
  const platformEnglish = (text: string): string =>
    text
      .replaceAll("{{operatingSystem}}", tokens.operatingSystem)
      .replaceAll("{{product}}", tokens.product);
  return Object.freeze({
    platform: windows ? "win32" : "darwin",
    capabilities: Object.freeze({ codexAgent: !windows }),
    copy: Object.freeze({
      computer,
      operatingSystem: tokens.operatingSystem,
      credentialEncryptionUnavailable: windows
        ? (phrasebook?.say("desktop.credentials.windowsUnavailable", tokens) ??
          platformEnglish(english.credentials.windowsUnavailable))
        : (phrasebook?.say("desktop.credentials.macUnavailable", tokens) ??
          platformEnglish(english.credentials.macUnavailable)),
      credentialRecoveryAction: windows
        ? (phrasebook?.say("desktop.credentials.windowsRecovery", tokens) ??
          platformEnglish(english.credentials.windowsRecovery))
        : (phrasebook?.say("desktop.credentials.macRecovery") ?? english.credentials.macRecovery),
      restartComputer: windows
        ? (phrasebook?.say("desktop.platform.restartPc") ?? english.platform.restartPc)
        : (phrasebook?.say("desktop.platform.restartMac") ?? english.platform.restartMac),
      rideImportDescription:
        phrasebook?.say("desktop.filePicker.rideImportDescription", {
          computer,
        }) ?? english.filePicker.rideImportDescription.replaceAll("{{computer}}", computer),
    }),
  });
}
