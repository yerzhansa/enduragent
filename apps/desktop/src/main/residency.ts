import { desktopPlatformTokens } from "./platform-copy.js";
import { desktopPhrasebook, refreshDesktopLanguage } from "./language.js";
import { resolve } from "node:path";
import {
  Menu,
  Tray,
  nativeImage,
  type App,
  type BrowserWindow,
  type IpcMain,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from "electron";
import { DESKTOP_OPEN_SETTINGS_CHANNEL } from "./constants.js";
import { installStartAtLoginIpc } from "./start-at-login-ipc.js";
import {
  isLoginItemResidencyEnabled,
  loginItemResidencyMatchesRequest,
  readLoginItemResidency,
  setLoginItemResidency,
  type BackgroundAtLoginPreferenceWriteResult,
  type LoginItemResidencyState,
} from "./login-item.js";

export const TRAY_TOOLTIP = "Enduragent" as const;
export const TRAY_POPOVER_WIDTH = 420 as const;
export const TRAY_POPOVER_HEIGHT = 246 as const;
export const TRAY_POPOVER_GAP = 6 as const;
export const TRAY_POPOVER_EDGE_INSET = 8 as const;

export interface MainWindowResidencyPort {
  current(): BrowserWindow | null;
  show(): Promise<BrowserWindow>;
}

export type DesktopResidencyEvent =
  | { readonly type: "tray-created" }
  | { readonly type: "tray-destroyed" }
  | { readonly type: "main-window-shown" }
  | { readonly type: "login-item-read"; readonly state: LoginItemResidencyState }
  | { readonly type: "login-item-set"; readonly state: LoginItemResidencyState };

export function desktopTrayIconPath(mainDirectory: string, platform: NodeJS.Platform): string {
  return resolve(
    mainDirectory,
    platform === "win32" ? "../../resources/tray.ico" : "../../resources/trayTemplate.png",
  );
}

export interface DesktopResidencyInput {
  readonly app: App;
  readonly ipcMain?: Pick<IpcMain, "handle" | "removeHandler">;
  readonly isTrusted?: (event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">) => boolean;
  readonly mainWindow: MainWindowResidencyPort;
  readonly trayIconPath: string;
  readonly platform?: NodeJS.Platform;
  readonly loginItemExecutablePath?: string;
  readonly loginItemAvailable?: boolean;
  readonly persistLoginPreference: (
    enabled: boolean,
  ) => Promise<BackgroundAtLoginPreferenceWriteResult>;
  readonly reportFailure: (
    operation: "read-login-item" | "set-login-item" | "show-window" | "tray-start",
  ) => void;
  readonly observe?: (event: DesktopResidencyEvent) => void;
}

export type StartAtLoginState =
  | { readonly kind: "unavailable" }
  | { readonly kind: "known"; readonly enabled: boolean };

export interface DesktopResidency {
  start(): Promise<void>;
  startAtLogin(): StartAtLoginState;
  setStartAtLogin(enabled: boolean): Promise<StartAtLoginState>;
  showMainWindow(): Promise<void>;
  manageMainWindow(window: BrowserWindow): void;
  quit(): void;
  close(): Promise<void>;
}

function durablePreferenceAfterCompensation(
  compensation: BackgroundAtLoginPreferenceWriteResult,
  requested: boolean,
): boolean | undefined {
  if (compensation.status === "stored") return compensation.enabled;
  if (compensation.status === "refused") return requested;
  return undefined;
}

export function createDesktopResidency(input: DesktopResidencyInput): DesktopResidency {
  const platform = input.platform ?? process.platform;
  const loginItemAvailable = input.loginItemAvailable ?? process.windowsStore !== true;
  let tray: Tray | undefined;
  let startPromise: Promise<void> | undefined;
  let quitRequested = false;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let loginItemMutation: Promise<void> = Promise.resolve();
  const managedWindows = new WeakSet<BrowserWindow>();

  const manageMainWindow = (window: BrowserWindow): void => {
    if (platform !== "win32" || managedWindows.has(window)) return;
    managedWindows.add(window);
    window.on("close", (event) => {
      if (closed || quitRequested) return;
      event.preventDefault();
      window.hide();
    });
  };
  const showMainWindow = async (view: "current" | "settings" = "current"): Promise<void> => {
    if (closed) return;
    try {
      const window = await input.mainWindow.show();
      if (closed) return;
      manageMainWindow(window);
      if (view === "settings") window.webContents.send(DESKTOP_OPEN_SETTINGS_CHANNEL);
      input.observe?.({ type: "main-window-shown" });
    } catch {
      if (!closed) input.reportFailure("show-window");
    }
  };
  const readLoginState = (): LoginItemResidencyState | undefined => {
    try {
      const state = readLoginItemResidency(input.app, {
        platform,
        executablePath: input.loginItemExecutablePath,
      });
      input.observe?.({ type: "login-item-read", state });
      return state;
    } catch {
      input.reportFailure("read-login-item");
      return undefined;
    }
  };
  const applyLoginState = (openAtLogin: boolean): LoginItemResidencyState | undefined => {
    try {
      const state = setLoginItemResidency(input.app, openAtLogin, {
        platform,
        executablePath: input.loginItemExecutablePath,
      });
      return loginItemResidencyMatchesRequest(state, openAtLogin, platform) ? state : undefined;
    } catch {
      return undefined;
    }
  };
  const observeConvergedLoginState = (state: LoginItemResidencyState): boolean => {
    try {
      input.observe?.({ type: "login-item-set", state });
      return true;
    } catch {
      return false;
    }
  };
  const persistCompensation = async (
    enabled: boolean,
  ): Promise<BackgroundAtLoginPreferenceWriteResult> => {
    try {
      return await input.persistLoginPreference(enabled);
    } catch {
      return { status: "uncertain" };
    }
  };
  const setLoginState = (openAtLogin: boolean): void => {
    if (closed) return;
    const mutation = loginItemMutation.then(async () => {
      const previous = readLoginState();
      if (previous === undefined) return;
      const previousEnabled = isLoginItemResidencyEnabled(previous, platform);
      let stored: BackgroundAtLoginPreferenceWriteResult;
      try {
        stored = await input.persistLoginPreference(openAtLogin);
      } catch {
        input.reportFailure("set-login-item");
        return;
      }
      if (stored.status !== "stored" || stored.enabled !== openAtLogin) {
        input.reportFailure("set-login-item");
        return;
      }
      const applied = applyLoginState(openAtLogin);
      if (applied !== undefined) {
        input.observe?.({ type: "login-item-set", state: applied });
        return;
      }
      const convergenceTarget = durablePreferenceAfterCompensation(
        await persistCompensation(previousEnabled),
        openAtLogin,
      );
      const converged =
        convergenceTarget === undefined ? undefined : applyLoginState(convergenceTarget);
      if (converged === undefined || !observeConvergedLoginState(converged)) readLoginState();
      input.reportFailure("set-login-item");
    });
    loginItemMutation = Promise.allSettled([mutation]).then(() => undefined);
  };
  const startAtLogin = (): StartAtLoginState => {
    if (!loginItemAvailable || closed) return { kind: "unavailable" };
    const state = readLoginState();
    return state === undefined
      ? { kind: "unavailable" }
      : { kind: "known", enabled: isLoginItemResidencyEnabled(state, platform) };
  };
  const startAtLoginItem = (): MenuItemConstructorOptions[] => {
    if (!loginItemAvailable) return [];
    const state = readLoginState();
    return [
      {
        label: desktopPhrasebook().say("desktop.tray.startAtLogin"),
        type: "checkbox",
        checked: state === undefined ? false : isLoginItemResidencyEnabled(state, platform),
        enabled: state !== undefined,
        click: (menuItem) => setLoginState(menuItem.checked),
      },
    ];
  };
  const showContextMenu = async (): Promise<void> => {
    await refreshDesktopLanguage();
    if (closed || tray === undefined) return;
    const template: MenuItemConstructorOptions[] = [
      {
        label: desktopPhrasebook().say("desktop.tray.open", {
          product: desktopPlatformTokens().product,
        }),
        click: () => void showMainWindow(),
      },
      { type: "separator" },
      {
        label: desktopPhrasebook().say("desktop.tray.settings"),
        click: () => void showMainWindow("settings"),
      },
      ...startAtLoginItem(),
      { type: "separator" },
      {
        label: desktopPhrasebook().say("desktop.tray.quit", {
          product: desktopPlatformTokens().product,
        }),
        click: () => {
          if (!closed) residency.quit();
        },
      },
    ];
    tray.popUpContextMenu(Menu.buildFromTemplate(template));
  };
  const residency: DesktopResidency = {
    start() {
      startPromise ??= Promise.resolve()
        .then(() => {
          if (closed || tray !== undefined) return;
          const image = nativeImage.createFromPath(input.trayIconPath);
          if (image.isEmpty()) throw new TypeError();
          if (platform !== "win32") image.setTemplateImage(true);
          tray = new Tray(image);
          tray.setToolTip(TRAY_TOOLTIP);
          tray.on("click", () => {
            if (platform === "win32") void showMainWindow();
            else return showContextMenu();
          });
          tray.on("right-click", showContextMenu);
          input.observe?.({ type: "tray-created" });
        })
        .catch(() => {
          input.reportFailure("tray-start");
        });
      return startPromise;
    },
    showMainWindow,
    manageMainWindow,
    startAtLogin,
    async setStartAtLogin(enabled) {
      if (!loginItemAvailable || closed) return { kind: "unavailable" };
      setLoginState(enabled);
      await loginItemMutation;
      return startAtLogin();
    },
    quit() {
      if (quitRequested) return;
      quitRequested = true;
      input.app.quit();
    },
    close() {
      if (closePromise !== undefined) return closePromise;
      closed = true;
      disposeIpc?.();
      closePromise = loginItemMutation;
      if (tray !== undefined) {
        tray.removeAllListeners();
        tray.destroy();
        tray = undefined;
        input.observe?.({ type: "tray-destroyed" });
      }
      return closePromise;
    },
  };
  const disposeIpc =
    input.ipcMain === undefined || input.isTrusted === undefined
      ? undefined
      : installStartAtLoginIpc({
          ipcMain: input.ipcMain,
          isTrusted: input.isTrusted,
          residency: () => (closed ? undefined : residency),
        });
  return residency;
}
