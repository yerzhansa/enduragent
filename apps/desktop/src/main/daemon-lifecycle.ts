import type { DesktopDaemonResolution } from "@enduragent/coach/enduragent";
import { requireDesktopDaemonHome } from "./daemon-home-binding.js";

export type ConnectedDesktopDaemon = Extract<
  DesktopDaemonResolution,
  { readonly status: "connected" }
>;

export type DesktopDaemonLifecycleState =
  | { readonly status: "starting" }
  | { readonly status: "ready"; readonly generation: number }
  | { readonly status: "recovering"; readonly generation: number }
  | {
      readonly status: "terminal";
      readonly generation: number;
      readonly cause: Extract<DesktopDaemonResolution, { status: "refused" }>["cause"];
    }
  | { readonly status: "closing"; readonly generation: number };

export interface DesktopDaemonConnection {
  readonly url: `ws://127.0.0.1:${number}/rpc`;
  readonly token: string;
  readonly athleteHome: string;
  readonly rendererCapability: string;
  readonly owner: ConnectedDesktopDaemon["owner"];
  readonly supervision: ConnectedDesktopDaemon["supervision"];
  readonly generation: number;
}

export interface DesktopDaemonRecoveryBudget {
  remainingAttempts: number;
  readonly deadline: number;
}

interface DesktopDaemonResolver {
  resolveForRecovery(budget: DesktopDaemonRecoveryBudget): Promise<DesktopDaemonResolution>;
  reobserveAttached(budget: DesktopDaemonRecoveryBudget): Promise<DesktopDaemonResolution>;
  close(): Promise<void>;
}

export interface DesktopDaemonLifecycleOptions {
  readonly delay?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly monotonicNow?: () => number;
  readonly prepareReady?: (input: {
    readonly connection: DesktopDaemonConnection;
    readonly signal: AbortSignal;
  }) => Promise<void>;
  readonly onTransition?: (state: DesktopDaemonLifecycleState) => void;
  readonly onReady?: (input: {
    readonly previous: DesktopDaemonConnection;
    readonly current: DesktopDaemonConnection;
  }) => void;
}

const RESTART_BACKOFF_MS = [500, 1_000, 2_000] as const;
const RESTART_WINDOW_MS = 60_000;
const READINESS_TIMEOUT_MS = 5_000;
const CLOSE_TIMEOUT_MS = 10_000;

function daemonConnection(
  resolution: ConnectedDesktopDaemon,
  generation: number,
): DesktopDaemonConnection {
  return {
    url: resolution.url,
    token: resolution.token,
    athleteHome: resolution.athleteHome,
    rendererCapability: resolution.rendererCapability,
    owner: resolution.owner,
    supervision: resolution.supervision,
    generation,
  };
}

function defaultDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function requireSettlementBefore<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(timeoutMessage));
    }, timeoutMs);
    void promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function childIsAlive(resolution: ConnectedDesktopDaemon): boolean {
  if (resolution.supervision === "attached") return true;
  return resolution.isAlive();
}

export class DesktopDaemonLifecycle {
  private current: ConnectedDesktopDaemon | undefined;
  private lastConnection: DesktopDaemonConnection;
  private generation = 1;
  private state: DesktopDaemonLifecycleState;
  private readonly restartAttempts: number[] = [];
  private readonly delay: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly monotonicNow: () => number;
  private readonly controller = new AbortController();
  private watchIdentity = 0;
  private recovery:
    | { readonly generation: number; readonly promise: Promise<DesktopDaemonConnection> }
    | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly resolver: DesktopDaemonResolver,
    initial: ConnectedDesktopDaemon,
    private readonly options: DesktopDaemonLifecycleOptions = {},
  ) {
    this.current = initial;
    this.lastConnection = daemonConnection(initial, 1);
    this.state = { status: "starting" };
    this.delay = options.delay ?? defaultDelay;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
  }

  start(): void {
    if (this.state.status !== "starting") return;
    this.transition({ status: "ready", generation: this.generation });
    this.watch(this.current, this.generation);
  }

  snapshot(): DesktopDaemonLifecycleState {
    return this.state;
  }

  connection(): DesktopDaemonConnection {
    if (this.current === undefined || this.state.status !== "ready") {
      throw new Error("desktop daemon connection unavailable");
    }
    return daemonConnection(this.current, this.generation);
  }

  currentPort(): number {
    return Number(new URL(this.lastConnection.url).port);
  }

  recover(failedGeneration: number): Promise<DesktopDaemonConnection> {
    if (!Number.isSafeInteger(failedGeneration) || failedGeneration < 1) {
      return Promise.reject(new TypeError("invalid desktop daemon generation"));
    }
    if (this.state.status === "closing" || this.state.status === "terminal") {
      return Promise.reject(new Error("desktop daemon recovery unavailable"));
    }
    if (this.recovery !== undefined && failedGeneration <= this.recovery.generation) {
      return this.recovery.promise;
    }
    if (failedGeneration < this.generation) return Promise.resolve(this.connection());
    if (failedGeneration > this.generation) {
      return Promise.reject(new TypeError("unknown desktop daemon generation"));
    }
    const previous = this.current;
    if (previous === undefined) {
      return Promise.reject(new Error("desktop daemon recovery unavailable"));
    }
    const pending = this.recoverCurrent(previous, failedGeneration).finally(() => {
      if (this.recovery?.promise === pending) this.recovery = undefined;
    });
    this.recovery = { generation: failedGeneration, promise: pending };
    return pending;
  }

  close(): Promise<void> {
    this.closePromise ??= this.runClose();
    return this.closePromise;
  }

  private transition(state: DesktopDaemonLifecycleState): void {
    this.state = state;
    this.options.onTransition?.(state);
  }

  private watch(resolution: ConnectedDesktopDaemon | undefined, generation: number): void {
    if (resolution?.supervision !== "app-supervised") return;
    const identity = ++this.watchIdentity;
    void resolution.exited.then(
      () => this.recoverAfterOwnedExit(resolution, generation, identity),
      () => this.recoverAfterOwnedExit(resolution, generation, identity),
    );
  }

  private recoverAfterOwnedExit(
    resolution: ConnectedDesktopDaemon,
    generation: number,
    identity: number,
  ): void {
    if (
      this.state.status === "closing" ||
      this.state.status === "terminal" ||
      identity !== this.watchIdentity ||
      generation !== this.generation ||
      resolution !== this.current
    ) {
      return;
    }
    void this.recover(generation).then(undefined, () => {
      if (this.state.status === "recovering" || this.state.status === "ready") {
        this.enterTerminal("unavailable");
      }
    });
  }

  private async recoverCurrent(
    previousResolution: ConnectedDesktopDaemon,
    failedGeneration: number,
  ): Promise<DesktopDaemonConnection> {
    if (previousResolution.supervision === "app-supervised") {
      if (childIsAlive(previousResolution)) return this.connection();
    }
    const now = this.monotonicNow();
    while (
      this.restartAttempts[0] !== undefined &&
      now - this.restartAttempts[0] >= RESTART_WINDOW_MS
    ) {
      this.restartAttempts.shift();
    }
    const budget: DesktopDaemonRecoveryBudget = {
      remainingAttempts: RESTART_BACKOFF_MS.length - this.restartAttempts.length,
      deadline: now + RESTART_WINDOW_MS,
    };
    if (budget.remainingAttempts < 1) {
      this.enterTerminal("restart-exhausted");
      throw new Error("desktop daemon restart budget exhausted");
    }
    if (previousResolution.supervision === "attached") {
      this.transition({ status: "recovering", generation: failedGeneration });
      const observed = await this.resolver.reobserveAttached(budget);
      if (this.state.status === "closing") {
        if (observed.status === "connected") await observed.close();
        throw new Error("desktop daemon recovery cancelled");
      }
      if (
        observed.status === "connected" &&
        observed.url === previousResolution.url &&
        observed.token === previousResolution.token &&
        observed.athleteHome === previousResolution.athleteHome &&
        observed.rendererCapability === previousResolution.rendererCapability &&
        observed.owner === previousResolution.owner
      ) {
        this.transition({ status: "ready", generation: failedGeneration });
        return this.connection();
      }
      if (observed.status === "connected") {
        return this.publishSuccessor(previousResolution, observed, failedGeneration);
      }
      if (!observed.retryable) {
        this.enterTerminal(observed.cause);
        throw new Error("desktop daemon recovery refused");
      }
    }
    this.current = undefined;
    this.watchIdentity += 1;
    this.transition({ status: "recovering", generation: failedGeneration });
    try {
      await previousResolution.close();
    } catch {
      this.enterTerminal("termination-failed");
      throw new Error("desktop daemon termination failed");
    }
    let attemptsThisRecovery = 0;
    while (
      attemptsThisRecovery < RESTART_BACKOFF_MS.length &&
      budget.remainingAttempts > 0 &&
      this.state.status === "recovering"
    ) {
      const attemptIndex = this.restartAttempts.length;
      const attemptAt = this.monotonicNow();
      this.restartAttempts.push(attemptAt);
      attemptsThisRecovery += 1;
      await this.delay(
        RESTART_BACKOFF_MS[Math.min(attemptIndex, 2)]!,
        this.controller.signal,
      ).then(undefined, (error: unknown) => {
        if (!this.controller.signal.aborted) throw error;
      });
      if (this.state.status !== "recovering" || this.controller.signal.aborted) {
        throw new Error("desktop daemon recovery cancelled");
      }
      let resolution: DesktopDaemonResolution;
      try {
        resolution = await this.resolver.resolveForRecovery(budget);
      } catch {
        continue;
      }
      if (this.state.status !== "recovering" || this.controller.signal.aborted) {
        if (resolution.status === "connected") await resolution.close();
        throw new Error("desktop daemon recovery cancelled");
      }
      if (resolution.status === "connected") {
        return this.publishSuccessor(previousResolution, resolution, failedGeneration);
      }
      if (!resolution.retryable) {
        this.enterTerminal(resolution.cause);
        throw new Error("desktop daemon recovery refused");
      }
    }
    this.enterTerminal("restart-exhausted");
    throw new Error("desktop daemon restart budget exhausted");
  }

  private async publishSuccessor(
    previousResolution: ConnectedDesktopDaemon,
    successor: ConnectedDesktopDaemon,
    failedGeneration: number,
  ): Promise<DesktopDaemonConnection> {
    try {
      requireDesktopDaemonHome(previousResolution.athleteHome, successor.athleteHome);
    } catch (error) {
      try {
        await successor.close();
      } catch (closeError) {
        this.enterTerminal("unavailable");
        throw closeError;
      }
      this.enterTerminal("unavailable");
      throw error;
    }
    const nextGeneration = failedGeneration + 1;
    const next = daemonConnection(successor, nextGeneration);
    const readiness = Promise.resolve(
      this.options.prepareReady?.({ connection: next, signal: this.controller.signal }),
    );
    const prepared = await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.controller.signal.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const timer = setTimeout(() => finish(false), READINESS_TIMEOUT_MS);
      const onAbort = (): void => finish(false);
      this.controller.signal.addEventListener("abort", onAbort, { once: true });
      void readiness.then(
        () => finish(true),
        () => finish(false),
      );
      if (this.controller.signal.aborted) onAbort();
    });
    if (this.state.status !== "recovering" || this.controller.signal.aborted) {
      await successor.close();
      throw new Error("desktop daemon recovery cancelled");
    }
    if (!prepared) {
      try {
        await successor.close();
      } catch (closeError) {
        this.enterTerminal("unavailable");
        throw closeError;
      }
      this.enterTerminal("unavailable");
      throw new Error("desktop daemon readiness failed");
    }
    this.current = successor;
    this.generation = nextGeneration;
    this.lastConnection = next;
    this.transition({ status: "ready", generation: nextGeneration });
    this.watch(successor, nextGeneration);
    this.options.onReady?.({
      previous: daemonConnection(previousResolution, failedGeneration),
      current: next,
    });
    return next;
  }

  private enterTerminal(
    cause: Extract<DesktopDaemonResolution, { status: "refused" }>["cause"],
  ): void {
    if (this.state.status === "closing") return;
    this.current = undefined;
    this.watchIdentity += 1;
    this.transition({ status: "terminal", generation: this.generation, cause });
  }

  private async runClose(): Promise<void> {
    if (this.state.status === "closing") return;
    this.transition({ status: "closing", generation: this.generation });
    this.controller.abort(new Error("desktop daemon lifecycle closing"));
    this.current = undefined;
    this.watchIdentity += 1;
    await requireSettlementBefore(
      this.resolver.close(),
      CLOSE_TIMEOUT_MS,
      "desktop daemon lifecycle close deadline exceeded",
    );
  }
}
