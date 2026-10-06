import type { BrowserWindow, IpcMain, IpcMainEvent } from "electron";
import {
  desktopWindowBackgroundColor,
  parseDesktopAppearance,
  type DesktopAppearance,
  type DesktopResolvedTheme,
} from "./appearance.js";
import { DESKTOP_APPEARANCE_CHANNEL } from "./constants.js";
import { isTrustedConnectionRequest } from "./security.js";

export function installDesktopAppearanceIpc(input: {
  readonly ipcMain: Pick<IpcMain, "on" | "removeListener">;
  readonly currentWindow: () => BrowserWindow | undefined;
  readonly applyThemeSource: (appearance: DesktopAppearance) => DesktopResolvedTheme;
}): () => void {
  const onAppearance = (event: IpcMainEvent, ...args: unknown[]): void => {
    const window = input.currentWindow();
    if (window === undefined) return;
    if (!isTrustedConnectionRequest(event, window)) return;
    if (args.length !== 1) return;
    const appearance = parseDesktopAppearance(args[0]);
    if (appearance === undefined) return;
    try {
      window.setBackgroundColor(desktopWindowBackgroundColor(input.applyThemeSource(appearance)));
    } catch {}
  };
  input.ipcMain.on(DESKTOP_APPEARANCE_CHANNEL, onAppearance);
  let installed = true;
  return () => {
    if (!installed) return;
    installed = false;
    input.ipcMain.removeListener(DESKTOP_APPEARANCE_CHANNEL, onAppearance);
  };
}
