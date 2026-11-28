import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import {
  DESKTOP_START_AT_LOGIN_GET_CHANNEL,
  DESKTOP_START_AT_LOGIN_SET_CHANNEL,
} from "../src/main/constants.js";
import { installStartAtLoginIpc, parseStartAtLoginState } from "../src/main/start-at-login-ipc.js";

type Handler = Parameters<IpcMain["handle"]>[1];

function harness(trusted = true) {
  const handlers = new Map<string, Handler>();
  const residency = {
    startAtLogin: vi.fn(() => ({ kind: "known" as const, enabled: false })),
    setStartAtLogin: vi.fn(async (enabled: boolean) => ({ kind: "known" as const, enabled })),
  };
  let current: typeof residency | undefined = residency;
  const dispose = installStartAtLoginIpc({
    ipcMain: {
      handle: (channel: string, handler: Handler) => {
        handlers.set(channel, handler);
      },
      removeHandler: (channel: string) => {
        handlers.delete(channel);
      },
    },
    isTrusted: () => trusted,
    residency: () => current,
  });
  const call = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (handler === undefined) throw new Error("no handler");
    return handler({} as IpcMainInvokeEvent, ...args);
  };
  return {
    call,
    residency,
    handlers,
    dispose,
    closeResidency: () => {
      current = undefined;
    },
  };
}

describe("the start at login bridge", () => {
  it("reads and sets the switch for the app's own window", async () => {
    const test = harness();
    expect(test.call(DESKTOP_START_AT_LOGIN_GET_CHANNEL)).toEqual({
      kind: "known",
      enabled: false,
    });
    await expect(test.call(DESKTOP_START_AT_LOGIN_SET_CHANNEL, true)).resolves.toEqual({
      kind: "known",
      enabled: true,
    });
    expect(test.residency.setStartAtLogin).toHaveBeenCalledWith(true);
  });

  it("refuses other senders and anything but one true or false", async () => {
    const untrusted = harness(false);
    expect(() => untrusted.call(DESKTOP_START_AT_LOGIN_GET_CHANNEL)).toThrow("untrusted");
    await expect(untrusted.call(DESKTOP_START_AT_LOGIN_SET_CHANNEL, true)).rejects.toThrow(
      "untrusted",
    );
    const test = harness();
    expect(() => test.call(DESKTOP_START_AT_LOGIN_GET_CHANNEL, "extra")).toThrow(TypeError);
    await expect(test.call(DESKTOP_START_AT_LOGIN_SET_CHANNEL, "yes")).rejects.toThrow(TypeError);
    await expect(test.call(DESKTOP_START_AT_LOGIN_SET_CHANNEL, true, false)).rejects.toThrow(
      TypeError,
    );
    expect(test.residency.setStartAtLogin).not.toHaveBeenCalled();
  });

  it("says unavailable once the residency is gone, and removes its handlers on dispose", async () => {
    const test = harness();
    test.closeResidency();
    expect(test.call(DESKTOP_START_AT_LOGIN_GET_CHANNEL)).toEqual({ kind: "unavailable" });
    await expect(test.call(DESKTOP_START_AT_LOGIN_SET_CHANNEL, true)).resolves.toEqual({
      kind: "unavailable",
    });
    test.dispose();
    expect(test.handlers.size).toBe(0);
  });

  it("accepts only the two known states", () => {
    expect(parseStartAtLoginState({ kind: "unavailable" })).toEqual({ kind: "unavailable" });
    expect(parseStartAtLoginState({ kind: "known", enabled: true })).toEqual({
      kind: "known",
      enabled: true,
    });
    expect(parseStartAtLoginState({ kind: "known", enabled: "true" })).toBeUndefined();
    expect(parseStartAtLoginState(null)).toBeUndefined();
  });
});
