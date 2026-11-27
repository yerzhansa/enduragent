import type { IntervalsOAuthGrant, IntervalsSignInOptions } from "@enduragent/core";
import { IntervalsSignInError } from "@enduragent/core";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { DESKTOP_INTERVALS_SIGN_IN_CHANNEL } from "../src/main/constants.js";
import { installDesktopIntervalsIpc } from "../src/main/intervals-ipc.js";
import { createDesktopRendererUrl } from "../src/main/renderer-navigation.js";

const RENDERER_URL = createDesktopRendererUrl("n".repeat(43));

function windowSender() {
  const state = { destroyed: false };
  return {
    state,
    sender: Object.assign(new EventEmitter(), {
      send: vi.fn(),
      isDestroyed: () => state.destroyed,
      get mainFrame() {
        if (state.destroyed) throw new TypeError("Object has been destroyed");
        return { url: RENDERER_URL };
      },
    }),
  };
}

function install() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const sessions: IntervalsSignInOptions[] = [];
  const signIn = (options: IntervalsSignInOptions) => {
    sessions.push(options);
    return new Promise<IntervalsOAuthGrant>((_resolve, reject) => {
      options.signal?.addEventListener(
        "abort",
        () => reject(new IntervalsSignInError("cancelled")),
        {
          once: true,
        },
      );
    });
  };
  const status = { slot: "intervals-icu", state: "missing", runtimeState: null } as const;
  const dispose = installDesktopIntervalsIpc({
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler as never),
      removeHandler: () => undefined,
    },
    openExternal: async () => undefined,
    signIn,
    isTrusted: () => true,
    signal: new AbortController().signal,
    vault: {
      credentialStatuses: async () => [status],
      runExclusiveMutation: async () => {
        throw new TypeError("not reached");
      },
    } as never,
    verifyCredential: async () => ({ status: "verified" }) as never,
  });
  const signInFrom = (sender: ReturnType<typeof windowSender>["sender"]) =>
    handlers.get(DESKTOP_INTERVALS_SIGN_IN_CHANNEL)!({ sender, senderFrame: {} });
  return { sessions, signInFrom, dispose };
}

describe("repro intervals bug 7: signing in again after the window crashed", () => {
  it("a sign-in left by a crashed window does not block the reopened window's sign-in", async () => {
    const ipc = install();
    const first = windowSender();
    const abandoned = Promise.resolve(ipc.signInFrom(first.sender)).catch(
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(ipc.sessions).toHaveLength(1));
    ipc.sessions[0]!.onPhase?.("waiting-for-browser" as never);

    first.state.destroyed = true;
    first.sender.emit("destroyed");
    const reopened = windowSender();
    const second = Promise.resolve(ipc.signInFrom(reopened.sender)).catch(
      (error: unknown) => error,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    const outcome = await Promise.race([
      second.then((value) => (value instanceof Error ? `refused: ${value.message}` : "settled")),
      new Promise<string>((resolve) => setTimeout(() => resolve("started"), 100)),
    ]);
    expect(
      { outcome, sessionsStarted: ipc.sessions.length },
      "the reopened window's sign-in",
    ).toEqual({ outcome: "started", sessionsStarted: 2 });
    for (const session of ipc.sessions) session.signal?.dispatchEvent(new Event("abort"));
    await ipc.dispose();
    void abandoned;
  });
});
