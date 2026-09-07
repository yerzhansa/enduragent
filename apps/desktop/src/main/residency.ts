import {
  Menu,
  Tray,
  nativeImage,
  type App,
  type BrowserWindow,
  type MenuItemConstructorOptions,
} from "electron";
import { DESKTOP_OPEN_SETTINGS_CHANNEL } from "./constants.js";
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

export interface DesktopResidencyInput {
  readonly app: App;
  readonly mainWindow: MainWindowResidencyPort;
  readonly trayIconPath: string;
  readonly platform?: NodeJS.Platform;
  readonly loginItemExecutablePath?: string;
  readonly persistLoginPreference: (
    enabled: boolean,
  ) => Promise<BackgroundAtLoginPreferenceWriteResult>;
  readonly reportFailure: (
    operation: "read-login-item" | "set-login-item" | "show-window" | "tray-start",
  ) => void;
  readonly observe?: (event: DesktopResidencyEvent) => void;
}

export interface DesktopResidency {
  start(): Promise<void>;
  showMainWindow(): Promise<void>;
  manageMainWindow(window: BrowserWindow): void;
  quit(): void;
  close(): Promise<void>;
}

export function createDesktopResidency(input: DesktopResidencyInput): DesktopResidency {
  const platform = input.platform ?? process.platform;
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
      let applied: LoginItemResidencyState | undefined;
      try {
        const state = setLoginItemResidency(input.app, openAtLogin, {
          platform,
          executablePath: input.loginItemExecutablePath,
        });
        if (!loginItemResidencyMatchesRequest(state, openAtLogin, platform)) throw new TypeError();
        applied = state;
      } catch {}
      if (applied !== undefined) {
        input.observe?.({ type: "login-item-set", state: applied });
        return;
      }
      let compensation: BackgroundAtLoginPreferenceWriteResult = { status: "uncertain" };
      try {
        compensation = await input.persistLoginPreference(previousEnabled);
      } catch {}
      let convergenceTarget: boolean | undefined;
      if (compensation.status === "stored") {
        convergenceTarget = compensation.enabled;
      } else if (compensation.status === "refused") {
        // The reversible write proved that its prior, the new preference, remains durable.
        convergenceTarget = openAtLogin;
      }
      if (convergenceTarget !== undefined) {
        let converged = false;
        try {
          const state = setLoginItemResidency(input.app, convergenceTarget, {
            platform,
            executablePath: input.loginItemExecutablePath,
          });
          if (!loginItemResidencyMatchesRequest(state, convergenceTarget, platform)) {
            throw new TypeError();
          }
          input.observe?.({ type: "login-item-set", state });
          converged = true;
        } catch {}
        if (!converged) readLoginState();
      } else {
        readLoginState();
      }
      input.reportFailure("set-login-item");
    });
    loginItemMutation = mutation.then(
      () => undefined,
      () => undefined,
    );
  };
  const showContextMenu = (): void => {
    if (closed || tray === undefined) return;
    const state = readLoginState();
    const template: MenuItemConstructorOptions[] = [
      {
        label: "Open Enduragent",
        click: () => void showMainWindow(),
      },
      { type: "separator" },
      {
        label: "Settings…",
        click: () => void showMainWindow("settings"),
      },
      {
        label: "Start in background at login",
        type: "checkbox",
        checked: state === undefined ? false : isLoginItemResidencyEnabled(state, platform),
        enabled: state !== undefined,
        click: (menuItem) => setLoginState(menuItem.checked),
      },
      { type: "separator" },
      {
        label: "Quit Enduragent",
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
            else showContextMenu();
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
    quit() {
      if (quitRequested) return;
      quitRequested = true;
      input.app.quit();
    },
    close() {
      if (closePromise !== undefined) return closePromise;
      closed = true;
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
  return residency;
}
