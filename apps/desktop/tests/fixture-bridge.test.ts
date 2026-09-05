import { afterEach, describe, expect, it } from "vitest";
import {
  createBridgeScript,
  parseFixtureConnection,
  startFixtureBridge,
} from "./helpers/fixture-bridge.js";

const bridges: Awaited<ReturnType<typeof startFixtureBridge>>[] = [];
afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
});

describe("desktop fixture callback bridge", () => {
  it("preserves mutable callback state across utility requests and rejects unauthenticated requests", async () => {
    let calls = 0;
    const bridge = await startFixtureBridge({
      script: { onRequest: () => [JSON.stringify({ result: ++calls })] },
    });
    bridges.push(bridge);
    const script = createBridgeScript(parseFixtureConnection(JSON.stringify(bridge.connection)));
    expect(await script.onRequest({ method: "getAthleteState" })).toEqual(['{"result":1}']);
    expect(await script.onRequest({ method: "getAthleteState" })).toEqual(['{"result":2}']);
    expect(
      (await fetch(`${bridge.connection.origin}/request`, { method: "POST", body: "{}" })).status,
    ).toBe(401);
    expect(calls).toBe(2);
    expect(script.onStreamRequest).toBeUndefined();
  });

  it("delivers streaming events before the callback completes", async () => {
    let finish: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const bridge = await startFixtureBridge({
      script: {
        onRequest: () => [],
        async onStreamRequest(_request, emit) {
          emit('{"event":"started"}');
          await pending;
          return '{"result":"finished"}';
        },
      },
    });
    bridges.push(bridge);
    const script = createBridgeScript(bridge.connection);
    const events: string[] = [];
    const result = await script.onStreamRequest?.({}, (frame) => {
      events.push(frame);
      finish?.();
    });
    expect(events).toEqual(['{"event":"started"}']);
    expect(result).toBe('{"result":"finished"}');
  });

  it("propagates callback failure without sending exception text over the bridge", async () => {
    const bridge = await startFixtureBridge({
      script: {
        onRequest: () => {
          throw new Error("synthetic-private-detail");
        },
      },
    });
    bridges.push(bridge);
    await expect(createBridgeScript(bridge.connection).onRequest({})).rejects.toThrow(
      "desktop fixture request failed",
    );
  });

  it("rejects non-loopback and malformed connection metadata", () => {
    for (const value of [
      undefined,
      "{}",
      JSON.stringify({
        origin: "https://example.com",
        token: "a".repeat(43),
        streaming: false,
        routeChatAttachmentComposer: false,
        routeChatAttachmentOperations: false,
      }),
    ]) {
      expect(() => parseFixtureConnection(value)).toThrow();
    }
  });
});
