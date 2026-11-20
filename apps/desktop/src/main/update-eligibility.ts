import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isStableDesktopVersion } from "./desktop-version.js";

const PACKAGE_JSON_LIMIT = 64 * 1024;

export const DESKTOP_UPDATE_SUPPORTED_PLATFORMS = Object.freeze(["darwin", "win32"] as const);
export type DesktopUpdatePlatform = (typeof DESKTOP_UPDATE_SUPPORTED_PLATFORMS)[number];
export const DESKTOP_UPDATE_PLATFORM_ACTIVATION: Readonly<Record<DesktopUpdatePlatform, boolean>> =
  Object.freeze({ darwin: true, win32: false });

interface OfficialDesktopReleaseInput {
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly securitySmokeMode: boolean;
  readonly appPath: string;
  readonly currentVersion: string;
  readonly readPackageJson?: (path: string) => string;
}

export function isOfficialDesktopRelease(input: OfficialDesktopReleaseInput): boolean {
  if (
    !input.isPackaged ||
    !DESKTOP_UPDATE_SUPPORTED_PLATFORMS.includes(input.platform as DesktopUpdatePlatform) ||
    input.securitySmokeMode ||
    !isStableDesktopVersion(input.currentVersion)
  ) {
    return false;
  }
  try {
    const raw = (input.readPackageJson ?? ((path) => readFileSync(path, "utf8")))(
      join(input.appPath, "package.json"),
    );
    if (raw.length > PACKAGE_JSON_LIMIT) return false;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const metadata = parsed as Record<string, unknown>;
    return (
      Object.hasOwn(metadata, "enduragentDesktopRelease") &&
      metadata.enduragentDesktopRelease === true &&
      Object.hasOwn(metadata, "version") &&
      metadata.version === input.currentVersion &&
      isStableDesktopVersion(metadata.version)
    );
  } catch {
    return false;
  }
}

export function isDesktopUpdateReleaseEligible(
  input: OfficialDesktopReleaseInput & {
    readonly platformActivation?: Readonly<Record<DesktopUpdatePlatform, boolean>>;
    readonly storeOwnsUpdates?: boolean;
  },
): boolean {
  if (input.storeOwnsUpdates ?? process.windowsStore === true) return false;
  const platformActivation = input.platformActivation ?? DESKTOP_UPDATE_PLATFORM_ACTIVATION;
  if (
    !DESKTOP_UPDATE_SUPPORTED_PLATFORMS.includes(input.platform as DesktopUpdatePlatform) ||
    platformActivation[input.platform as DesktopUpdatePlatform] !== true
  ) {
    return false;
  }
  return isOfficialDesktopRelease(input);
}
