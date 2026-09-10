import { initializeDesktopLanguage } from "../src/main/language.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  net: { fetch: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn() },
}));

import {
  createConnectionTrainingExporter,
  installDesktopTrainingExportIpc,
} from "../src/main/training-export-ipc.js";
import { DESKTOP_TRAINING_EXPORT_CHANNEL } from "../src/main/constants.js";
import { createDesktopRendererUrl } from "../src/main/renderer-navigation.js";

const RENDERER_URL = createDesktopRendererUrl("A".repeat(43));

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const EXPORTED = {
  status: "exported" as const,
  byteLength: 4_096,
  suggestedFilename: "provider-name.fit",
  contentType: "application/octet-stream",
};

function setup(result: unknown = EXPORTED) {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  };
  const mainFrame = { url: RENDERER_URL };
  const webContents = { isDestroyed: () => false, mainFrame };
  const window = { isDestroyed: () => false, webContents };
  const dialog = {
    showSaveDialog: vi.fn(async (): Promise<{ canceled: boolean; filePath?: string }> => ({
      canceled: false,
      filePath: "/tmp/synthetic-training-export.fit",
    })),
  };
  const exporter = { export: vi.fn(async () => result) };
  const log = vi.fn();
  const dispose = installDesktopTrainingExportIpc({
    ipcMain: ipcMain as never,
    currentWindow: () => window as never,
    dialog,
    exporter: () => exporter as never,
    log,
  });
  return {
    handlers,
    ipcMain,
    dialog,
    exporter,
    log,
    dispose,
    trusted: { sender: webContents, senderFrame: mainFrame },
  };
}

beforeEach(() => vi.clearAllMocks());

await initializeDesktopLanguage();

describe("desktop training export IPC", () => {
  it("uses the native save dialog and adds the destination only in the trusted main process", async () => {
    const subject = setup();
    const request = {
      kind: "activity",
      canonicalActivityId: "a".repeat(64),
      localDate: "1998-07-19",
      format: "fit",
    } as const;
    const result = await subject.handlers.get(DESKTOP_TRAINING_EXPORT_CHANNEL)!(
      subject.trusted,
      request,
    );

    expect(result).toEqual({ status: "saved", byteLength: 4_096 });
    expect(subject.dialog.showSaveDialog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        title: "Export ride as FIT",
        defaultPath: "ride-1998-07-19.fit",
        filters: [{ name: "FIT activity", extensions: ["fit"] }],
      }),
    );
    expect(subject.exporter.export).toHaveBeenCalledWith({
      kind: "activity",
      canonicalActivityId: "a".repeat(64),
      format: "fit",
      destinationPath: "/tmp/synthetic-training-export.fit",
    });
    expect(result).not.toHaveProperty("suggestedFilename");
    expect(result).not.toHaveProperty("contentType");
  });

  it.each(["C:\\Users\\x\\Documents\\ride.fit", "C:/Users/x/Documents/ride.fit"])(
    "passes the Windows save-dialog destination %s to the exporter",
    async (destinationPath) => {
      const subject = setup();
      subject.dialog.showSaveDialog.mockResolvedValueOnce({
        canceled: false,
        filePath: destinationPath,
      });

      await expect(
        subject.handlers.get(DESKTOP_TRAINING_EXPORT_CHANNEL)!(subject.trusted, {
          kind: "activity",
          canonicalActivityId: "a".repeat(64),
          localDate: "1998-07-19",
          format: "fit",
        }),
      ).resolves.toEqual({ status: "saved", byteLength: 4_096 });
      expect(subject.exporter.export).toHaveBeenCalledWith(
        expect.objectContaining({ destinationPath }),
      );
      expect(subject.log).not.toHaveBeenCalled();
    },
  );

  it("routes a closed workout archive request and handles cancellation without daemon work", async () => {
    const subject = setup();
    const request = {
      kind: "workout-archive",
      oldest: "1998-07-20",
      newest: "1998-07-26",
      format: "zwo",
    } as const;
    await expect(
      subject.handlers.get(DESKTOP_TRAINING_EXPORT_CHANNEL)!(subject.trusted, request),
    ).resolves.toEqual({ status: "saved", byteLength: 4_096 });
    expect(subject.exporter.export).toHaveBeenCalledWith({
      ...request,
      destinationPath: "/tmp/synthetic-training-export.fit",
    });
    expect(subject.dialog.showSaveDialog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        defaultPath: "cycling-workouts-1998-07-20-to-1998-07-26-zwo.zip",
      }),
    );

    subject.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: true });
    await expect(
      subject.handlers.get(DESKTOP_TRAINING_EXPORT_CHANNEL)!(subject.trusted, request),
    ).resolves.toEqual({ status: "cancelled" });
    expect(subject.exporter.export).toHaveBeenCalledTimes(1);
  });

  it("rejects untrusted or malformed input before showing a dialog", async () => {
    const subject = setup();
    const handler = subject.handlers.get(DESKTOP_TRAINING_EXPORT_CHANNEL)!;
    await expect(
      handler(
        { sender: {}, senderFrame: { url: RENDERER_URL } },
        {
          kind: "activity",
          canonicalActivityId: "a".repeat(64),
          localDate: "1998-07-19",
          format: "fit",
        },
      ),
    ).rejects.toThrow("untrusted desktop training export request");
    for (const args of [
      [],
      [
        {
          kind: "activity",
          canonicalActivityId: "provider-42",
          localDate: "1998-07-19",
          format: "fit",
        },
      ],
      [
        {
          kind: "activity",
          canonicalActivityId: "a".repeat(64),
          localDate: "1998-02-30",
          format: "fit",
        },
      ],
      [{ kind: "workout-archive", oldest: "1998-07-27", newest: "1998-07-20", format: "zwo" }],
      [{ kind: "workout-archive", oldest: "1998-07-20", newest: "1998-07-27", format: "zip" }],
      [
        {
          kind: "activity",
          canonicalActivityId: "a".repeat(64),
          localDate: "1998-07-19",
          format: "fit",
          destinationPath: "/tmp/hostile",
        },
      ],
    ]) {
      await expect(handler(subject.trusted, ...args)).rejects.toThrow(
        "invalid training export request",
      );
    }
    expect(subject.dialog.showSaveDialog).not.toHaveBeenCalled();
    expect(subject.exporter.export).not.toHaveBeenCalled();
  });

  it("redacts dialog, daemon, and malformed-result failures", async () => {
    const request = {
      kind: "activity",
      canonicalActivityId: "a".repeat(64),
      localDate: "1998-07-19",
      format: "gpx",
    } as const;
    const malformed = setup({ ...EXPORTED, destinationPath: "/private/provider/path" });
    await expect(
      malformed.handlers.get(DESKTOP_TRAINING_EXPORT_CHANNEL)!(malformed.trusted, request),
    ).resolves.toEqual({ status: "refused", reason: "write-failed" });
    expect(malformed.log).toHaveBeenCalledWith("desktop-training-export-failed stage=operation");

    const failed = setup();
    failed.exporter.export.mockRejectedValueOnce(new Error("private provider response"));
    await expect(
      failed.handlers.get(DESKTOP_TRAINING_EXPORT_CHANNEL)!(failed.trusted, request),
    ).resolves.toEqual({ status: "refused", reason: "write-failed" });
    expect(failed.log).toHaveBeenLastCalledWith("desktop-training-export-failed stage=operation");

    failed.dialog.showSaveDialog.mockRejectedValueOnce(new Error("private filesystem path"));
    await expect(
      failed.handlers.get(DESKTOP_TRAINING_EXPORT_CHANNEL)!(failed.trusted, request),
    ).resolves.toEqual({ status: "refused", reason: "write-failed" });
    expect(failed.log).toHaveBeenLastCalledWith("desktop-training-export-failed stage=dialog");

    failed.dialog.showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: "relative/private.fit",
    });
    await expect(
      failed.handlers.get(DESKTOP_TRAINING_EXPORT_CHANNEL)!(failed.trusted, request),
    ).resolves.toEqual({ status: "refused", reason: "write-failed" });
    expect(failed.log).toHaveBeenLastCalledWith("desktop-training-export-failed stage=operation");
    expect(failed.log).toHaveBeenCalledTimes(3);
    expect(JSON.stringify([...malformed.log.mock.calls, ...failed.log.mock.calls])).not.toContain(
      "private",
    );
  });

  it("does not inspect rejected values or let logging failures escape", async () => {
    const request = {
      kind: "activity",
      canonicalActivityId: "a".repeat(64),
      localDate: "1998-07-19",
      format: "fit",
    } as const;
    const subject = setup();
    const hostileError = new Error();
    Object.defineProperty(hostileError, "message", {
      get() {
        throw new Error("message getter was inspected");
      },
    });
    subject.exporter.export.mockRejectedValueOnce(hostileError);

    await expect(
      subject.handlers.get(DESKTOP_TRAINING_EXPORT_CHANNEL)!(subject.trusted, request),
    ).resolves.toEqual({ status: "refused", reason: "write-failed" });
    expect(subject.log).toHaveBeenLastCalledWith("desktop-training-export-failed stage=operation");

    subject.dialog.showSaveDialog.mockRejectedValueOnce({
      toString() {
        throw new Error("string conversion was attempted");
      },
    });
    await expect(
      subject.handlers.get(DESKTOP_TRAINING_EXPORT_CHANNEL)!(subject.trusted, request),
    ).resolves.toEqual({ status: "refused", reason: "write-failed" });
    expect(subject.log).toHaveBeenLastCalledWith("desktop-training-export-failed stage=dialog");

    subject.log.mockImplementationOnce(() => {
      throw new Error("logger unavailable");
    });
    subject.dialog.showSaveDialog.mockRejectedValueOnce(new Error("dialog unavailable"));
    await expect(
      subject.handlers.get(DESKTOP_TRAINING_EXPORT_CHANNEL)!(subject.trusted, request),
    ).resolves.toEqual({ status: "refused", reason: "write-failed" });
  });

  it("uses one privileged client and closes it after the export", async () => {
    const client = { call: vi.fn(async () => EXPORTED), close: vi.fn(async () => {}) };
    const connect = vi.fn(async () => client);
    const exporter = createConnectionTrainingExporter(
      {
        url: "ws://127.0.0.1:45001/rpc",
        token: "s".repeat(43),
        athleteHome: "/synthetic/athlete",
      },
      connect as never,
    );
    const request = {
      kind: "activity" as const,
      canonicalActivityId: "a".repeat(64),
      format: "fit" as const,
      destinationPath: "/tmp/synthetic.fit",
    };
    await expect(exporter.export(request)).resolves.toEqual(EXPORTED);
    expect(client.call).toHaveBeenCalledWith("exportTrainingFile", request);
    expect(client.close).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledWith({
      url: "ws://127.0.0.1:45001/rpc",
      token: "s".repeat(43),
      expectedAthleteHome: "/synthetic/athlete",
    });
  });

  it("removes the handler during shutdown", () => {
    const subject = setup();
    subject.dispose();
    expect(subject.handlers.has(DESKTOP_TRAINING_EXPORT_CHANNEL)).toBe(false);
    expect(subject.ipcMain.removeHandler).toHaveBeenCalledWith(DESKTOP_TRAINING_EXPORT_CHANNEL);
  });
});
