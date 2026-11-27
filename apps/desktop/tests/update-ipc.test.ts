import { describe, expect, it, vi } from "vitest";
import {
  DESKTOP_UPDATE_CHECK_CHANNEL,
  DESKTOP_UPDATE_GET_CHANNEL,
  DESKTOP_UPDATE_RESTART_CHANNEL,
  DESKTOP_UPDATE_STATE_CHANNEL,
} from "../src/main/constants.js";
import { installDesktopUpdateIpc } from "../src/main/update-ipc.js";
import type { DesktopUpdateController, DesktopUpdateState } from "../src/main/update-controller.js";
import { createDesktopRendererUrl } from "../src/main/renderer-navigation.js";

const RENDERER_URL = createDesktopRendererUrl("A".repeat(43));

type Handler = (event: unknown, ...args: unknown[]) => unknown;

function setup() {
  const handlers = new Map<string, Handler>();
  let subscriber: ((state: DesktopUpdateState) => void) | undefined;
  const controller: DesktopUpdateController = {
    state: vi.fn<DesktopUpdateController["state"]>(() => ({ status: "idle" })),
    start: vi.fn(async () => {}),
    check: vi.fn<DesktopUpdateController["check"]>(async () => ({ status: "current" })),
    restart: vi.fn<DesktopUpdateController["restart"]>(() => ({
      status: "installing",
      version: "2026.7.23",
    })),
    subscribe: vi.fn((listener) => {
      subscriber = listener;
      return vi.fn();
    }),
    completeInstallAfterDrain: vi.fn<DesktopUpdateController["completeInstallAfterDrain"]>(
      () => "not-requested",
    ),
    close: vi.fn(),
  };
  const mainFrame = { url: RENDERER_URL };
  const webContents = { isDestroyed: () => false, mainFrame, send: vi.fn() };
  const window = { isDestroyed: () => false, webContents };
  const trusted = { sender: webContents, senderFrame: mainFrame };
  let currentWindow: typeof window | undefined = window;
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  };
  const isTrusted = vi.fn((event: unknown) => event === trusted);
  const dispose = installDesktopUpdateIpc({
    ipcMain: ipcMain as never,
    currentWindow: () => currentWindow as never,
    isTrusted: isTrusted as never,
    controller,
  });
  return {
    controller,
    dispose,
    handlers,
    ipcMain,
    publish: (state: DesktopUpdateState) => subscriber?.(state),
    setWindow: (next: typeof window | undefined) => {
      currentWindow = next;
    },
    trusted,
    webContents,
    window,
  };
}

describe("desktop update IPC", () => {
  it("registers trusted zero-argument get, check, and restart handlers", async () => {
    const state = setup();
    expect(state.handlers.get(DESKTOP_UPDATE_GET_CHANNEL)!(state.trusted)).toEqual({
      status: "idle",
    });
    await expect(state.handlers.get(DESKTOP_UPDATE_CHECK_CHANNEL)!(state.trusted)).resolves.toEqual(
      { status: "current" },
    );
    expect(state.handlers.get(DESKTOP_UPDATE_RESTART_CHANNEL)!(state.trusted)).toEqual({
      status: "installing",
      version: "2026.7.23",
    });
    expect(state.controller.check).toHaveBeenCalledOnce();
    expect(state.controller.restart).toHaveBeenCalledOnce();
  });

  it.each([
    [DESKTOP_UPDATE_GET_CHANNEL, { sender: {}, senderFrame: {} }, []],
    [DESKTOP_UPDATE_CHECK_CHANNEL, { sender: {}, senderFrame: {} }, []],
    [DESKTOP_UPDATE_RESTART_CHANNEL, { sender: {}, senderFrame: {} }, []],
    [DESKTOP_UPDATE_GET_CHANNEL, null, [{ extra: true }]],
    [DESKTOP_UPDATE_CHECK_CHANNEL, null, [undefined]],
    [DESKTOP_UPDATE_RESTART_CHANNEL, null, ["yes"]],
  ])("rejects untrusted or argument-bearing %s requests", async (channel, event, args) => {
    const state = setup();
    await expect(
      Promise.resolve().then(() =>
        state.handlers.get(channel)!(event ?? state.trusted, ...(args as unknown[])),
      ),
    ).rejects.toThrow();
  });

  it("pushes fixed state only to the live trusted main frame and disposes exactly once", () => {
    const state = setup();
    state.publish({ status: "downloaded", version: "2026.7.23" });
    expect(state.webContents.send).toHaveBeenCalledWith(DESKTOP_UPDATE_STATE_CHANNEL, {
      status: "downloaded",
      version: "2026.7.23",
    });

    state.webContents.mainFrame.url = "https://attacker.invalid/";
    state.publish({ status: "failed", stage: "download" });
    state.setWindow(undefined);
    state.publish({ status: "current" });
    expect(state.webContents.send).toHaveBeenCalledOnce();

    state.dispose();
    state.dispose();
    expect(state.ipcMain.removeHandler).toHaveBeenCalledTimes(3);
    expect(state.handlers.size).toBe(0);
  });

  it("preserves restart-required recovery across request and push boundaries", async () => {
    const state = setup();
    vi.mocked(state.controller.check).mockResolvedValue({
      status: "restart-required",
      stage: "download",
    });

    await expect(state.handlers.get(DESKTOP_UPDATE_CHECK_CHANNEL)!(state.trusted)).resolves.toEqual(
      {
        status: "restart-required",
        stage: "download",
      },
    );
    state.publish({ status: "restart-required", stage: "check" });
    expect(state.webContents.send).toHaveBeenLastCalledWith(DESKTOP_UPDATE_STATE_CHANNEL, {
      status: "restart-required",
      stage: "check",
    });
  });

  it("deep-copies download progress and preserves preparing state across request and push boundaries", () => {
    const state = setup();
    const progress = {
      percent: 42,
      transferredBytes: 14_000_000,
      totalBytes: 33_000_000,
      bytesPerSecond: 4_200_000,
    };
    const downloading: DesktopUpdateState = {
      status: "downloading",
      version: "0.7.0",
      progress,
    };
    vi.mocked(state.controller.state).mockReturnValue(downloading);

    const fetched = state.handlers.get(DESKTOP_UPDATE_GET_CHANNEL)!(
      state.trusted,
    ) as DesktopUpdateState;
    expect(fetched).toEqual(downloading);
    if (fetched.status === "downloading") {
      expect(fetched.progress).not.toBe(progress);
    }

    state.publish(downloading);
    const pushed = state.webContents.send.mock.calls.at(-1)?.[1] as DesktopUpdateState;
    expect(pushed).toEqual(downloading);
    if (pushed.status === "downloading") {
      expect(pushed.progress).not.toBe(progress);
    }

    state.publish({ status: "preparing", version: "0.7.0" });
    expect(state.webContents.send).toHaveBeenLastCalledWith(DESKTOP_UPDATE_STATE_CHANNEL, {
      status: "preparing",
      version: "0.7.0",
    });
  });
});
