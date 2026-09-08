import { describe, expect, it } from "vitest";
import type { ResolvedCs } from "@enduragent/kernel/reference/cs-resolution";
import { withSessionLock } from "../src/agent/session-lock.js";
import { createTurnContext } from "../src/agent/turn-context.js";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("per-session ordering", () => {
  it("runs A1, A2, A3 in FIFO order while B completes independently", async () => {
    const gate = deferred();
    const order: string[] = [];
    const a1 = withSessionLock("ordering-A", async () => {
      order.push("A1-start");
      await gate.promise;
      order.push("A1-end");
    });
    const a2 = withSessionLock("ordering-A", async () => {
      order.push("A2-start", "A2-end");
    });
    const a3 = withSessionLock("ordering-A", async () => {
      order.push("A3-start", "A3-end");
    });
    const b = withSessionLock("ordering-B", async () => {
      order.push("B-start", "B-end");
    });
    await b;
    expect(order).toEqual(["A1-start", "B-start", "B-end"]);
    gate.resolve();
    await Promise.all([a1, a2, a3]);
    expect(order).toEqual([
      "A1-start",
      "B-start",
      "B-end",
      "A1-end",
      "A2-start",
      "A2-end",
      "A3-start",
      "A3-end",
    ]);
  });

  it("starts A2 after A1 rejects", async () => {
    const gate = deferred();
    const order: string[] = [];
    const a1 = withSessionLock("reject-A", async () => {
      order.push("A1");
      await gate.promise;
    });
    const a2 = withSessionLock("reject-A", async () => {
      order.push("A2");
    });
    gate.reject(new Error("A1 failed"));
    await expect(a1).rejects.toThrow("A1 failed");
    await a2;
    expect(order).toEqual(["A1", "A2"]);
  });

  it("queues reset behind chat for one session without blocking another", async () => {
    const gate = deferred();
    const order: string[] = [];
    const chatA = withSessionLock("reset-A", async () => {
      order.push("chat-A");
      await gate.promise;
    });
    const resetA = withSessionLock("reset-A", async () => {
      order.push("reset-A");
    });
    await withSessionLock("reset-B", async () => {
      order.push("reset-B");
    });
    expect(order).toEqual(["chat-A", "reset-B"]);
    gate.resolve();
    await Promise.all([chatA, resetA]);
    expect(order).toEqual(["chat-A", "reset-B", "reset-A"]);
  });

  it("keeps context, read cache, writes, and running anchors isolated", () => {
    const anchorA: ResolvedCs = {
      criticalSpeedMps: 4,
      source: "platform",
      confidence: "high",
    };
    const anchorB: ResolvedCs = {
      criticalSpeedMps: 5,
      source: "platform",
      confidence: "high",
    };
    const contextA = createTurnContext({
      language: { language: "en", source: "default", locale: "en-GB" },
      resolvedCs: anchorA,
    });
    const contextB = createTurnContext({
      language: { language: "en", source: "default", locale: "en-GB" },
      resolvedCs: anchorB,
    });
    contextA.readToolCache.set("probe", "A");
    contextA.turnWrites.writesCommitted = 1;
    expect(contextA).not.toBe(contextB);
    expect(contextB.readToolCache.has("probe")).toBe(false);
    expect(contextB.turnWrites.writesCommitted).toBe(0);
    expect(contextA.resolvedCs).toBe(anchorA);
    expect(contextB.resolvedCs).toBe(anchorB);
  });
});
