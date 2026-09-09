import { initializeDesktopLanguage } from "../src/main/language.js";
import { Buffer } from "node:buffer";
import type { ChatAttachmentComposerReadModel } from "@enduragent/coach-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  net: { fetch: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn() },
}));

import {
  installDesktopChatAttachmentIpc,
  type DesktopChatAttachmentClient,
} from "../src/main/chat-attachment-ipc.js";
import {
  DESKTOP_CHAT_ATTACHMENT_DROP_CHANNEL,
  DESKTOP_CHAT_ATTACHMENT_PASTE_CHANNEL,
  DESKTOP_CHAT_ATTACHMENT_PICK_CHANNEL,
} from "../src/main/constants.js";
import { createDesktopRendererUrl } from "../src/main/renderer-navigation.js";

const RENDERER_URL = createDesktopRendererUrl("A".repeat(43));
type Handler = (event: unknown, ...args: unknown[]) => unknown;

function capabilities(images: boolean): ChatAttachmentComposerReadModel {
  const shared = {
    schemaVersion: 1 as const,
    active: { provider: "test", model: images ? "vision" : "text", transport: "test" },
    documents: {
      enabled: true as const,
      extensions: ["pdf", "txt", "csv", "docx"] as ["pdf", "txt", "csv", "docx"],
    },
    completedActivities: {
      enabled: true as const,
      extensions: ["fit", "tcx", "gpx"] as ["fit", "tcx", "gpx"],
    },
    plannedWorkouts: {
      enabled: true as const,
      extensions: ["zwo", "erg", "mrc"] as ["zwo", "erg", "mrc"],
    },
  };
  const checkedAt = "2026-08-26T00:00:00.000Z";
  return images
    ? {
        schemaVersion: 1,
        capabilities: {
          ...shared,
          images: {
            enabled: true,
            mediaTypes: ["image/png", "image/jpeg", "image/webp"],
            reason: "supported",
            source: "maintained_catalogue",
            checkedAt,
          },
        },
        draft: null,
      }
    : {
        schemaVersion: 1,
        capabilities: {
          ...shared,
          images: {
            enabled: false,
            mediaTypes: [],
            reason: "model_incompatible",
            source: "maintained_catalogue",
            checkedAt,
          },
        },
        draft: null,
      };
}

function setup(
  images = true,
  filePaths: readonly string[] = ["/private/ride.fit", "/private/workout.zwo"],
) {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  };
  const mainFrame = { url: RENDERER_URL };
  const webContents = { isDestroyed: () => false, mainFrame };
  const window = { isDestroyed: () => false, webContents };
  const dialog = {
    showOpenDialog: vi.fn(async () => ({
      canceled: false,
      filePaths,
    })),
  };
  const admitPath = vi.fn<DesktopChatAttachmentClient["admitPath"]>(async (path, selectionId) => ({
    selectionId,
    displayName: path.endsWith(".fit") ? "ride.fit" : "workout.zwo",
    status: "accepted" as const,
    attachmentId: path.endsWith(".fit") ? "attachment-fit" : "attachment-zwo",
  }));
  const client: DesktopChatAttachmentClient = {
    composer: vi.fn(async () => capabilities(images)),
    admitPath,
    admitPasted: vi.fn(async ({ selectionId, displayName }) => ({
      selectionId,
      displayName,
      status: "accepted" as const,
      attachmentId: "attachment-paste",
    })),
  };
  const clipboard = {
    readImage: vi.fn(() => ({
      isEmpty: () => false,
      toPNG: () => Buffer.from([137, 80, 78, 71]),
    })),
  };
  const dispose = installDesktopChatAttachmentIpc({
    ipcMain: ipcMain as never,
    currentWindow: () => window as never,
    dialog,
    clipboard: clipboard as never,
    client: () => client,
  });
  return {
    handlers,
    ipcMain,
    dialog,
    client,
    admitPath,
    clipboard,
    dispose,
    trusted: { sender: webContents, senderFrame: mainFrame },
  };
}

beforeEach(() => vi.clearAllMocks());

await initializeDesktopLanguage();

describe("desktop Chat attachment IPC", () => {
  it("resolves capabilities before the picker and keeps native paths in Desktop main", async () => {
    const value = setup(false);
    const result = await value.handlers.get(DESKTOP_CHAT_ATTACHMENT_PICK_CHANNEL)!(value.trusted);

    expect(value.client.composer).toHaveBeenCalledOnce();
    expect(value.dialog.showOpenDialog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        filters: [
          {
            name: "Supported files",
            extensions: ["pdf", "txt", "csv", "docx", "fit", "tcx", "gpx", "zwo", "erg", "mrc"],
          },
        ],
      }),
    );
    expect(value.client.admitPath).toHaveBeenNthCalledWith(
      1,
      "/private/ride.fit",
      expect.any(String),
      "picker",
    );
    expect(JSON.stringify(result)).not.toContain("/private/");
  });

  it("admits drop paths and clipboard PNG bytes only through privileged Coach calls", async () => {
    const value = setup();
    await expect(
      value.handlers.get(DESKTOP_CHAT_ATTACHMENT_DROP_CHANNEL)!(value.trusted, [
        "/private/ride.fit",
      ]),
    ).resolves.toMatchObject([{ status: "accepted", attachmentId: "attachment-fit" }]);
    expect(value.client.admitPath).toHaveBeenCalledWith(
      "/private/ride.fit",
      expect.any(String),
      "drop",
    );

    const pasted = await value.handlers.get(DESKTOP_CHAT_ATTACHMENT_PASTE_CHANNEL)!(value.trusted);
    expect(value.client.admitPasted).toHaveBeenCalledWith({
      selectionId: expect.any(String),
      displayName: "Pasted image.png",
      dataBase64: Buffer.from([137, 80, 78, 71]).toString("base64"),
    });
    expect(JSON.stringify(pasted)).not.toContain("dataBase64");
  });

  it("admits only the first five native picker paths when the operating system returns more", async () => {
    const paths = Array.from({ length: 6 }, (_, index) => `/private/ride-${index + 1}.fit`);
    const value = setup(true, paths);

    await expect(
      value.handlers.get(DESKTOP_CHAT_ATTACHMENT_PICK_CHANNEL)!(value.trusted),
    ).resolves.toHaveLength(5);
    expect(value.client.admitPath).toHaveBeenCalledTimes(5);
    expect(value.admitPath.mock.calls.map(([path]) => path)).toEqual(paths.slice(0, 5));
    expect(value.admitPath.mock.calls.map(([, selectionId]) => selectionId)).toHaveLength(5);
    expect(new Set(value.admitPath.mock.calls.map(([, selectionId]) => selectionId)).size).toBe(5);
  });

  it("rejects untrusted, malformed, and over-limit requests before admission", async () => {
    const value = setup();
    const drop = value.handlers.get(DESKTOP_CHAT_ATTACHMENT_DROP_CHANNEL)!;
    await expect(drop({ sender: {}, senderFrame: {} }, ["/private/ride.fit"])).rejects.toThrow(
      "untrusted desktop attachment request",
    );
    await expect(drop(value.trusted, ["relative.fit"])).rejects.toThrow();
    await expect(
      drop(
        value.trusted,
        Array.from({ length: 6 }, (_, index) => `/private/${index}.fit`),
      ),
    ).rejects.toThrow();
    expect(value.client.admitPath).not.toHaveBeenCalled();
  });

  it("removes exactly the three registered handlers", () => {
    const value = setup();
    value.dispose();
    value.dispose();
    expect(value.ipcMain.removeHandler.mock.calls).toEqual([
      [DESKTOP_CHAT_ATTACHMENT_PICK_CHANNEL],
      [DESKTOP_CHAT_ATTACHMENT_DROP_CHANNEL],
      [DESKTOP_CHAT_ATTACHMENT_PASTE_CHANNEL],
    ]);
  });
});
