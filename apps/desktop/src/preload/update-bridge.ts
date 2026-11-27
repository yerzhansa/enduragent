import type { IpcRenderer } from "electron";
import {
  DESKTOP_UPDATE_CHECK_CHANNEL,
  DESKTOP_UPDATE_GET_CHANNEL,
  DESKTOP_UPDATE_RESTART_CHANNEL,
} from "../main/constants.js";

export function createUpdateBridge<State>(
  ipcRenderer: Pick<IpcRenderer, "invoke">,
  parseState: (value: unknown) => State,
) {
  return {
    getUpdateState: async () => parseState(await ipcRenderer.invoke(DESKTOP_UPDATE_GET_CHANNEL)),
    checkForUpdates: async () => parseState(await ipcRenderer.invoke(DESKTOP_UPDATE_CHECK_CHANNEL)),
    restartToUpdate: async () =>
      parseState(await ipcRenderer.invoke(DESKTOP_UPDATE_RESTART_CHANNEL)),
  };
}
