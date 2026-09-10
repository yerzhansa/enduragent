import { desktopPhrasebook } from "./language.js";
import { desktopPlatformTokens } from "./platform-copy.js";
import type { App } from "electron";
import { DESKTOP_APP_USER_MODEL_ID } from "./constants.js";

export type DesktopIdentityAppPort = Pick<App, "setAppUserModelId">;

export class DesktopIdentityBindingError extends Error {
  override readonly name = "DesktopIdentityBindingError";
  readonly stage = "set-app-user-model-id" as const;

  constructor() {
    super(
      desktopPhrasebook().say(
        "desktop.credentials.windowsIdentityFailed",
        desktopPlatformTokens("win32"),
      ),
    );
  }
}

export function bindDesktopAppUserModelId(
  app: DesktopIdentityAppPort,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "win32") return;
  try {
    app.setAppUserModelId(DESKTOP_APP_USER_MODEL_ID);
  } catch {
    throw new DesktopIdentityBindingError();
  }
}

export interface DesktopActivationTarget {
  showMainWindow(): Promise<unknown>;
}

export interface DesktopActivationRelay {
  request(): void;
  bind(target: DesktopActivationTarget): Promise<void>;
  unbind(target: DesktopActivationTarget): void;
}

export function createDesktopActivationRelay(
  platform: NodeJS.Platform = process.platform,
): DesktopActivationRelay {
  let target: DesktopActivationTarget | undefined;
  let pendingWindowsActivation = false;
  return {
    request() {
      if (target !== undefined) {
        void target.showMainWindow();
      } else if (platform === "win32") {
        pendingWindowsActivation = true;
      }
    },
    async bind(next) {
      target = next;
      if (platform !== "win32" || !pendingWindowsActivation) return;
      pendingWindowsActivation = false;
      await next.showMainWindow();
    },
    unbind(current) {
      if (target === current) target = undefined;
    },
  };
}
