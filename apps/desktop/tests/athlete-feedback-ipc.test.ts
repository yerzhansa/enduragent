import { describe, expect, it, vi } from "vitest";
import {
  ATHLETE_FEEDBACK_ENDPOINT,
  type FeedbackRequestInit,
} from "@enduragent/coach-contract";
import { DESKTOP_ATHLETE_FEEDBACK_CHANNEL } from "../src/main/constants.js";
import { installDesktopAthleteFeedbackIpc } from "../src/main/athlete-feedback-ipc.js";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

const ID = "a1b2c3d4-e5f6-4789-a012-3456789abcde";

function setup(
  request: (url: string, init: FeedbackRequestInit) => Promise<{ status: number }> = async () => ({
    status: 204,
  }),
) {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  };
  const trusted = { sender: {}, senderFrame: {} };
  const isTrusted = vi.fn((event: unknown) => event === trusted);
  const mailbox = vi.fn(request);
  const dispose = installDesktopAthleteFeedbackIpc({
    ipcMain: ipcMain as never,
    isTrusted: isTrusted as never,
    request: mailbox,
    randomUUID: () => ID.toUpperCase(),
  });
  return { dispose, handlers, mailbox, trusted };
}

describe("desktop athlete feedback IPC", () => {
  it("posts trusted text through net.fetch and returns 204 as ok", async () => {
    const state = setup();
    const handler = state.handlers.get(DESKTOP_ATHLETE_FEEDBACK_CHANNEL);
    if (handler === undefined) throw new Error("missing handler");

    await expect(handler(state.trusted, { text: "the watts look high" })).resolves.toEqual({
      ok: true,
    });

    expect(state.mailbox).toHaveBeenCalledOnce();
    expect(state.mailbox.mock.calls[0]?.[0]).toBe(ATHLETE_FEEDBACK_ENDPOINT);
    expect(JSON.parse(String(state.mailbox.mock.calls[0]?.[1]?.body))).toEqual({
      channel: "desktop",
      id: ID,
      text: "the watts look high",
    });
  });

  it("rejects untrusted senders and malformed payloads without posting", async () => {
    const state = setup();
    const handler = state.handlers.get(DESKTOP_ATHLETE_FEEDBACK_CHANNEL);
    if (handler === undefined) throw new Error("missing handler");

    await expect(handler({ sender: {}, senderFrame: {} }, { text: "nope" })).rejects.toThrow(
      "untrusted desktop athlete feedback request",
    );
    await expect(handler(state.trusted)).rejects.toThrow("invalid desktop athlete feedback request");
    await expect(handler(state.trusted, { text: "ok" }, "extra")).rejects.toThrow(
      "invalid desktop athlete feedback request",
    );
    await expect(handler(state.trusted, { text: 1 })).rejects.toThrow(
      "invalid desktop athlete feedback request",
    );
    expect(state.mailbox).not.toHaveBeenCalled();
  });

  it("maps a network failure to unavailable", async () => {
    const state = setup(async () => {
      throw new Error("offline");
    });
    const handler = state.handlers.get(DESKTOP_ATHLETE_FEEDBACK_CHANNEL);
    if (handler === undefined) throw new Error("missing handler");

    await expect(handler(state.trusted, { text: "the watts look high" })).resolves.toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("removes the handler on dispose", () => {
    const state = setup();
    state.dispose();
    expect(state.handlers.has(DESKTOP_ATHLETE_FEEDBACK_CHANNEL)).toBe(false);
  });
});
