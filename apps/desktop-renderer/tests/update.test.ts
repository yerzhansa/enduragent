import { describe, expect, it, vi } from "vitest";
import {
  createDesktopUpdateController,
  type DesktopUpdateBridge,
  type DesktopUpdateState,
  type DesktopUpdateView,
} from "../src/update/controller";

function setupController(initial: DesktopUpdateState = { status: "idle" }) {
  let listener: ((state: DesktopUpdateState) => void) | undefined;
  let action: (() => void) | undefined;
  const bridge: DesktopUpdateBridge = {
    getUpdateState: vi.fn<DesktopUpdateBridge["getUpdateState"]>(async () => initial),
    checkForUpdates: vi.fn<DesktopUpdateBridge["checkForUpdates"]>(async () => ({
      status: "current",
    })),
    restartToUpdate: vi.fn<DesktopUpdateBridge["restartToUpdate"]>(async () => ({
      status: "installing",
      version: "2026.7.23",
    })),
    onUpdateState: vi.fn((next) => {
      listener = next;
      return vi.fn();
    }),
  };
  const view: DesktopUpdateView = {
    bind: vi.fn((next) => {
      action = next;
    }),
    render: vi.fn(),
    dispose: vi.fn(),
  };
  const controller = createDesktopUpdateController({ bridge, view });
  return {
    action: () => action?.(),
    bridge,
    controller,
    publish: (state: DesktopUpdateState) => listener?.(state),
    view,
  };
}

describe("desktop update renderer controller", () => {
  it("loads the initial state, checks on demand, and accepts pushed state", async () => {
    const subject = setupController();
    await subject.controller.start();
    expect(subject.view.render).toHaveBeenLastCalledWith({ status: "idle" });
    subject.action();
    await vi.waitFor(() => expect(subject.bridge.checkForUpdates).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(subject.view.render).toHaveBeenLastCalledWith({ status: "current" }),
    );
    subject.publish({
      status: "downloading",
      version: "2026.7.23",
      progress: {
        percent: 42,
        transferredBytes: 14_000_000,
        totalBytes: 33_000_000,
        bytesPerSecond: 4_200_000,
      },
    });
    expect(subject.view.render).toHaveBeenLastCalledWith({
      status: "downloading",
      version: "2026.7.23",
      progress: {
        percent: 42,
        transferredBytes: 14_000_000,
        totalBytes: 33_000_000,
        bytesPerSecond: 4_200_000,
      },
    });
    subject.publish({ status: "preparing", version: "2026.7.23" });
    expect(subject.view.render).toHaveBeenLastCalledWith({
      status: "preparing",
      version: "2026.7.23",
    });
  });

  it("restarts only from downloaded and ignores actions while busy", async () => {
    const subject = setupController({ status: "checking" });
    await subject.controller.start();
    subject.action();
    expect(subject.bridge.checkForUpdates).not.toHaveBeenCalled();
    expect(subject.bridge.restartToUpdate).not.toHaveBeenCalled();

    subject.publish({ status: "preparing", version: "2026.7.23" });
    subject.action();
    expect(subject.bridge.checkForUpdates).not.toHaveBeenCalled();
    expect(subject.bridge.restartToUpdate).not.toHaveBeenCalled();

    subject.publish({ status: "downloaded", version: "2026.7.23" });
    subject.action();
    await vi.waitFor(() => expect(subject.bridge.restartToUpdate).toHaveBeenCalledOnce());
    expect(subject.bridge.checkForUpdates).not.toHaveBeenCalled();
  });

  it("does not offer an inert retry when the updater requires an app restart", async () => {
    const subject = setupController({ status: "restart-required", stage: "check" });
    await subject.controller.start();

    subject.action();

    expect(subject.bridge.checkForUpdates).not.toHaveBeenCalled();
    expect(subject.bridge.restartToUpdate).not.toHaveBeenCalled();
    expect(subject.view.render).toHaveBeenLastCalledWith({
      status: "restart-required",
      stage: "check",
    });
  });

  it("preserves a downloaded update and retries when restart fails", async () => {
    const downloaded = { status: "downloaded", version: "2026.7.23" } as const;
    const subject = setupController(downloaded);
    vi.mocked(subject.bridge.restartToUpdate)
      .mockRejectedValueOnce(new Error("synthetic restart failure"))
      .mockResolvedValueOnce({ status: "installing", version: downloaded.version });
    await subject.controller.start();

    subject.action();
    await vi.waitFor(() => expect(subject.bridge.restartToUpdate).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(subject.view.render).toHaveBeenLastCalledWith(downloaded));
    expect(subject.view.render).not.toHaveBeenCalledWith({ status: "failed", stage: "check" });

    subject.action();
    await vi.waitFor(() => expect(subject.bridge.restartToUpdate).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(subject.view.render).toHaveBeenLastCalledWith({
        status: "installing",
        version: downloaded.version,
      }),
    );
    expect(subject.bridge.checkForUpdates).not.toHaveBeenCalled();
  });

  it("contains rejected diagnostics and disposes its subscription and view", async () => {
    const raw = "Authorization: secret https://private.invalid/feed";
    const subject = setupController();
    vi.mocked(subject.bridge.getUpdateState).mockRejectedValue(new Error(raw));
    await subject.controller.start();
    expect(subject.view.render).toHaveBeenLastCalledWith({ status: "failed", stage: "check" });
    expect(JSON.stringify(vi.mocked(subject.view.render).mock.calls)).not.toContain(raw);
    subject.controller.dispose();
    subject.controller.dispose();
    expect(subject.view.dispose).toHaveBeenCalledOnce();
    subject.publish({ status: "current" });
    expect(subject.view.render).toHaveBeenCalledOnce();
  });

  it("blocks update actions until initial getUpdateState hydrates", async () => {
    let resolveInitial!: (state: DesktopUpdateState) => void;
    const subject = setupController();
    vi.mocked(subject.bridge.getUpdateState).mockReturnValue(
      new Promise((resolve) => {
        resolveInitial = resolve;
      }),
    );

    const startup = subject.controller.start();
    subject.action();
    expect(subject.bridge.checkForUpdates).not.toHaveBeenCalled();
    expect(subject.bridge.restartToUpdate).not.toHaveBeenCalled();

    resolveInitial({ status: "idle" });
    await startup;
    subject.action();
    await vi.waitFor(() => expect(subject.bridge.checkForUpdates).toHaveBeenCalledOnce());
  });

  it("distinguishes pending checking from restarting even when downloaded arrives before invoke settles", async () => {
    let resolveCheck!: (state: DesktopUpdateState) => void;
    const subject = setupController({ status: "idle" });
    vi.mocked(subject.bridge.checkForUpdates).mockReturnValue(
      new Promise((resolve) => {
        resolveCheck = resolve;
      }),
    );
    await subject.controller.start();

    subject.action();
    expect(subject.view.render).toHaveBeenLastCalledWith(
      { status: "idle" },
      { pendingAction: "checking" },
    );

    subject.publish({ status: "downloaded", version: "1998.7.7" });
    expect(subject.view.render).toHaveBeenLastCalledWith(
      { status: "downloaded", version: "1998.7.7" },
      { pendingAction: "checking" },
    );

    resolveCheck({ status: "downloaded", version: "1998.7.7" });
    await vi.waitFor(() =>
      expect(subject.view.render).toHaveBeenLastCalledWith({
        status: "downloaded",
        version: "1998.7.7",
      }),
    );

    subject.action();
    expect(subject.view.render).toHaveBeenLastCalledWith(
      { status: "downloaded", version: "1998.7.7" },
      { pendingAction: "restarting" },
    );
  });

  it("moves to failed when checkForUpdates rejects after checking or downloading pushes", async () => {
    let rejectCheck: ((reason: unknown) => void) | undefined;
    const subject = setupController({ status: "idle" });
    vi.mocked(subject.bridge.checkForUpdates)
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectCheck = reject;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectCheck = reject;
          }),
      );
    await subject.controller.start();

    subject.action();
    await vi.waitFor(() => expect(subject.bridge.checkForUpdates).toHaveBeenCalledTimes(1));
    subject.publish({ status: "checking" });
    rejectCheck?.(new Error("ipc dropped"));
    await vi.waitFor(() =>
      expect(subject.view.render).toHaveBeenLastCalledWith({ status: "failed", stage: "check" }),
    );

    subject.action();
    await vi.waitFor(() => expect(subject.bridge.checkForUpdates).toHaveBeenCalledTimes(2));
    subject.publish({ status: "downloading", version: "1998.7.7" });
    rejectCheck?.(new Error("ipc dropped during download"));
    await vi.waitFor(() =>
      expect(subject.view.render).toHaveBeenLastCalledWith({
        status: "failed",
        stage: "download",
      }),
    );
  });
});
