import type { BrowserWindow, IpcMain, IpcMainEvent } from "electron";
import { DESKTOP_OPEN_EXTERNAL_CHANNEL } from "./constants.js";
import { isTrustedConnectionRequest } from "./security.js";

function hasUnsafeUrlCodePoint(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

function canonicalExternalUrl(value: string): string | undefined {
  if (hasUnsafeUrlCodePoint(value)) return undefined;
  try {
    const url = new URL(value);
    if (
      url.href !== value ||
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.hostname.length === 0 ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

export function installDesktopExternalLinkIpc(input: {
  readonly ipcMain: Pick<IpcMain, "on" | "removeListener">;
  readonly currentWindow: () => BrowserWindow | undefined;
  readonly openExternal: (url: string) => Promise<void>;
}): () => void {
  const onOpenExternal = (event: IpcMainEvent, ...args: unknown[]): void => {
    if (!isTrustedConnectionRequest(event, input.currentWindow())) return;
    if (args.length !== 1 || typeof args[0] !== "string") return;
    const url = canonicalExternalUrl(args[0]);
    if (url === undefined) return;
    try {
      void input.openExternal(url).catch(() => {});
    } catch {}
  };
  input.ipcMain.on(DESKTOP_OPEN_EXTERNAL_CHANNEL, onOpenExternal);
  let installed = true;
  return () => {
    if (!installed) return;
    installed = false;
    input.ipcMain.removeListener(DESKTOP_OPEN_EXTERNAL_CHANNEL, onOpenExternal);
  };
}
