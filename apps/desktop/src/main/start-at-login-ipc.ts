import type { IpcMain, IpcMainInvokeEvent } from "electron";
import {
  DESKTOP_START_AT_LOGIN_GET_CHANNEL,
  DESKTOP_START_AT_LOGIN_SET_CHANNEL,
} from "./constants.js";
import type { DesktopResidency, StartAtLoginState } from "./residency.js";

type LoginPort = Pick<DesktopResidency, "startAtLogin" | "setStartAtLogin">;

export function parseStartAtLoginState(value: unknown): StartAtLoginState | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const kind: unknown = Reflect.get(value, "kind");
  if (kind === "unavailable") return { kind };
  const enabled: unknown = Reflect.get(value, "enabled");
  return kind === "known" && typeof enabled === "boolean" ? { kind, enabled } : undefined;
}

export function installStartAtLoginIpc(input: {
  readonly ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  readonly isTrusted: (event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">) => boolean;
  readonly residency: () => LoginPort | undefined;
}): () => void {
  let disposed = false;
  input.ipcMain.handle(
    DESKTOP_START_AT_LOGIN_GET_CHANNEL,
    (event: IpcMainInvokeEvent, ...args: unknown[]): StartAtLoginState => {
      if (!input.isTrusted(event)) throw new Error("untrusted start at login request");
      if (args.length !== 0) throw new TypeError("invalid start at login request");
      return input.residency()?.startAtLogin() ?? { kind: "unavailable" };
    },
  );
  input.ipcMain.handle(
    DESKTOP_START_AT_LOGIN_SET_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<StartAtLoginState> => {
      if (!input.isTrusted(event)) throw new Error("untrusted start at login request");
      const [enabled] = args;
      if (args.length !== 1 || typeof enabled !== "boolean") {
        throw new TypeError("invalid start at login request");
      }
      const residency = input.residency();
      return residency === undefined ? { kind: "unavailable" } : residency.setStartAtLogin(enabled);
    },
  );
  return () => {
    if (disposed) return;
    disposed = true;
    input.ipcMain.removeHandler(DESKTOP_START_AT_LOGIN_GET_CHANNEL);
    input.ipcMain.removeHandler(DESKTOP_START_AT_LOGIN_SET_CHANNEL);
  };
}
