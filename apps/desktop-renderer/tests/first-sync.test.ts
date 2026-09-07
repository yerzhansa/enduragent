import { readFile } from "node:fs/promises";
import type { CoachClient, CoachClientCallOptions } from "@enduragent/coach-client";
import type {
  CoachOperationProgressNotificationEnvelope,
  SyncRpcResult,
} from "@enduragent/coach-contract";
import { describe, expect, it, vi, type Mock } from "vitest";
import type { DesktopCoachClientProvider } from "../src/coach-client";
import {
  createFirstSyncController,
  type FirstSyncPorts,
  type FirstSyncState,
} from "../src/first-sync";
import {
  createManualSyncController,
  type ManualSyncViewState,
} from "../src/training-context/manual-sync";
import {
  createTrainingSyncCoordinator,
  type TrainingSyncCoordinator,
  type TrainingSyncState,
  type TrainingSyncStateListener,
} from "../src/training-sync";

const completion = {
  providerConfigured: true,
  trainingDataConfigured: true,
  intakeSaved: true,
  requiresProviderSync: true,
} as const;

const fileOnlyCompletion = { ...completion, requiresProviderSync: false } as const;

const success: SyncRpcResult = {
  schemaVersion: 1,
  published: true,
  referenceSucceeded: true,
  requests: { store: 1, reference: 1, total: 2 },
  droppedActivities: {
    overall: { total: 0, visible: 0, restrictions: [], other: 0 },
    recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
  },
};

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

class FakeCoordinator implements TrainingSyncCoordinator {
  private state: TrainingSyncState = { status: "idle" };
  private operation = 0;
  private task: ReturnType<typeof deferred<void>> | undefined;
  private readonly listeners = new Set<TrainingSyncStateListener>();
  readonly requestCalls: number[] = [];

  getState(): TrainingSyncState {
    return this.state;
  }

  subscribe(listener: TrainingSyncStateListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  request(): Promise<void> {
    if (this.task !== undefined) return this.task.promise;
    this.requestCalls.push(this.operation + 1);
    this.operation += 1;
    this.task = deferred<void>();
    this.publish({ status: "queued", operation: this.operation });
    return this.task.promise;
  }

  publish(state: TrainingSyncState): void {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }

  finish(state: TrainingSyncState): void {
    this.publish(state);
    const task = this.task;
    this.task = undefined;
    task?.resolve();
  }

  dispose(): void {
    this.listeners.clear();
    this.task = undefined;
  }
}

function fakePorts(coordinator: TrainingSyncCoordinator): FirstSyncPorts & {
  readonly states: FirstSyncState[];
  readonly focusComposer: Mock<() => void>;
} {
  const states: FirstSyncState[] = [];
  return {
    coordinator,
    states,
    focusComposer: vi.fn<() => void>(),
    render: (state) => states.push(state),
  };
}

function envelope(
  phase: "started" | "completed",
  completed: number,
): CoachOperationProgressNotificationEnvelope {
  return {
    jsonrpc: "2.0",
    method: "coach.operationProgress",
    params: { requestId: 1, requestMethod: "sync", event: { phase, completed, total: 1 } },
  };
}

describe("first sync controller", () => {
  it("strictly validates completion and joins one synchronous coordinator flight", async () => {
    const coordinator = new FakeCoordinator();
    const ports = fakePorts(coordinator);
    const controller = createFirstSyncController(ports);
    for (const invalid of [
      {},
      { ...completion, intakeSaved: false },
      { ...completion, requiresProviderSync: "yes" },
      {
        providerConfigured: true,
        trainingDataConfigured: true,
        intakeSaved: true,
      },
      { ...completion, extra: true },
      null,
    ]) {
      await expect(controller.start(invalid as never)).rejects.toBeInstanceOf(TypeError);
    }
    expect(coordinator.requestCalls).toHaveLength(0);
    const first = controller.start(completion);
    const second = controller.start(completion);
    expect(first).toBe(second);
    expect(coordinator.requestCalls).toEqual([1]);
    expect(ports.states).toEqual([{ status: "syncing" }]);
    coordinator.publish({ status: "running", operation: 1 });
    expect(ports.states).toEqual([{ status: "syncing" }]);
    coordinator.finish({
      status: "succeeded",
      operation: 1,
      kind: "published",
      droppedActivities: {
        overall: { total: 0, visible: 0, restrictions: [], other: 0 },
        recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
      },
    });
    await first;
    expect(ports.states.at(-1)).toEqual({ status: "ready" });
    expect(ports.focusComposer).toHaveBeenCalledTimes(1);
  });

  it("skips provider sync for file-only completion and leaves retry inert", async () => {
    const coordinator = new FakeCoordinator();
    const ports = fakePorts(coordinator);
    const controller = createFirstSyncController(ports);

    await controller.start(fileOnlyCompletion);
    await controller.retry();
    await controller.start(fileOnlyCompletion);

    expect(coordinator.requestCalls).toEqual([]);
    expect(ports.states).toEqual([]);
    expect(ports.focusComposer).toHaveBeenCalledTimes(1);
  });

  it("clears a stale first-sync failure when file-only setup completes", async () => {
    const coordinator = new FakeCoordinator();
    const ports = fakePorts(coordinator);
    const controller = createFirstSyncController(ports);
    const providerSync = controller.start(completion);
    coordinator.finish({
      status: "failed",
      operation: 1,
      kind: "operation",
      retryable: true,
    });
    await providerSync;

    await controller.start(fileOnlyCompletion);
    await controller.retry();

    expect(coordinator.requestCalls).toEqual([1]);
    expect(ports.states.at(-1)).toEqual({ status: "idle" });
    expect(ports.focusComposer).toHaveBeenCalledTimes(1);
  });

  it("does not join or cancel a concurrently running manual sync for file-only setup", async () => {
    const coordinator = new FakeCoordinator();
    const ports = fakePorts(coordinator);
    const first = createFirstSyncController(ports);
    const manual = createManualSyncController({
      coordinator,
      view: { render: vi.fn(), restoreKeyboardFocus: vi.fn() },
    });

    const manualTask = manual.activate("pointer");
    await first.start(fileOnlyCompletion);

    expect(coordinator.requestCalls).toEqual([1]);
    expect(ports.states).toEqual([]);
    expect(ports.focusComposer).toHaveBeenCalledTimes(1);
    coordinator.finish({
      status: "succeeded",
      operation: 1,
      kind: "no-change",
      droppedActivities: {
        overall: { total: 0, visible: 0, restrictions: [], other: 0 },
        recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
      },
    });
    await manualTask;
    expect(ports.states).toEqual([]);

    manual.dispose();
    first.dispose();
  });

  it.each([
    [
      {
        status: "succeeded",
        operation: 1,
        kind: "no-change",
        droppedActivities: {
          overall: { total: 0, visible: 0, restrictions: [], other: 0 },
          recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
        },
      },
      { status: "failed", kind: "operation", retryable: true },
    ],
    [
      { status: "failed", operation: 1, kind: "partial", retryable: true },
      { status: "failed", kind: "operation", retryable: true },
    ],
    [
      { status: "failed", operation: 1, kind: "operation", retryable: true },
      { status: "failed", kind: "operation", retryable: true },
    ],
    [
      { status: "failed", operation: 1, kind: "indeterminate", retryable: true },
      { status: "failed", kind: "disconnected", retryable: true },
    ],
    [
      { status: "failed", operation: 1, kind: "protocol", retryable: false },
      { status: "failed", kind: "protocol", retryable: false },
    ],
  ] as const)("preserves first-sync mapping for %o", async (terminal, expected) => {
    const coordinator = new FakeCoordinator();
    const ports = fakePorts(coordinator);
    const controller = createFirstSyncController(ports);
    const task = controller.start(completion);
    coordinator.finish(terminal);
    await task;
    expect(ports.states.at(-1)).toEqual(expected);
    expect(ports.focusComposer).not.toHaveBeenCalled();
  });

  it("retries only a retryable shared outcome and focuses the composer once", async () => {
    const coordinator = new FakeCoordinator();
    const ports = fakePorts(coordinator);
    const controller = createFirstSyncController(ports);
    const first = controller.start(completion);
    coordinator.finish({
      status: "failed",
      operation: 1,
      kind: "operation",
      retryable: true,
    });
    await first;
    await controller.start(completion);
    expect(coordinator.requestCalls).toEqual([1]);
    const retry = controller.retry();
    expect(coordinator.requestCalls).toEqual([1, 2]);
    coordinator.finish({
      status: "succeeded",
      operation: 2,
      kind: "published",
      droppedActivities: {
        overall: { total: 0, visible: 0, restrictions: [], other: 0 },
        recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
      },
    });
    await retry;
    expect(coordinator.requestCalls).toEqual([1, 2]);
    expect(ports.focusComposer).toHaveBeenCalledTimes(1);
  });

  it.each(["owned", "joined"] as const)(
    "quiesces a completed %s first-sync render and focus history during later manual syncs",
    async (admission) => {
      const coordinator = new FakeCoordinator();
      const ports = fakePorts(coordinator);
      const first = createFirstSyncController(ports);
      const manualStates: ManualSyncViewState[] = [];
      const manual = createManualSyncController({
        coordinator,
        view: { render: (state) => manualStates.push(state), restoreKeyboardFocus: vi.fn() },
      });
      const joinedTask = admission === "joined" ? manual.activate("pointer") : undefined;
      const firstTask = first.start(completion);
      if (joinedTask !== undefined) expect(firstTask).toBe(joinedTask);
      coordinator.finish({
        status: "succeeded",
        operation: 1,
        kind: "published",
        droppedActivities: {
          overall: { total: 0, visible: 0, restrictions: [], other: 0 },
          recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
        },
      });
      await firstTask;
      await Promise.resolve();
      const renderedAtReady = [...ports.states];
      const focusCallsAtReady = ports.focusComposer.mock.calls.length;

      const laterManual = manual.activate("pointer");
      coordinator.finish({
        status: "succeeded",
        operation: 2,
        kind: "no-change",
        droppedActivities: {
          overall: { total: 0, visible: 0, restrictions: [], other: 0 },
          recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
        },
      });
      await laterManual;

      expect(coordinator.requestCalls).toEqual([1, 2]);
      expect(manualStates.at(-1)?.message).toBe("Local training-data processing completed.");
      expect(ports.states).toEqual(renderedAtReady);
      expect(ports.focusComposer).toHaveBeenCalledTimes(focusCallsAtReady);
      manual.dispose();
      first.dispose();
    },
  );

  it("reactivates a completed first sync only for later onboarding without refocusing", async () => {
    const coordinator = new FakeCoordinator();
    const ports = fakePorts(coordinator);
    const first = createFirstSyncController(ports);
    const manual = createManualSyncController({
      coordinator,
      view: { render: vi.fn(), restoreKeyboardFocus: vi.fn() },
    });

    const initialSetup = first.start(completion);
    coordinator.finish({
      status: "succeeded",
      operation: 1,
      kind: "published",
      droppedActivities: {
        overall: { total: 0, visible: 0, restrictions: [], other: 0 },
        recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
      },
    });
    await initialSetup;
    expect(ports.states).toEqual([{ status: "syncing" }, { status: "ready" }]);
    const renderedAtReady = [...ports.states];

    const laterManual = manual.activate("pointer");
    coordinator.finish({
      status: "succeeded",
      operation: 2,
      kind: "no-change",
      droppedActivities: {
        overall: { total: 0, visible: 0, restrictions: [], other: 0 },
        recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
      },
    });
    await laterManual;
    expect(ports.states).toEqual(renderedAtReady);
    expect(ports.focusComposer).toHaveBeenCalledTimes(1);

    const laterSetup = first.start(completion);
    expect(coordinator.requestCalls).toEqual([1, 2, 3]);
    expect(ports.states).toEqual([...renderedAtReady, { status: "syncing" }]);
    coordinator.finish({
      status: "succeeded",
      operation: 3,
      kind: "published",
      droppedActivities: {
        overall: { total: 0, visible: 0, restrictions: [], other: 0 },
        recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
      },
    });
    await laterSetup;
    expect(ports.states).toEqual([...renderedAtReady, { status: "syncing" }, { status: "ready" }]);
    expect(ports.focusComposer).toHaveBeenCalledTimes(1);
    manual.dispose();
    first.dispose();
  });

  it("makes shared state and completion inert after disposal", async () => {
    const coordinator = new FakeCoordinator();
    const ports = fakePorts(coordinator);
    const controller = createFirstSyncController(ports);
    const task = controller.start(completion);
    controller.dispose();
    coordinator.finish({
      status: "succeeded",
      operation: 1,
      kind: "published",
      droppedActivities: {
        overall: { total: 0, visible: 0, restrictions: [], other: 0 },
        recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
      },
    });
    await task;
    await controller.retry();
    await controller.start(completion);
    expect(ports.states).toEqual([{ status: "syncing" }]);
    expect(ports.focusComposer).not.toHaveBeenCalled();
  });

  it("keeps the drawer coherent when first sync owns the active admission", async () => {
    const coordinator = new FakeCoordinator();
    const first = createFirstSyncController(fakePorts(coordinator));
    const firstTask = first.start(completion);
    const manualStates: ManualSyncViewState[] = [];
    const manual = createManualSyncController({
      coordinator,
      view: { render: (state) => manualStates.push(state), restoreKeyboardFocus: vi.fn() },
    });
    await manual.activate("keyboard");
    expect(coordinator.requestCalls).toEqual([1]);
    expect(manualStates).toEqual([
      {
        label: "Sync now",
        message: "Sync queued.",
        disabled: true,
        busy: true,
        tone: "active",
      },
    ]);
    coordinator.finish({
      status: "succeeded",
      operation: 1,
      kind: "published",
      droppedActivities: {
        overall: { total: 0, visible: 0, restrictions: [], other: 0 },
        recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
      },
    });
    await firstTask;
    expect(manualStates.at(-1)?.message).toBe("Training-data check completed.");
  });

  it("keeps the last successful restriction summary through a failed refresh", async () => {
    const coordinator = new FakeCoordinator();
    const states: ManualSyncViewState[] = [];
    const manual = createManualSyncController({
      coordinator,
      view: { render: (state) => states.push(state), restoreKeyboardFocus: vi.fn() },
    });

    const first = manual.activate("pointer");
    coordinator.finish({
      status: "succeeded",
      operation: 1,
      kind: "published",
      droppedActivities: {
        overall: {
          total: 67,
          visible: 5,
          restrictions: [{ reason: "source-restricted", source: "STRAVA", count: 60 }],
          other: 2,
        },
        recent7Days: {
          total: 5,
          visible: 1,
          restrictions: [{ reason: "source-restricted", source: "STRAVA", count: 4 }],
          other: 0,
        },
      },
    });
    await first;
    await Promise.resolve();

    const second = manual.activate("pointer");
    expect(states.at(-1)?.tone).toBe("active");
    expect(states.at(-1)?.droppedActivities?.overall.restrictions[0]?.count).toBe(60);
    coordinator.finish({
      status: "failed",
      operation: 2,
      kind: "operation",
      retryable: true,
    });
    await second;

    expect(states.at(-1)?.tone).toBe("failure");
    expect(states.at(-1)?.droppedActivities?.overall.restrictions[0]?.count).toBe(60);
    manual.dispose();
  });

  it("restores focus only for the accepted keyboard activation", async () => {
    const coordinator = new FakeCoordinator();
    const restoreKeyboardFocus = vi.fn();
    const manual = createManualSyncController({
      coordinator,
      view: { render: vi.fn(), restoreKeyboardFocus },
    });
    const keyboard = manual.activate("keyboard");
    expect(manual.activate("pointer")).toBe(keyboard);
    coordinator.finish({
      status: "succeeded",
      operation: 1,
      kind: "published",
      droppedActivities: {
        overall: { total: 0, visible: 0, restrictions: [], other: 0 },
        recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
      },
    });
    await keyboard;
    await Promise.resolve();
    expect(restoreKeyboardFocus).toHaveBeenCalledTimes(1);

    const pointer = manual.activate("pointer");
    coordinator.finish({
      status: "succeeded",
      operation: 2,
      kind: "published",
      droppedActivities: {
        overall: { total: 0, visible: 0, restrictions: [], other: 0 },
        recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
      },
    });
    await pointer;
    await Promise.resolve();
    expect(restoreKeyboardFocus).toHaveBeenCalledTimes(1);

    const staleKeyboard = manual.activate("keyboard");
    manual.dispose();
    coordinator.finish({
      status: "succeeded",
      operation: 3,
      kind: "published",
      droppedActivities: {
        overall: { total: 0, visible: 0, restrictions: [], other: 0 },
        recent7Days: { total: 0, visible: 0, restrictions: [], other: 0 },
      },
    });
    await staleKeyboard;
    expect(restoreKeyboardFocus).toHaveBeenCalledTimes(1);
  });

  it("shares one wire operation with manual sync and replays running state to late surfaces", async () => {
    const callGate = deferred<SyncRpcResult>();
    let options!: CoachClientCallOptions<"sync">;
    const call = vi.fn(
      async (_method: string, _params: unknown, selected?: CoachClientCallOptions<"sync">) => {
        options = selected!;
        return callGate.promise;
      },
    );
    const client = {
      handshake: {} as CoachClient["handshake"],
      call: call as unknown as CoachClient["call"],
      close: vi.fn(async () => {}),
    } as CoachClient;
    const clients: DesktopCoachClientProvider = {
      getClient: vi.fn(async () => client),
      reconnect: vi.fn(async () => client),
      close: vi.fn(async () => {}),
    };
    const refreshTrainingContext = vi.fn(async () => {});
    const coordinator = createTrainingSyncCoordinator({ clients, refreshTrainingContext });
    const manualStates: ManualSyncViewState[] = [];
    const manual = createManualSyncController({
      coordinator,
      view: {
        render: (state) => manualStates.push(state),
        restoreKeyboardFocus: vi.fn(),
      },
    });
    const manualTask = manual.activate("pointer");
    await Promise.resolve();
    options.onNotificationEnvelope?.(envelope("started", 0));

    const firstPorts = fakePorts(coordinator);
    const first = createFirstSyncController(firstPorts);
    const firstTask = first.start(completion);
    expect(firstTask).toBe(manualTask);
    expect(firstPorts.states).toEqual([{ status: "syncing" }]);
    expect(manualStates.at(-1)?.message).toBe("Syncing training data…");
    expect(call).toHaveBeenCalledTimes(1);

    const lateStates: ManualSyncViewState[] = [];
    const late = createManualSyncController({
      coordinator,
      view: { render: (state) => lateStates.push(state), restoreKeyboardFocus: vi.fn() },
    });
    expect(lateStates).toEqual([
      {
        label: "Sync now",
        message: "Syncing training data…",
        disabled: true,
        busy: true,
        tone: "active",
      },
    ]);
    expect(call).toHaveBeenCalledTimes(1);

    options.onNotificationEnvelope?.(envelope("completed", 1));
    options.onTerminalEnvelope?.({ jsonrpc: "2.0", id: 1, result: success });
    callGate.resolve(success);
    await Promise.all([manualTask, firstTask]);
    expect(call).toHaveBeenCalledTimes(1);
    expect(refreshTrainingContext).toHaveBeenCalledTimes(1);
    expect(firstPorts.states.at(-1)).toEqual({ status: "ready" });
    expect(firstPorts.focusComposer).not.toHaveBeenCalled();
    expect(lateStates.at(-1)?.message).toBe("Training-data check completed.");
    late.dispose();
    first.dispose();
    manual.dispose();
  });

  it("keeps first sync free of a second wire tracker and ships the existing status surface", async () => {
    const [host, card, controller, styles] = await Promise.all([
      readFile(new URL("../src/boot.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/ui/chat/FirstSyncCard.tsx", import.meta.url), "utf8"),
      readFile(new URL("../src/first-sync.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/theme/application.css", import.meta.url), "utf8"),
    ]);
    for (const copy of [
      "Getting your coach ready",
      "Syncing your training history…",
      "You can keep Enduragent open while rides, wellness, and calendar data are added.",
      "We couldn’t finish syncing",
      "Your saved progress is safe.",
      "Retry sync",
      "Enduragent needs to reconnect safely",
      "Quit and reopen Enduragent.",
    ]) {
      expect(card).toContain(copy);
    }
    expect(card).toContain('if (status === "idle" || status === "ready") return null;');
    expect(card).not.toContain("Training history is ready");
    expect(card).not.toContain("Your coach is ready when you are.");
    expect(card).toContain('aria-labelledby="first-sync-title"');
    expect(card).toContain('role="progressbar"');
    expect(card).toContain('aria-label="Syncing training history"');
    expect(host).toContain("coordinator: trainingSyncCoordinator");
    expect(host).not.toContain("syncNeedsReconnect");
    expect(controller).not.toMatch(/onNotificationEnvelope|requestId|chat|transcript/u);
    expect(card).toContain('className="first-sync my-6 w-full');
    expect(card).not.toContain("first-sync__mark");
    expect(card).toContain("motion-reduce:before:animate-none");
    expect(styles).toContain("@keyframes first-sync-sweep");
  });
});
