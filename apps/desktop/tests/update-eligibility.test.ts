import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DESKTOP_UPDATE_PLATFORM_ACTIVATION,
  DESKTOP_UPDATE_SUPPORTED_PLATFORMS,
  isDesktopUpdateReleaseEligible,
  isOfficialDesktopRelease,
  type DesktopUpdatePlatform,
} from "../src/main/update-eligibility.js";

const appPath = "/Applications/Enduragent.app/Contents/Resources/app.asar";

function eligibility(
  overrides: Partial<Parameters<typeof isDesktopUpdateReleaseEligible>[0]> = {},
): boolean {
  return isDesktopUpdateReleaseEligible({
    isPackaged: true,
    platform: "darwin",
    securitySmokeMode: false,
    appPath,
    currentVersion: "0.1.0",
    readPackageJson: () => JSON.stringify({ version: "0.1.0", enduragentDesktopRelease: true }),
    ...overrides,
  });
}

function officialEligibility(
  overrides: Partial<Parameters<typeof isOfficialDesktopRelease>[0]> = {},
): boolean {
  return isOfficialDesktopRelease({
    isPackaged: true,
    platform: "darwin",
    securitySmokeMode: false,
    appPath,
    currentVersion: "0.1.0",
    readPackageJson: () => JSON.stringify({ version: "0.1.0", enduragentDesktopRelease: true }),
    ...overrides,
  });
}

describe("official desktop release eligibility", () => {
  it("accepts marked macOS and Windows packages independently of updater activation", () => {
    expect(officialEligibility({ platform: "darwin" })).toBe(true);
    expect(officialEligibility({ platform: "win32" })).toBe(true);
  });

  it.each([
    { isPackaged: false },
    { platform: "linux" as const },
    { securitySmokeMode: true },
    { currentVersion: "0.1.0-beta.1" },
  ])("rejects a non-release runtime: %o", (runtime) => {
    const readPackageJson = vi.fn(() => {
      throw new Error("must not read");
    });
    expect(officialEligibility({ ...runtime, readPackageJson })).toBe(false);
    expect(readPackageJson).not.toHaveBeenCalled();
  });

  it("requires the exact release marker and matching packaged version", () => {
    expect(
      officialEligibility({ readPackageJson: () => JSON.stringify({ version: "0.1.0" }) }),
    ).toBe(false);
    expect(
      officialEligibility({
        readPackageJson: () => JSON.stringify({ version: "0.1.1", enduragentDesktopRelease: true }),
      }),
    ).toBe(false);
  });
});

describe("desktop update release eligibility", () => {
  it("keeps Windows supported but inactive by default", () => {
    expect(DESKTOP_UPDATE_SUPPORTED_PLATFORMS).toEqual(["darwin", "win32"]);
    expect(DESKTOP_UPDATE_PLATFORM_ACTIVATION.win32).toBe(false);
    const readPackageJson = vi.fn(() => {
      throw new Error("must not read");
    });
    expect(eligibility({ platform: "win32", readPackageJson })).toBe(false);
    expect(readPackageJson).not.toHaveBeenCalled();
  });

  it("uses the Windows activation test seam without bypassing release metadata", () => {
    const platformActivation = { darwin: true, win32: true };
    expect(eligibility({ platform: "win32", platformActivation })).toBe(true);
    expect(
      eligibility({
        platform: "win32",
        platformActivation,
        readPackageJson: () => JSON.stringify({ version: "0.1.0" }),
      }),
    ).toBe(false);
  });

  it("leaves updates to the Microsoft Store for a Store package", () => {
    const platformActivation = { darwin: true, win32: true };
    const readPackageJson = vi.fn(() => {
      throw new Error("must not read");
    });
    expect(
      eligibility({
        platform: "win32",
        platformActivation,
        storeOwnsUpdates: true,
        readPackageJson,
      }),
    ).toBe(false);
    expect(readPackageJson).not.toHaveBeenCalled();
    expect(eligibility({ platform: "win32", platformActivation, storeOwnsUpdates: false })).toBe(
      true,
    );
    expect(eligibility({ platform: "win32", platformActivation })).toBe(true);
    Object.defineProperty(process, "windowsStore", { value: true, configurable: true });
    try {
      expect(eligibility({ platform: "win32", platformActivation })).toBe(false);
    } finally {
      Reflect.deleteProperty(process, "windowsStore");
    }
    expect(
      officialEligibility({
        platform: "win32",
        readPackageJson: () => JSON.stringify({ version: "0.1.0", enduragentDesktopRelease: true }),
      }),
    ).toBe(true);
  });

  it("rejects an unsupported platform even when activation claims it", () => {
    const platformActivation = { darwin: true, win32: false, linux: true } as unknown as Readonly<
      Record<DesktopUpdatePlatform, boolean>
    >;
    const readPackageJson = vi.fn(() => {
      throw new Error("must not read");
    });
    expect(eligibility({ platform: "linux", platformActivation, readPackageJson })).toBe(false);
    expect(readPackageJson).not.toHaveBeenCalled();
  });

  it("accepts only the marked packaged mac release with its exact stable version", () => {
    const readPackageJson = vi.fn(() => '{"version":"0.1.0","enduragentDesktopRelease":true}');
    expect(eligibility({ readPackageJson })).toBe(true);
    expect(readPackageJson).toHaveBeenCalledWith(join(appPath, "package.json"));
  });

  it.each([
    { isPackaged: false, platform: "darwin" as const, securitySmokeMode: false },
    { isPackaged: true, platform: "linux" as const, securitySmokeMode: false },
    { isPackaged: true, platform: "darwin" as const, securitySmokeMode: true },
  ])("does not inspect metadata in an ineligible runtime: %o", (runtime) => {
    const readPackageJson = vi.fn(() => {
      throw new Error("must not read");
    });
    expect(eligibility({ ...runtime, readPackageJson })).toBe(false);
    expect(readPackageJson).not.toHaveBeenCalled();
  });

  it.each([
    ["ordinary package", JSON.stringify({ version: "0.0.1" }), "0.0.1"],
    ["unmarked stable package", JSON.stringify({ version: "0.1.0" }), "0.1.0"],
    [
      "ordinary package with false marker",
      JSON.stringify({ version: "0.1.0", enduragentDesktopRelease: false }),
      "0.1.0",
    ],
    [
      "nested marker",
      JSON.stringify({
        version: "0.1.0",
        build: { enduragentDesktopRelease: true },
      }),
      "0.1.0",
    ],
    [
      "mismatched version",
      JSON.stringify({ version: "0.1.1", enduragentDesktopRelease: true }),
      "0.1.0",
    ],
    [
      "leading-zero minor",
      JSON.stringify({ version: "0.01.0", enduragentDesktopRelease: true }),
      "0.01.0",
    ],
    [
      "unsafe patch",
      JSON.stringify({
        version: "0.1.9007199254740992",
        enduragentDesktopRelease: true,
      }),
      "0.1.9007199254740992",
    ],
    [
      "prerelease",
      JSON.stringify({ version: "0.1.0-beta.1", enduragentDesktopRelease: true }),
      "0.1.0-beta.1",
    ],
  ])("rejects %s", (_case, raw, currentVersion) => {
    expect(eligibility({ currentVersion, readPackageJson: () => raw })).toBe(false);
  });

  it("fails closed when metadata is unreadable", () => {
    expect(
      eligibility({
        readPackageJson: () => {
          throw new Error("synthetic read failure");
        },
      }),
    ).toBe(false);
  });

  it.each([
    ["malformed", "not-json"],
    ["non-object", "null"],
    ["oversized", " ".repeat(64 * 1024 + 1)],
  ])("fails closed for %s metadata", (_case, raw) => {
    expect(eligibility({ readPackageJson: () => raw })).toBe(false);
  });
});
