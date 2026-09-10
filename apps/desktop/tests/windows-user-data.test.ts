import { initializeDesktopLanguage } from "../src/main/language.js";
import { win32 } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  WindowsUserDataBindingError,
  bindWindowsUserData,
  decideWindowsUserDataBinding,
  type WindowsUserDataBindingDecision,
} from "../src/main/windows-user-data.js";

const homeDirectory = String.raw`C:\Users\Athlete`;
const localAppData = win32.join(homeDirectory, "AppData", "Local");
const expectedUserData = win32.join(localAppData, "Enduragent");

function boundPath(decision: WindowsUserDataBindingDecision): string {
  expect(decision.kind).toBe("bind");
  if (decision.kind !== "bind") throw new TypeError("expected Windows user data binding");
  return decision.path;
}

function captureFailure(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new TypeError("expected Windows user data binding failure");
}

await initializeDesktopLanguage();

describe("Windows user data binding decision", () => {
  it("uses LOCALAPPDATA as the primary Windows location", () => {
    const resolveHome = vi.fn(() => homeDirectory);

    expect(
      decideWindowsUserDataBinding({
        platform: "win32",
        environment: { LOCALAPPDATA: localAppData },
        homeDirectory: resolveHome,
      }),
    ).toEqual({
      kind: "bind",
      path: expectedUserData,
      source: "local-app-data-environment",
    });
    expect(resolveHome).not.toHaveBeenCalled();
  });

  it("falls back to the home AppData Local directory when the environment is absent", () => {
    const resolveHome = vi.fn(() => homeDirectory);

    expect(
      decideWindowsUserDataBinding({
        platform: "win32",
        environment: {},
        homeDirectory: resolveHome,
      }),
    ).toEqual({
      kind: "bind",
      path: expectedUserData,
      source: "home-directory-fallback",
    });
    expect(resolveHome).toHaveBeenCalledOnce();
  });

  it("fails closed with a path-free resolution stage when no local path can be resolved", () => {
    const sensitivePath = String.raw`C:\Users\Private Athlete\AppData\Roaming`;
    const sensitiveMarker = "Private Athlete";
    const failure = captureFailure(() =>
      decideWindowsUserDataBinding({
        platform: "win32",
        environment: {},
        homeDirectory: () => {
          throw new TypeError(`cannot resolve ${sensitivePath}`);
        },
      }),
    );

    expect(failure).toBeInstanceOf(WindowsUserDataBindingError);
    expect(failure).toMatchObject({
      name: "WindowsUserDataBindingError",
      message: "Windows user data binding failed",
      stage: "resolve-local-app-data",
    });
    expect(failure).not.toHaveProperty("path");
    expect(failure).not.toHaveProperty("cause");
    expect(String(failure)).not.toContain(sensitivePath);
    expect(JSON.stringify(failure)).not.toContain(sensitiveMarker);
  });

  it.each(["", String.raw`relative\home`, ` ${homeDirectory} `, `${homeDirectory}\0`])(
    "fails closed when the fallback home path is unusable: %j",
    (unusableHome) => {
      const failure = captureFailure(() =>
        decideWindowsUserDataBinding({
          platform: "win32",
          environment: {},
          homeDirectory: () => unusableHome,
        }),
      );

      expect(failure).toBeInstanceOf(WindowsUserDataBindingError);
      expect(failure).toMatchObject({
        name: "WindowsUserDataBindingError",
        message: "Windows user data binding failed",
        stage: "resolve-local-app-data",
      });
    },
  );

  it.each(["darwin", "linux"] as const)("is a no-op on %s", (platform) => {
    const resolveHome = vi.fn(() => homeDirectory);

    expect(
      decideWindowsUserDataBinding({
        platform,
        environment: { LOCALAPPDATA: localAppData },
        homeDirectory: resolveHome,
      }),
    ).toEqual({ kind: "no-op" });
    expect(resolveHome).not.toHaveBeenCalled();
  });

  it("keeps the environment and fallback paths under AppData Local and outside Roaming", () => {
    const decisions = [
      decideWindowsUserDataBinding({
        platform: "win32",
        environment: { LOCALAPPDATA: localAppData },
        homeDirectory: () => homeDirectory,
      }),
      decideWindowsUserDataBinding({
        platform: "win32",
        environment: {},
        homeDirectory: () => homeDirectory,
      }),
    ];

    for (const decision of decisions) {
      const segments = boundPath(decision).toLowerCase().split(win32.sep);
      const appDataIndex = segments.indexOf("appdata");
      expect(segments.slice(appDataIndex, appDataIndex + 2)).toEqual(["appdata", "local"]);
      expect(segments).not.toContain("roaming");
    }
  });
});

describe("Windows user data binding", () => {
  it("sets userData exactly once to the decided Windows path", () => {
    const setPath = vi.fn();

    expect(
      bindWindowsUserData({ setPath } as never, {
        platform: "win32",
        environment: { LOCALAPPDATA: localAppData },
        homeDirectory: () => homeDirectory,
      }),
    ).toEqual({
      kind: "bind",
      path: expectedUserData,
      source: "local-app-data-environment",
    });
    expect(setPath).toHaveBeenCalledOnce();
    expect(setPath).toHaveBeenCalledWith("userData", expectedUserData);
  });

  it("reports only the set-user-data stage when Electron rejects the path", () => {
    const sensitiveDetail = "private setPath failure";
    const setPath = vi.fn(() => {
      throw new TypeError(sensitiveDetail);
    });
    const failure = captureFailure(() =>
      bindWindowsUserData({ setPath } as never, {
        platform: "win32",
        environment: { LOCALAPPDATA: localAppData },
        homeDirectory: () => homeDirectory,
      }),
    );

    expect(setPath).toHaveBeenCalledOnce();
    expect(setPath).toHaveBeenCalledWith("userData", expectedUserData);
    expect(failure).toBeInstanceOf(WindowsUserDataBindingError);
    expect(failure).toMatchObject({
      name: "WindowsUserDataBindingError",
      message: "Windows user data binding failed",
      stage: "set-user-data",
    });
    expect(failure).not.toHaveProperty("path");
    expect(failure).not.toHaveProperty("cause");
    expect(String(failure)).not.toContain(sensitiveDetail);
    expect(JSON.stringify(failure)).not.toContain(sensitiveDetail);
  });

  it("returns the no-op decision on macOS without setting userData", () => {
    const setPath = vi.fn();
    const resolveHome = vi.fn(() => homeDirectory);

    expect(
      bindWindowsUserData({ setPath } as never, {
        platform: "darwin",
        environment: { LOCALAPPDATA: localAppData },
        homeDirectory: resolveHome,
      }),
    ).toEqual({ kind: "no-op" });
    expect(setPath).not.toHaveBeenCalled();
    expect(resolveHome).not.toHaveBeenCalled();
  });
});
