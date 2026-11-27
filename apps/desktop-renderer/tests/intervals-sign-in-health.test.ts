import { describe, expect, it, vi } from "vitest";
import type { RuntimeConfigSnapshot } from "@enduragent/coach-contract";
import type { DesktopCoachClient, DesktopCoachClientProvider } from "../src/coach-client";
import { createIntervalsSignInHealth } from "../src/intervals-sign-in-health";
import type { IntervalsCredentialMutationResult } from "../src/onboarding/bridge";
import type { TrainingSyncState, TrainingSyncStateListener } from "../src/training-sync";

function snapshot(intervals: Partial<RuntimeConfigSnapshot["intervals"]>): RuntimeConfigSnapshot {
  return {
    schemaVersion: 3,
    llm: { provider: "anthropic", model: "synthetic-model", credential_configured: true },
    intervals: {
      athlete_id: "synthetic-athlete",
      credential_configured: true,
      managedByEnvironment: { athleteId: false },
      ...intervals,
    },
    session: {
      historyTokenBudgetRatio: 0.3,
      idleMinutes: 0,
      dailyResetHour: 4,
      resetArchiveRetentionDays: 0,
      timezone: "UTC",
      managedByEnvironment: {
        historyTokenBudgetRatio: false,
        idleMinutes: false,
        dailyResetHour: false,
        resetArchiveRetentionDays: false,
        timezone: false,
      },
    },
  };
}

function subject(initial: RuntimeConfigSnapshot = snapshot({})) {
  let runtime = initial;
  const call = vi.fn(async (method: string) => (method === "getRuntimeConfig" ? runtime : {}));
  const inner = { handshake: {}, call } as unknown as DesktopCoachClient;
  const replacement = { handshake: {}, call } as unknown as DesktopCoachClient;
  const openListeners = new Set<() => void>();
  const provider = {
    getClient: vi.fn(async () => inner),
    reconnect: vi.fn(async () => replacement),
    close: vi.fn(async () => undefined),
    onConnectionOpen: vi.fn((listener: () => void) => {
      openListeners.add(listener);
      return () => {
        openListeners.delete(listener);
      };
    }),
  } satisfies DesktopCoachClientProvider;
  const published: boolean[] = [];
  const health = createIntervalsSignInHealth(provider, {
    getState: () => ({ setIntervalsSignInRejected: (rejected) => published.push(rejected) }),
  });
  const listeners = new Set<TrainingSyncStateListener>();
  const coordinator = {
    subscribe: vi.fn((listener: TrainingSyncStateListener) => {
      listeners.add(listener);
      listener({ status: "idle" });
      return () => listeners.delete(listener);
    }),
  };
  const emit = (state: TrainingSyncState): void => {
    for (const listener of listeners) listener(state);
  };
  const focusTarget = new EventTarget();
  return {
    health,
    provider,
    inner,
    call,
    published,
    coordinator,
    emit,
    focusTarget: focusTarget as unknown as Window,
    openConnection: () => {
      for (const listener of openListeners) listener();
    },
    setRuntime: (next: RuntimeConfigSnapshot) => {
      runtime = next;
    },
  };
}

function runtimeReads(call: ReturnType<typeof vi.fn>): number {
  return call.mock.calls.filter(([method]) => method === "getRuntimeConfig").length;
}

describe("intervals.icu sign-in health", () => {
  it("publishes the rejected flag from every runtime configuration read", async () => {
    const test = subject(snapshot({ credential_rejected: true }));
    const client = await test.health.clients.getClient();

    await client.call("getRuntimeConfig", {});
    await vi.waitFor(() => expect(test.published).toEqual([true]));

    test.setRuntime(snapshot({ credential_configured: false, credential_rejected: true }));
    await client.call("getRuntimeConfig", {});
    await vi.waitFor(() => expect(test.published).toEqual([true, true]));

    test.setRuntime(snapshot({ credential_configured: false }));
    await client.call("getRuntimeConfig", {});
    await vi.waitFor(() => expect(test.published).toEqual([true, true, false]));

    await client.call("sync", {});
    expect(test.published).toEqual([true, true, false]);
  });

  it("reads runtime configuration at start, after every finished sync, and on focus", async () => {
    const test = subject(snapshot({ credential_rejected: true }));
    const dispose = test.health.follow(test.coordinator, test.focusTarget);
    await vi.waitFor(() => expect(test.published).toEqual([true]));
    expect(runtimeReads(test.call)).toBe(1);

    test.emit({ status: "queued", operation: 1 });
    test.emit({ status: "running", operation: 1 });
    expect(runtimeReads(test.call)).toBe(1);
    test.setRuntime(snapshot({}));
    test.emit({ status: "failed", operation: 1, kind: "operation", retryable: true });
    await vi.waitFor(() => expect(test.published).toEqual([true, false]));

    test.setRuntime(snapshot({ credential_rejected: true }));
    test.emit({
      status: "succeeded",
      operation: 2,
      kind: "no-change",
      droppedActivities: {
        overall: { total: 0, visible: 0, restrictions: [], other: 0 },
        recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
      },
    });
    await vi.waitFor(() => expect(test.published).toEqual([true, false, true]));

    test.focusTarget.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(runtimeReads(test.call)).toBe(4));

    dispose();
    test.focusTarget.dispatchEvent(new Event("focus"));
    test.emit({ status: "failed", operation: 3, kind: "operation", retryable: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtimeReads(test.call)).toBe(4);
  });

  it("clears the flag after a successful sign-in and ignores an older read", async () => {
    const test = subject(snapshot({ credential_rejected: true }));
    let releaseRead!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    test.call.mockImplementationOnce(async () => {
      await gate;
      return snapshot({ credential_rejected: true });
    });
    const client = await test.health.clients.getClient();
    const staleRead = client.call("getRuntimeConfig", {});
    const applied: IntervalsCredentialMutationResult = {
      outcome: "applied",
      current: { slot: "intervals-icu", state: "configured", runtimeState: "active" },
    };

    await expect(test.health.signedIn(Promise.resolve(applied))).resolves.toBe(applied);
    releaseRead();
    await staleRead;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(test.published).toEqual([false]);

    await test.health.signedIn(
      Promise.resolve({ outcome: "refused", reason: "sign-in-denied", current: applied.current }),
    );
    expect(test.published).toEqual([false]);
  });

  it("keeps one wrapper per client and reconnects with the original client", async () => {
    const test = subject();
    const first = await test.health.clients.getClient();
    expect(await test.health.clients.getClient()).toBe(first);
    expect(first).not.toBe(test.inner);

    const next = await test.health.clients.reconnect(first);
    expect(test.provider.reconnect).toHaveBeenCalledWith(test.inner);
    await next.call("getRuntimeConfig", {});
    await vi.waitFor(() => expect(test.published).toEqual([false]));
    await test.health.clients.close();
    expect(test.provider.close).toHaveBeenCalledOnce();
  });

  it("passes call arguments through unchanged", async () => {
    const test = subject();
    const client = await test.health.clients.getClient();
    const signal = new AbortController().signal;

    await client.call("sync", {});
    await client.call("sync", {}, { signal });

    expect(test.call.mock.calls).toEqual([
      ["sync", {}],
      ["sync", {}, { signal }],
    ]);
  });

  it("tells listeners on its clients when the provider opens a new connection", () => {
    const test = subject();
    const listener = vi.fn();
    const stop = test.health.clients.onConnectionOpen(listener);

    test.openConnection();
    expect(listener).toHaveBeenCalledOnce();

    stop();
    test.openConnection();
    expect(listener).toHaveBeenCalledOnce();
  });
});
