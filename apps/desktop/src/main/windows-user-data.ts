import { desktopPhrasebook } from "./language.js";
import { desktopPlatformTokens } from "./platform-copy.js";
import { homedir } from "node:os";
import { win32 } from "node:path";
import type { App } from "electron";

export const WINDOWS_USER_DATA_DIRECTORY_NAME = "Enduragent" as const;

export type WindowsUserDataBindingStage = "resolve-local-app-data" | "set-user-data";

export class WindowsUserDataBindingError extends Error {
  override readonly name = "WindowsUserDataBindingError";
  readonly stage: WindowsUserDataBindingStage;

  constructor(stage: WindowsUserDataBindingStage) {
    super(
      desktopPhrasebook().say(
        "desktop.credentials.windowsUserDataFailed",
        desktopPlatformTokens("win32"),
      ),
    );
    this.stage = stage;
  }
}

export interface WindowsUserDataBindingDecisionInput {
  readonly platform: NodeJS.Platform;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: () => string;
}

export type WindowsUserDataBindingDecision =
  | Readonly<{ kind: "no-op" }>
  | Readonly<{
      kind: "bind";
      path: string;
      source: "local-app-data-environment" | "home-directory-fallback";
    }>;

export type WindowsUserDataAppPort = Pick<App, "setPath">;

export interface BindWindowsUserDataOptions {
  readonly platform?: NodeJS.Platform;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory?: () => string;
}

function absoluteWindowsPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    !value.includes("\0") &&
    win32.isAbsolute(value)
  );
}

function resolutionFailure(): WindowsUserDataBindingError {
  return new WindowsUserDataBindingError("resolve-local-app-data");
}

export function decideWindowsUserDataBinding(
  input: WindowsUserDataBindingDecisionInput,
): WindowsUserDataBindingDecision {
  if (input.platform !== "win32") return Object.freeze({ kind: "no-op" });

  const environmentRoot = input.environment.LOCALAPPDATA;
  if (absoluteWindowsPath(environmentRoot)) {
    return Object.freeze({
      kind: "bind",
      path: win32.join(environmentRoot, WINDOWS_USER_DATA_DIRECTORY_NAME),
      source: "local-app-data-environment",
    });
  }

  let homeDirectory: string;
  try {
    homeDirectory = input.homeDirectory();
  } catch {
    throw resolutionFailure();
  }
  if (!absoluteWindowsPath(homeDirectory)) throw resolutionFailure();

  return Object.freeze({
    kind: "bind",
    path: win32.join(homeDirectory, "AppData", "Local", WINDOWS_USER_DATA_DIRECTORY_NAME),
    source: "home-directory-fallback",
  });
}

export function bindWindowsUserData(
  app: WindowsUserDataAppPort,
  options: BindWindowsUserDataOptions = {},
): WindowsUserDataBindingDecision {
  const decision = decideWindowsUserDataBinding({
    platform: options.platform ?? process.platform,
    environment: options.environment ?? process.env,
    homeDirectory: options.homeDirectory ?? homedir,
  });
  if (decision.kind === "no-op") return decision;
  try {
    app.setPath("userData", decision.path);
  } catch {
    throw new WindowsUserDataBindingError("set-user-data");
  }
  return decision;
}
