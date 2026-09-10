import { initializeDesktopLanguage } from "../src/main/language.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CoachRpcRemoteError } from "@enduragent/coach-client";
import type { PlanReadModel } from "@enduragent/coach-contract";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  net: { fetch: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn() },
}));

import {
  createConnectionPlanningClient,
  installDesktopPlanningIpc,
} from "../src/main/planning-ipc.js";
import {
  DESKTOP_PLAN_PROGRESS_CHANNEL,
  DESKTOP_PLAN_COURSE_FILE_CHANNEL,
  DESKTOP_PLAN_STATE_CHANNEL,
  DESKTOP_PLAN_TRANSITION_CHANNEL,
} from "../src/main/constants.js";
import { createDesktopRendererUrl } from "../src/main/renderer-navigation.js";

const RENDERER_URL = createDesktopRendererUrl("A".repeat(43));

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const state: PlanReadModel = {
  schemaVersion: 1 as const,
  scenarioId: "PL-S001",
  lifecycle: "none" as const,
  planId: null,
  revision: 0,
  title: "Plan",
  summary: "No active Plan",
  projection: "no-plan",
  transitions: [{ transitionId: "PL-T01", status: "available", reason: null }],
  reconciliation: {
    status: "not-applicable",
    created: 0,
    pending: 0,
    failed: 0,
    total: 0,
    currentThrough: null,
    error: null,
  },
  attention: { count: 0, destination: "none" as const, items: [] },
  activeOperation: null,
  data: {},
};

const command = {
  transitionId: "PL-T01" as const,
  commandId: "command-1",
  sourceConversationId: null,
};

const progress = {
  commandId: command.commandId,
  transitionId: command.transitionId,
  operationId: "operation-1",
  phase: "completed" as const,
  completed: 1,
  total: 1,
};

function setup(
  getPlanState = vi.fn(async () => ({ status: "ready" as const, state })),
  executePlanTransition = vi.fn(
    async (_request: typeof command, onEvent: (event: typeof progress) => void) => {
      onEvent(progress);
      return { status: "completed" as const, state };
    },
  ),
) {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  };
  const mainFrame = { url: RENDERER_URL };
  const webContents = { isDestroyed: () => false, mainFrame, send: vi.fn() };
  const window = { isDestroyed: () => false, webContents };
  const dialog = {
    showOpenDialog: vi.fn(async () => ({
      canceled: false,
      filePaths: ["/synthetic/almaty.gpx"],
    })),
  };
  const dispose = installDesktopPlanningIpc({
    ipcMain: ipcMain as never,
    dialog,
    currentWindow: () => window as never,
    getPlanState,
    executePlanTransition: executePlanTransition as never,
  });
  return {
    dispose,
    handlers,
    ipcMain,
    getPlanState,
    executePlanTransition,
    dialog,
    webContents,
    trusted: { sender: webContents, senderFrame: mainFrame },
  };
}

beforeEach(() => vi.clearAllMocks());

await initializeDesktopLanguage();

describe("desktop Planning IPC", () => {
  it("forwards strict reads and transition commands from the trusted main frame", async () => {
    const subject = setup();
    await expect(
      subject.handlers.get(DESKTOP_PLAN_STATE_CHANNEL)!(subject.trusted),
    ).resolves.toEqual({
      status: "ready",
      state,
    });
    await expect(
      subject.handlers.get(DESKTOP_PLAN_TRANSITION_CHANNEL)!(subject.trusted, command),
    ).resolves.toEqual({ status: "completed", state });
    expect(subject.getPlanState).toHaveBeenCalledWith({});
    expect(subject.executePlanTransition).toHaveBeenCalledWith(command, expect.any(Function));
    expect(subject.webContents.send).toHaveBeenCalledWith(DESKTOP_PLAN_PROGRESS_CHANNEL, progress);
  });

  it("rejects untrusted, malformed, and extra arguments before invoking Planning", async () => {
    const subject = setup();
    const untrusted = { sender: {}, senderFrame: { url: RENDERER_URL } };
    await expect(subject.handlers.get(DESKTOP_PLAN_STATE_CHANNEL)!(untrusted)).rejects.toThrow(
      "untrusted desktop Planning request",
    );
    await expect(
      subject.handlers.get(DESKTOP_PLAN_TRANSITION_CHANNEL)!(untrusted, command),
    ).rejects.toThrow("untrusted desktop Planning request");
    await expect(
      subject.handlers.get(DESKTOP_PLAN_COURSE_FILE_CHANNEL)!(untrusted),
    ).rejects.toThrow("untrusted desktop Planning request");
    await expect(
      subject.handlers.get(DESKTOP_PLAN_STATE_CHANNEL)!(subject.trusted, {}),
    ).rejects.toThrow("invalid desktop Planning request");
    await expect(
      subject.handlers.get(DESKTOP_PLAN_TRANSITION_CHANNEL)!(subject.trusted, {
        ...command,
        extra: true,
      }),
    ).rejects.toThrow("invalid desktop Planning request");
    expect(subject.getPlanState).not.toHaveBeenCalled();
    expect(subject.executePlanTransition).not.toHaveBeenCalled();
  });

  it("returns one validated GPX or FIT Course path and keeps cancellation explicit", async () => {
    const subject = setup();
    await expect(
      subject.handlers.get(DESKTOP_PLAN_COURSE_FILE_CHANNEL)!(subject.trusted),
    ).resolves.toBe("/synthetic/almaty.gpx");
    expect(subject.dialog.showOpenDialog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        properties: ["openFile"],
        filters: [{ name: "Race Course", extensions: ["gpx", "fit"] }],
      }),
    );
    subject.dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    await expect(
      subject.handlers.get(DESKTOP_PLAN_COURSE_FILE_CHANNEL)!(subject.trusted),
    ).resolves.toBeNull();
    subject.dialog.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ["/synthetic/not-a-course.txt"],
    });
    await expect(
      subject.handlers.get(DESKTOP_PLAN_COURSE_FILE_CHANNEL)!(subject.trusted),
    ).rejects.toThrow("invalid Race Course selection");
  });

  it("redacts malformed results and progress without publishing either", async () => {
    const subject = setup(
      vi.fn(async () => ({ status: "ready", state: { ...state, scenarioId: "PL-S999" } })) as never,
      vi.fn(async (_request, onEvent) => {
        onEvent({ ...progress, total: 0 });
        return { status: "completed" as const, state };
      }) as never,
    );
    await expect(
      subject.handlers.get(DESKTOP_PLAN_STATE_CHANNEL)!(subject.trusted),
    ).rejects.toThrow("desktop Planning unavailable");
    await expect(
      subject.handlers.get(DESKTOP_PLAN_TRANSITION_CHANNEL)!(subject.trusted, command),
    ).rejects.toThrow("desktop Planning unavailable");
    expect(subject.webContents.send).not.toHaveBeenCalled();
  });

  it("maps old-daemon method absence to explicit unsupported capability and closes clients", async () => {
    const client = {
      call: vi.fn(async () => {
        throw new CoachRpcRemoteError(-32601, "Method not found");
      }),
      close: vi.fn(async () => {}),
    };
    const connect = vi.fn(async () => client);
    const planning = createConnectionPlanningClient(
      {
        url: "ws://127.0.0.1:45001/rpc",
        token: "s".repeat(43),
        athleteHome: "/synthetic/athlete",
      },
      connect as never,
    );

    await expect(planning.getPlanState({})).resolves.toEqual({
      status: "unsupported-capability",
      capability: "planning",
    });
    await expect(planning.executePlanTransition(command)).resolves.toEqual({
      status: "unsupported-capability",
      capability: "planning",
    });
    expect(client.close).toHaveBeenCalledTimes(2);
    expect(client.call).toHaveBeenNthCalledWith(1, "getPlanState", {});
    expect(client.call).toHaveBeenNthCalledWith(2, "executePlanTransition", command, {
      onEvent: undefined,
    });
  });

  it("removes every Planning handler during shutdown", () => {
    const subject = setup();
    subject.dispose();
    for (const channel of [
      DESKTOP_PLAN_STATE_CHANNEL,
      DESKTOP_PLAN_TRANSITION_CHANNEL,
      DESKTOP_PLAN_COURSE_FILE_CHANNEL,
    ]) {
      expect(subject.handlers.has(channel)).toBe(false);
      expect(subject.ipcMain.removeHandler).toHaveBeenCalledWith(channel);
    }
  });
});
