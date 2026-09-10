import { desktopPhrasebook, refreshDesktopLanguage } from "./language.js";
import { connectCoachClient, type CoachClient } from "@enduragent/coach-client";
import {
  DesktopTrainingExportRequestSchema,
  DesktopTrainingExportResultSchema,
  ExportTrainingFileRpcParamsSchema,
  ExportTrainingFileRpcResultSchema,
  type DesktopTrainingExportRequest,
  type DesktopTrainingExportResult,
  type ExportTrainingFileRpcParams,
  type ExportTrainingFileRpcResult,
} from "@enduragent/coach-contract";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, SaveDialogOptions } from "electron";
import { DESKTOP_TRAINING_EXPORT_CHANNEL } from "./constants.js";
import { createSafeLog } from "./safe-log.js";
import { isTrustedConnectionRequest } from "./security.js";

export interface DesktopTrainingExporter {
  export(request: ExportTrainingFileRpcParams): Promise<ExportTrainingFileRpcResult>;
}

export interface TrainingExportDialogPort {
  showSaveDialog(
    window: BrowserWindow,
    options: SaveDialogOptions,
  ): Promise<{ readonly canceled: boolean; readonly filePath?: string }>;
}

export function createConnectionTrainingExporter(
  connection: Readonly<{
    url: `ws://127.0.0.1:${number}/rpc`;
    token: string;
    athleteHome: string;
  }>,
  connect: typeof connectCoachClient = connectCoachClient,
): DesktopTrainingExporter {
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
    export(request: ExportTrainingFileRpcParams) {
      return call((client) => client.call("exportTrainingFile", request));
    },
  });
}

function saveDialogOptions(request: DesktopTrainingExportRequest): SaveDialogOptions {
  if (request.kind === "activity") {
    const extension = request.format;
    return {
      title: desktopPhrasebook().say("desktop.filePicker.exportRideTitle", {
        format: extension.toUpperCase(),
      }),
      defaultPath: `ride-${request.localDate}.${extension}`,
      filters: [
        {
          name: desktopPhrasebook().say("desktop.filePicker.activityFormat", {
            format: extension.toUpperCase(),
          }),
          extensions: [extension],
        },
      ],
      properties: ["createDirectory", "showOverwriteConfirmation"],
    };
  }
  return {
    title: desktopPhrasebook().say("desktop.filePicker.exportWorkoutsTitle", {
      format: request.format.toUpperCase(),
    }),
    defaultPath: `cycling-workouts-${request.oldest}-to-${request.newest}-${request.format}.zip`,
    filters: [
      { name: desktopPhrasebook().say("desktop.filePicker.workoutArchive"), extensions: ["zip"] },
    ],
    properties: ["createDirectory", "showOverwriteConfirmation"],
  };
}

function rpcRequest(
  request: DesktopTrainingExportRequest,
  destinationPath: string,
): ExportTrainingFileRpcParams {
  return request.kind === "activity"
    ? {
        kind: "activity",
        canonicalActivityId: request.canonicalActivityId,
        format: request.format,
        destinationPath,
      }
    : {
        kind: "workout-archive",
        oldest: request.oldest,
        newest: request.newest,
        format: request.format,
        destinationPath,
      };
}

function refusedWrite(): DesktopTrainingExportResult {
  return { status: "refused", reason: "write-failed" };
}

export function installDesktopTrainingExportIpc(input: {
  readonly ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  readonly currentWindow: () => BrowserWindow | undefined;
  readonly dialog: TrainingExportDialogPort;
  readonly exporter: () => DesktopTrainingExporter | undefined;
  readonly log?: (message: string) => void;
}): () => void {
  const log = createSafeLog(input.log);
  input.ipcMain.handle(
    DESKTOP_TRAINING_EXPORT_CHANNEL,
    async (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<DesktopTrainingExportResult> => {
      if (!isTrustedConnectionRequest(event, input.currentWindow())) {
        throw new Error("untrusted desktop training export request");
      }
      const parsed =
        args.length === 1 ? DesktopTrainingExportRequestSchema.safeParse(args[0]) : null;
      if (parsed === null || !parsed.success)
        throw new TypeError("invalid training export request");
      const window = input.currentWindow();
      if (window === undefined || input.exporter() === undefined) return refusedWrite();
      let selection: Awaited<ReturnType<TrainingExportDialogPort["showSaveDialog"]>>;
      try {
        await refreshDesktopLanguage();
        selection = await input.dialog.showSaveDialog(window, saveDialogOptions(parsed.data));
      } catch {
        log("desktop-training-export-failed stage=dialog");
        return refusedWrite();
      }
      if (selection.canceled || selection.filePath === undefined) return { status: "cancelled" };
      try {
        const exporter = input.exporter();
        if (exporter === undefined) return refusedWrite();
        const request = ExportTrainingFileRpcParamsSchema.parse(
          rpcRequest(parsed.data, selection.filePath),
        );
        const result = ExportTrainingFileRpcResultSchema.parse(await exporter.export(request));
        return DesktopTrainingExportResultSchema.parse(
          result.status === "exported"
            ? { status: "saved", byteLength: result.byteLength }
            : result,
        );
      } catch {
        log("desktop-training-export-failed stage=operation");
        return refusedWrite();
      }
    },
  );
  return () => {
    input.ipcMain.removeHandler(DESKTOP_TRAINING_EXPORT_CHANNEL);
  };
}
