import { desktopPhrasebook, refreshDesktopLanguage } from "./language.js";
import { randomUUID } from "node:crypto";
import { connectCoachClient, type CoachClient } from "@enduragent/coach-client";
import {
  AttachmentAdmissionReadModelSchema,
  ChatAttachmentComposerReadModelSchema,
  CHAT_ATTACHMENT_LIMITS,
  PlatformAbsolutePathSchema,
  type AttachmentAdmissionReadModel,
  type ChatAttachmentComposerReadModel,
} from "@enduragent/coach-contract";
import { z } from "zod";
import type {
  BrowserWindow,
  Clipboard,
  IpcMain,
  IpcMainInvokeEvent,
  OpenDialogOptions,
} from "electron";
import {
  DESKTOP_CHAT_ATTACHMENT_DROP_CHANNEL,
  DESKTOP_CHAT_ATTACHMENT_PASTE_CHANNEL,
  DESKTOP_CHAT_ATTACHMENT_PICK_CHANNEL,
} from "./constants.js";
import { isTrustedConnectionRequest } from "./security.js";

const CHAT_ID = "desktop" as const;
const DroppedPathsSchema = z
  .array(PlatformAbsolutePathSchema)
  .min(1)
  .max(CHAT_ATTACHMENT_LIMITS.attachmentsPerMessage);

export interface DesktopChatAttachmentClient {
  composer(): Promise<ChatAttachmentComposerReadModel>;
  admitPath(
    path: string,
    selectionId: string,
    source: "picker" | "drop",
  ): Promise<AttachmentAdmissionReadModel>;
  admitPasted(input: {
    readonly selectionId: string;
    readonly displayName: string;
    readonly dataBase64: string;
  }): Promise<AttachmentAdmissionReadModel>;
}

export function createConnectionChatAttachmentClient(
  connection: Readonly<{
    url: `ws://127.0.0.1:${number}/rpc`;
    token: string;
    athleteHome: string;
  }>,
  connect: typeof connectCoachClient = connectCoachClient,
): DesktopChatAttachmentClient {
  const call = async <T>(operation: (client: CoachClient) => Promise<T>): Promise<T> => {
    const client = await connect({
      url: connection.url,
      token: connection.token,
      expectedAthleteHome: connection.athleteHome,
    });
    try {
      return await operation(client);
    } finally {
      await client.close();
    }
  };
  return Object.freeze({
    composer: () => call((client) => client.call("getChatAttachmentComposer", { chatId: CHAT_ID })),
    admitPath: (path: string, selectionId: string, source: "picker" | "drop") =>
      call((client) =>
        client.call("admitChatAttachment", {
          chatId: CHAT_ID,
          selectionId,
          source,
          candidate: { kind: "native-path", sourcePath: path },
        }),
      ),
    admitPasted: (input: {
      readonly selectionId: string;
      readonly displayName: string;
      readonly dataBase64: string;
    }) => call((client) => client.call("admitPastedChatAttachment", { chatId: CHAT_ID, ...input })),
  });
}

export interface ChatAttachmentDialogPort {
  showOpenDialog(
    window: BrowserWindow,
    options: OpenDialogOptions,
  ): Promise<{ readonly canceled: boolean; readonly filePaths: readonly string[] }>;
}

function pickerOptions(
  capabilities: ChatAttachmentComposerReadModel["capabilities"],
): OpenDialogOptions {
  const extensions = [
    ...capabilities.documents.extensions,
    ...capabilities.completedActivities.extensions,
    ...capabilities.plannedWorkouts.extensions,
    ...(capabilities.images.enabled ? ["png", "jpg", "jpeg", "webp"] : []),
  ];
  return {
    title: desktopPhrasebook().say("desktop.filePicker.attachTitle"),
    buttonLabel: desktopPhrasebook().say("desktop.filePicker.attach"),
    properties: ["openFile", "multiSelections"],
    filters: [{ name: desktopPhrasebook().say("desktop.filePicker.supportedFiles"), extensions }],
  };
}

async function admitPaths(
  client: DesktopChatAttachmentClient,
  paths: readonly string[],
  source: "picker" | "drop",
): Promise<readonly AttachmentAdmissionReadModel[]> {
  const results: AttachmentAdmissionReadModel[] = [];
  for (const path of paths.slice(0, CHAT_ATTACHMENT_LIMITS.attachmentsPerMessage)) {
    results.push(
      AttachmentAdmissionReadModelSchema.parse(await client.admitPath(path, randomUUID(), source)),
    );
  }
  return results;
}

export function installDesktopChatAttachmentIpc(input: {
  readonly ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  readonly currentWindow: () => BrowserWindow | undefined;
  readonly dialog: ChatAttachmentDialogPort;
  readonly clipboard: Pick<Clipboard, "readImage">;
  readonly client: () => DesktopChatAttachmentClient | undefined;
}): () => void {
  const trustedWindow = (event: IpcMainInvokeEvent): BrowserWindow => {
    const window = input.currentWindow();
    if (window === undefined || !isTrustedConnectionRequest(event, window)) {
      throw new Error("untrusted desktop attachment request");
    }
    return window;
  };

  input.ipcMain.handle(DESKTOP_CHAT_ATTACHMENT_PICK_CHANNEL, async (event, ...args) => {
    const window = trustedWindow(event);
    if (args.length !== 0) throw new TypeError("invalid attachment picker request");
    const client = input.client();
    if (client === undefined) return [];
    const capabilities = ChatAttachmentComposerReadModelSchema.parse(
      await client.composer(),
    ).capabilities;
    const selection = await refreshDesktopLanguage().then(() =>
      input.dialog.showOpenDialog(window, pickerOptions(capabilities)),
    );
    if (selection.canceled || selection.filePaths.length === 0) return [];
    const paths = DroppedPathsSchema.parse(
      selection.filePaths.slice(0, CHAT_ATTACHMENT_LIMITS.attachmentsPerMessage),
    );
    return admitPaths(client, paths, "picker");
  });

  input.ipcMain.handle(DESKTOP_CHAT_ATTACHMENT_DROP_CHANNEL, async (event, ...args) => {
    trustedWindow(event);
    if (args.length !== 1) throw new TypeError("invalid attachment drop request");
    const paths = DroppedPathsSchema.parse(args[0]);
    const client = input.client();
    return client === undefined ? [] : admitPaths(client, paths, "drop");
  });

  input.ipcMain.handle(DESKTOP_CHAT_ATTACHMENT_PASTE_CHANNEL, async (event, ...args) => {
    trustedWindow(event);
    if (args.length !== 0) throw new TypeError("invalid attachment paste request");
    const client = input.client();
    if (client === undefined) return [];
    const image = input.clipboard.readImage();
    if (image.isEmpty()) return [];
    const bytes = image.toPNG();
    await refreshDesktopLanguage();
    const result = await client.admitPasted({
      selectionId: randomUUID(),
      displayName: desktopPhrasebook().say("desktop.filePicker.pastedImage", { extension: ".png" }),
      dataBase64: bytes.toString("base64"),
    });
    return [AttachmentAdmissionReadModelSchema.parse(result)];
  });

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    input.ipcMain.removeHandler(DESKTOP_CHAT_ATTACHMENT_PICK_CHANNEL);
    input.ipcMain.removeHandler(DESKTOP_CHAT_ATTACHMENT_DROP_CHANNEL);
    input.ipcMain.removeHandler(DESKTOP_CHAT_ATTACHMENT_PASTE_CHANNEL);
  };
}
