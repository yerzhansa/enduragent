import type { IpcMain, IpcMainInvokeEvent } from "electron";
import {
  ATHLETE_FEEDBACK_ENDPOINT,
  submitFeedback,
  type FeedbackRequestInit,
  type SubmitFeedbackResult,
} from "@enduragent/coach-contract";
import { DESKTOP_ATHLETE_FEEDBACK_CHANNEL } from "./constants.js";

export type DesktopAthleteFeedbackRequest = (
  url: string,
  init: FeedbackRequestInit,
) => Promise<{ readonly status: number }>;

function parseFeedbackText(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("invalid desktop athlete feedback request");
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "text") {
    throw new TypeError("invalid desktop athlete feedback request");
  }
  const text = (value as { readonly text: unknown }).text;
  if (typeof text !== "string") {
    throw new TypeError("invalid desktop athlete feedback request");
  }
  return text;
}

export function installDesktopAthleteFeedbackIpc(input: {
  readonly ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  readonly isTrusted: (event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">) => boolean;
  readonly request: DesktopAthleteFeedbackRequest;
  readonly randomUUID?: () => string;
}): () => void {
  const mintId = input.randomUUID ?? (() => globalThis.crypto.randomUUID());
  const handler = async (
    event: IpcMainInvokeEvent,
    ...args: unknown[]
  ): Promise<SubmitFeedbackResult> => {
    if (!input.isTrusted(event)) throw new Error("untrusted desktop athlete feedback request");
    if (args.length !== 1) throw new TypeError("invalid desktop athlete feedback request");
    const text = parseFeedbackText(args[0]);
    return submitFeedback({
      channel: "desktop",
      id: mintId().toLowerCase(),
      text,
      request: async (url, init) => {
        if (url !== ATHLETE_FEEDBACK_ENDPOINT) {
          throw new TypeError("invalid desktop athlete feedback request");
        }
        return input.request(url, init);
      },
    });
  };
  input.ipcMain.handle(DESKTOP_ATHLETE_FEEDBACK_CHANNEL, handler);
  return () => {
    input.ipcMain.removeHandler(DESKTOP_ATHLETE_FEEDBACK_CHANNEL);
  };
}
