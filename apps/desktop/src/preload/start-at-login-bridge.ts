import type { IpcRenderer } from "electron";
import {
  DESKTOP_START_AT_LOGIN_GET_CHANNEL,
  DESKTOP_START_AT_LOGIN_SET_CHANNEL,
} from "../main/constants.js";
import { parseStartAtLoginState } from "../main/start-at-login-ipc.js";
import type { StartAtLoginState } from "../main/residency.js";

function state(value: unknown): StartAtLoginState {
  const parsed = parseStartAtLoginState(value);
  if (parsed === undefined) throw new TypeError();
  return parsed;
}

export function createStartAtLoginBridge(ipcRenderer: Pick<IpcRenderer, "invoke">) {
  return {
    readStartAtLogin: async (...args: unknown[]) => {
      if (args.length !== 0) throw new TypeError();
      return state(await ipcRenderer.invoke(DESKTOP_START_AT_LOGIN_GET_CHANNEL));
    },
    setStartAtLogin: async (enabled: unknown, ...args: unknown[]) => {
      if (args.length !== 0 || typeof enabled !== "boolean") throw new TypeError();
      return state(await ipcRenderer.invoke(DESKTOP_START_AT_LOGIN_SET_CHANNEL, enabled));
    },
  };
}
