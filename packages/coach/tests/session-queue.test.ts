import { describe, expect, it, vi } from "vitest";
import {
  DetachedSessionRequestError,
  createSessionRequestQueue,
} from "../src/daemon/session-queue.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("session request queue", () => {
  it("runs the same key in FIFO order and different keys independently", async () => {
    const queue = createSessionRequestQueue();
    const first = deferred<string>();
    const order: string[] = [];
    const firstResult = queue.run({
      key: "a",
      signal: new AbortController().signal,
      run: () => {
        order.push("a1-start");
        return first.promise;
      },
    });
    const secondResult = queue.run({
      key: "a",
      signal: new AbortController().signal,
      run: async () => {
        order.push("a2-start");
        return "second";
      },
    });
    const otherResult = queue.run({
      key: "b",
      signal: new AbortController().signal,
      run: async () => {
        order.push("b-start");
        return "other";
      },
    });
    expect(order).toEqual(["a1-start", "b-start"]);
    expect(queue.activeKeyCount).toBe(2);
    first.resolve("first");
    await expect(firstResult).resolves.toBe("first");
    await expect(secondResult).resolves.toBe("second");
    await expect(otherResult).resolves.toBe("other");
    expect(order).toEqual(["a1-start", "b-start", "a2-start"]);
    expect(queue.activeKeyCount).toBe(0);
  });

  it("removes pre-aborted and queued-aborted requests without calling run", async () => {
    const queue = createSessionRequestQueue();
    const pre = new AbortController();
    pre.abort();
    const preRun = vi.fn(async () => "unused");
    await expect(queue.run({ key: "pre", signal: pre.signal, run: preRun })).rejects.toBeInstanceOf(
      DetachedSessionRequestError,
    );
    expect(preRun).not.toHaveBeenCalled();

    const first = deferred<void>();
    const queued = new AbortController();
    const head = queue.run({
      key: "same",
      signal: new AbortController().signal,
      run: () => first.promise,
    });
    const queuedRun = vi.fn(async () => "unused");
    const tail = queue.run({ key: "same", signal: queued.signal, run: queuedRun });
    queued.abort();
    await expect(tail).rejects.toBeInstanceOf(DetachedSessionRequestError);
    expect(queuedRun).not.toHaveBeenCalled();
    first.resolve();
    await head;
    expect(queue.activeKeyCount).toBe(0);
  });

  it("detaches in-flight delivery without cancelling or replaying work", async () => {
    const queue = createSessionRequestQueue();
    const controller = new AbortController();
    const work = deferred<object>();
    const run = vi.fn(() => work.promise);
    const result = queue.run({ key: "a", signal: controller.signal, run });
    controller.abort();
    expect(run).toHaveBeenCalledTimes(1);
    work.resolve({ done: true });
    await expect(result).rejects.toBeInstanceOf(DetachedSessionRequestError);
    expect(run).toHaveBeenCalledTimes(1);
    expect(queue.activeKeyCount).toBe(0);
  });

  it("preserves original result and error identity and removes abort listeners", async () => {
    const queue = createSessionRequestQueue();
    const result = { identity: true };
    const failure = new Error("identity");
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    await expect(
      queue.run({
        key: "result",
        signal: controller.signal,
        run: async () => result,
      }),
    ).resolves.toBe(result);
    await expect(
      queue.run({
        key: "error",
        signal: new AbortController().signal,
        run: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0]?.[1]).toBe(add.mock.calls[0]?.[1]);
    expect(queue.activeKeyCount).toBe(0);
  });

  it("does not let an old settlement delete a replacement key queue", async () => {
    const queue = createSessionRequestQueue();
    const first = deferred<void>();
    const second = deferred<void>();
    const firstResult = queue.run({
      key: "key",
      signal: new AbortController().signal,
      run: () => first.promise,
    });
    const secondResult = queue.run({
      key: "key",
      signal: new AbortController().signal,
      run: () => second.promise,
    });
    first.resolve();
    await firstResult;
    expect(queue.activeKeyCount).toBe(1);
    second.resolve();
    await secondResult;
    expect(queue.activeKeyCount).toBe(0);
  });
});
