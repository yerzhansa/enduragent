import { CoachClientDisconnectedError, type CoachClient } from "@enduragent/coach-client";
import type { SpendSummary } from "@enduragent/coach-contract";
import { describe, expect, it, vi } from "vitest";
import type { DesktopCoachClientProvider } from "../src/coach-client";
import {
  INITIAL_SPEND_METER_STATE,
  SPEND_REFRESH_INTERVAL_MS,
  createSpendMeterController,
  type SpendMeterState,
  type SpendMeterView,
} from "../src/spend-meter/controller";

function spend(overrides: Partial<SpendSummary> = {}): SpendSummary {
  return {
    localDate: "1998-07-06",
    timezone: "UTC",
    dailyCapUsd: 0.5,
    knownSpendUsd: 0.14,
    generationCount: 1,
    pricedGenerationCount: 1,
    unpricedGenerationCount: 0,
    malformedLineCount: 0,
    spendComplete: true,
    capStatus: "below",
    cacheReadTokens: 400,
    knownCacheReadSavingsUsd: 0.03,
    cacheSavingsComplete: true,
    routes: [
      {
        provider: "anthropic",
        model: "synthetic-model",
        generationCount: 1,
        pricedGenerationCount: 1,
        unpricedGenerationCount: 0,
        providerReportedGenerationCount: 0,
        knownSpendUsd: 0.14,
        cacheReadTokens: 400,
        cacheReadSavingsUsd: 0.03,
        caching: "explicit",
        disclosure: null,
      },
    ],
    ...overrides,
  };
}

function provider(call: CoachClient["call"]): DesktopCoachClientProvider {
  const client = {
    handshake: {} as CoachClient["handshake"],
    call,
    close: vi.fn(async () => {}),
  } as CoachClient;
  return {
    getClient: vi.fn(async () => client),
    reconnect: vi.fn(async () => client),
    close: vi.fn(async () => {}),
  };
}

function reconnectingProvider(
  call: CoachClient["call"],
  reconnectedCall: CoachClient["call"],
): DesktopCoachClientProvider {
  const initial = {
    handshake: {} as CoachClient["handshake"],
    call,
    close: vi.fn(async () => {}),
  } as CoachClient;
  const reconnected = {
    handshake: {} as CoachClient["handshake"],
    call: reconnectedCall,
    close: vi.fn(async () => {}),
  } as CoachClient;
  return {
    getClient: vi.fn(async () => initial),
    reconnect: vi.fn(async () => reconnected),
    close: vi.fn(async () => {}),
  };
}

function fakeView() {
  let state: SpendMeterState = INITIAL_SPEND_METER_STATE;
  let handlers:
    | {
        readonly onChangeCap: (value: string) => void;
        readonly onCommitCap: () => void;
        readonly onRetryCap: () => void;
      }
    | undefined;
  const view: SpendMeterView = {
    bind: vi.fn((next) => {
      handlers = next;
    }),
    render: vi.fn((next) => {
      state = next;
    }),
    dispose: vi.fn(),
  };
  return {
    view,
    state: () => state,
    changeCap: (value: string) => handlers?.onChangeCap(value),
    commitCap: () => handlers?.onCommitCap(),
    retryCap: () => handlers?.onRetryCap(),
  };
}

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

async function startedController(call: CoachClient["call"]) {
  const subject = fakeView();
  const controller = createSpendMeterController({
    clients: provider(call),
    view: subject.view,
    setInterval: (() => 1) as never,
    clearInterval: vi.fn() as never,
  });
  controller.start();
  await controller.refresh();
  return { controller, subject };
}

describe("spend controller", () => {
  it("starts once, refreshes every thirty seconds, and keeps last-good data stale", async () => {
    let calls = 0;
    const call = vi.fn(async () => {
      calls += 1;
      if (calls === 2) throw new Error("unavailable");
      return spend();
    }) as unknown as CoachClient["call"];
    const subject = fakeView();
    let intervalCallback: (() => void) | undefined;
    const controller = createSpendMeterController({
      clients: provider(call),
      view: subject.view,
      setInterval: ((callback: () => void, delay: number) => {
        expect(delay).toBe(SPEND_REFRESH_INTERVAL_MS);
        intervalCallback = callback;
        return 2;
      }) as never,
      clearInterval: vi.fn() as never,
    });

    controller.start();
    controller.start();
    await controller.refresh();
    intervalCallback?.();
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2));

    expect(subject.view.bind).toHaveBeenCalledTimes(1);
    expect(subject.state()).toMatchObject({ status: "ready", stale: true });
  });

  it("writes finite positive precision unchanged and no-ops an authoritative value", async () => {
    const calls: Array<{ readonly method: string; readonly value?: number }> = [];
    const call = vi.fn(async (method: string, params: unknown) => {
      if (method === "setDailySpendCap") {
        const value = (params as { readonly dailyCapUsd: number }).dailyCapUsd;
        calls.push({ method, value });
        return spend({ dailyCapUsd: value });
      }
      calls.push({ method });
      return spend({ dailyCapUsd: 0.5 });
    }) as unknown as CoachClient["call"];
    const { controller, subject } = await startedController(call);

    subject.changeCap("0.5");
    await controller.commitCap();
    expect(calls.filter(({ method }) => method === "setDailySpendCap")).toHaveLength(0);
    expect(subject.state().capOperation).toEqual({ kind: "idle" });

    const precise = 0.1234567890123456;
    subject.changeCap(String(precise));
    await controller.commitCap();
    expect(calls.filter(({ method }) => method === "setDailySpendCap")).toEqual([
      { method: "setDailySpendCap", value: precise },
    ]);
    expect(subject.state().summary?.dailyCapUsd).toBe(precise);
  });

  it.each(["", " ", "0", "-1", "1e309", "not-a-number"])(
    "rejects invalid draft %j without an RPC",
    async (draft) => {
      const call = vi.fn(async () => spend()) as unknown as CoachClient["call"];
      const { controller, subject } = await startedController(call);

      subject.changeCap(draft);
      await controller.commitCap();

      expect(call).toHaveBeenCalledTimes(1);
      expect(subject.state().capDraft).toEqual({ kind: "invalid", text: draft });
      expect(subject.state().capOperation).toEqual({ kind: "idle" });
    },
  );

  it("serializes active and latest queued commits without letting a later edit cancel the queue", async () => {
    const first = deferred<SpendSummary>();
    const second = deferred<SpendSummary>();
    const writes: number[] = [];
    const call = vi.fn(async (method: string, params: unknown) => {
      if (method === "getSpendSummary") return spend();
      const value = (params as { readonly dailyCapUsd: number }).dailyCapUsd;
      writes.push(value);
      return value === 0.75 ? first.promise : second.promise;
    }) as unknown as CoachClient["call"];
    const { controller, subject } = await startedController(call);

    subject.changeCap("0.75");
    const saving = controller.commitCap();
    await vi.waitFor(() => expect(writes).toEqual([0.75]));
    subject.changeCap("0.8");
    subject.commitCap();
    subject.changeCap("0.9");
    subject.commitCap();
    subject.changeCap("0.9000");
    first.resolve(spend({ dailyCapUsd: 0.75 }));
    await vi.waitFor(() => expect(writes).toEqual([0.75, 0.9]));
    second.resolve(spend({ dailyCapUsd: 0.9 }));
    await saving;

    expect(subject.state().summary?.dailyCapUsd).toBe(0.9);
    expect(subject.state().capDraft.text).toBe("0.9000");
    expect(subject.state().capOperation).toEqual({ kind: "idle" });
  });

  it("preserves newer uncommitted text when an older response has the same numeric value", async () => {
    const write = deferred<SpendSummary>();
    const call = vi.fn(async (method: string) =>
      method === "getSpendSummary" ? spend() : write.promise,
    ) as unknown as CoachClient["call"];
    const { controller, subject } = await startedController(call);

    subject.changeCap("0.75");
    const saving = controller.commitCap();
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    subject.changeCap("0.7500");
    write.resolve(spend({ dailyCapUsd: 0.75 }));
    await saving;

    expect(subject.state().capDraft.text).toBe("0.7500");
    expect(subject.state().capOperation).toEqual({ kind: "idle" });
  });

  it("accepts a mismatched successful response as authority and keeps the draft for recovery", async () => {
    const call = vi.fn(async (method: string) =>
      method === "getSpendSummary" ? spend() : spend({ dailyCapUsd: 0.6, knownSpendUsd: 0.2 }),
    ) as unknown as CoachClient["call"];
    const { controller, subject } = await startedController(call);

    subject.changeCap("0.75");
    await controller.commitCap();

    expect(subject.state().summary).toMatchObject({ dailyCapUsd: 0.6, knownSpendUsd: 0.2 });
    expect(subject.state().capDraft.text).toBe("0.75");
    expect(subject.state().capOperation).toEqual({ kind: "error", reason: "not-applied" });
  });

  it("reloads authority after an obsolete failure before saving the queued commit", async () => {
    const first = deferred<SpendSummary>();
    const second = deferred<SpendSummary>();
    const trace: string[] = [];
    let reads = 0;
    const call = vi.fn(async (method: string, params: unknown) => {
      if (method === "getSpendSummary") {
        reads += 1;
        trace.push(`read:${reads}`);
        return reads === 1 ? spend() : spend({ dailyCapUsd: 0.75 });
      }
      const value = (params as { readonly dailyCapUsd: number }).dailyCapUsd;
      trace.push(`write:${value}`);
      return value === 0.75 ? first.promise : second.promise;
    }) as unknown as CoachClient["call"];
    const { controller, subject } = await startedController(call);

    subject.changeCap("0.75");
    const saving = controller.commitCap();
    await vi.waitFor(() => expect(trace).toContain("write:0.75"));
    subject.changeCap("0.9");
    subject.commitCap();
    first.reject(new Error("response lost"));
    await vi.waitFor(() => expect(trace).toContain("write:0.9"));
    second.resolve(spend({ dailyCapUsd: 0.9 }));
    await saving;

    expect(trace).toEqual(["read:1", "write:0.75", "read:2", "write:0.9"]);
    expect(subject.state().capOperation).toEqual({ kind: "idle" });
  });

  it("reloads before retry and skips a duplicate write when the failed cap became authoritative", async () => {
    const trace: string[] = [];
    let authority = 0.5;
    const call = vi.fn(async (method: string, params: unknown) => {
      if (method === "getSpendSummary") {
        trace.push(`read:${authority}`);
        return spend({ dailyCapUsd: authority });
      }
      const value = (params as { readonly dailyCapUsd: number }).dailyCapUsd;
      trace.push(`write:${value}`);
      authority = value;
      throw new Error("response lost");
    }) as unknown as CoachClient["call"];
    const { controller, subject } = await startedController(call);

    subject.changeCap("0.75");
    await controller.commitCap();
    expect(subject.state().capOperation).toEqual({ kind: "error", reason: "request-failed" });
    await controller.retryCap();

    expect(trace).toEqual(["read:0.5", "write:0.75", "read:0.75"]);
    expect(subject.state().summary?.dailyCapUsd).toBe(0.75);
    expect(subject.state().capOperation).toEqual({ kind: "idle" });
  });

  it("reloads authority before saving a newer edit after a failed request", async () => {
    const trace: string[] = [];
    const call = vi.fn(async (method: string, params: unknown) => {
      if (method === "getSpendSummary") {
        trace.push("read");
        return spend();
      }
      const value = (params as { readonly dailyCapUsd: number }).dailyCapUsd;
      trace.push(`write:${value}`);
      if (value === 0.75) throw new Error("request failed");
      return spend({ dailyCapUsd: value });
    }) as unknown as CoachClient["call"];
    const { controller, subject } = await startedController(call);

    subject.changeCap("0.75");
    await controller.commitCap();
    expect(subject.state().capOperation).toEqual({ kind: "error", reason: "request-failed" });

    subject.changeCap("0.9");
    await controller.commitCap();

    expect(trace).toEqual(["read", "write:0.75", "read", "write:0.9"]);
    expect(subject.state().summary?.dailyCapUsd).toBe(0.9);
    expect(subject.state().capDraft.text).toBe("0.9");
    expect(subject.state().capOperation).toEqual({ kind: "idle" });
  });

  it("reconnects and reloads authority before retrying a disconnected save", async () => {
    const disconnected = new CoachClientDisconnectedError(1006, "");
    let reads = 0;
    const firstCall = vi.fn(async (method: string) => {
      if (method === "getSpendSummary" && reads === 0) {
        reads += 1;
        return spend();
      }
      throw disconnected;
    }) as unknown as CoachClient["call"];
    const secondCall = vi.fn(async (method: string) => {
      if (method === "getSpendSummary") return spend({ dailyCapUsd: 0.75 });
      throw new TypeError(`unexpected method ${method}`);
    }) as unknown as CoachClient["call"];
    const clients = reconnectingProvider(firstCall, secondCall);
    const subject = fakeView();
    const controller = createSpendMeterController({
      clients,
      view: subject.view,
      setInterval: (() => 1) as never,
      clearInterval: vi.fn() as never,
    });
    controller.start();
    await controller.refresh();

    subject.changeCap("0.75");
    await controller.commitCap();
    expect(subject.state().capOperation).toEqual({ kind: "error", reason: "request-failed" });

    await controller.retryCap();

    expect(clients.reconnect).toHaveBeenCalledOnce();
    expect(secondCall).toHaveBeenCalledExactlyOnceWith("getSpendSummary", {});
    expect(subject.state().summary?.dailyCapUsd).toBe(0.75);
    expect(subject.state().capOperation).toEqual({ kind: "idle" });
  });

  it("keeps an active save visible when a newer invalid draft is committed", async () => {
    const write = deferred<SpendSummary>();
    const call = vi.fn(async (method: string) =>
      method === "getSpendSummary" ? spend() : write.promise,
    ) as unknown as CoachClient["call"];
    const { controller, subject } = await startedController(call);

    subject.changeCap("0.75");
    const saving = controller.commitCap();
    await vi.waitFor(() => expect(subject.state().capOperation).toEqual({ kind: "saving" }));
    subject.changeCap("");
    subject.commitCap();

    expect(subject.state().capDraft).toEqual({ kind: "invalid", text: "" });
    expect(subject.state().capOperation).toEqual({ kind: "saving" });

    write.resolve(spend({ dailyCapUsd: 0.75 }));
    await saving;
    expect(subject.state().capDraft).toEqual({ kind: "invalid", text: "" });
    expect(subject.state().capOperation).toEqual({ kind: "idle" });
  });

  it("waits for an older refresh before saving and coalesces refreshes requested during the drain", async () => {
    const olderRefresh = deferred<SpendSummary>();
    const write = deferred<SpendSummary>();
    const trace: string[] = [];
    let reads = 0;
    const call = vi.fn(async (method: string) => {
      if (method === "getSpendSummary") {
        reads += 1;
        trace.push(`read:${reads}`);
        if (reads === 2) return olderRefresh.promise;
        return spend({ dailyCapUsd: reads === 1 ? 0.5 : 0.75 });
      }
      trace.push("write");
      return write.promise;
    }) as unknown as CoachClient["call"];
    const { controller, subject } = await startedController(call);

    const refreshing = controller.refresh();
    await vi.waitFor(() => expect(trace).toEqual(["read:1", "read:2"]));
    subject.changeCap("0.75");
    const saving = controller.commitCap();
    await Promise.resolve();
    expect(trace).toEqual(["read:1", "read:2"]);
    olderRefresh.resolve(spend({ dailyCapUsd: 0.5 }));
    await refreshing;
    await vi.waitFor(() => expect(trace).toContain("write"));
    const postOne = controller.refresh();
    const postTwo = controller.refresh();
    expect(postOne).toBe(postTwo);
    write.resolve(spend({ dailyCapUsd: 0.75 }));
    await Promise.all([saving, postOne]);

    expect(trace).toEqual(["read:1", "read:2", "write", "read:3"]);
  });

  it("ignores settlement after disposal and cancels its interval", async () => {
    const late = deferred<SpendSummary>();
    const call = vi.fn(async () => late.promise) as unknown as CoachClient["call"];
    const subject = fakeView();
    const clearInterval = vi.fn();
    const controller = createSpendMeterController({
      clients: provider(call),
      view: subject.view,
      setInterval: (() => 7) as never,
      clearInterval: clearInterval as never,
    });
    controller.start();
    const pending = controller.refresh();
    await Promise.resolve();
    controller.dispose();
    late.resolve(spend({ dailyCapUsd: 0.75 }));
    await pending;

    expect(subject.state().summary).toBeNull();
    expect(clearInterval).toHaveBeenCalledWith(7);
    expect(subject.view.dispose).toHaveBeenCalledTimes(1);
  });
});
