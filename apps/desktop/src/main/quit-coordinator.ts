import type { DesktopUpdateController } from "./update-controller.js";

export interface DesktopBeforeQuitEvent {
  preventDefault(): void;
}

export interface DesktopTerminationSignalSource {
  on(event: "SIGTERM", listener: () => void): unknown;
}

export function installDesktopTerminationSignalHandler(input: {
  readonly signalSource: DesktopTerminationSignalSource;
  readonly requestQuit: () => void;
  readonly forceQuit: () => void;
}): void {
  let quitRequested = false;
  let forceRequested = false;
  const requestQuit = (): void => {
    if (!quitRequested) {
      quitRequested = true;
      input.requestQuit();
      return;
    }
    if (forceRequested) return;
    forceRequested = true;
    input.forceQuit();
  };
  input.signalSource.on("SIGTERM", requestQuit);
}

interface DesktopShutdownTimerHandle {
  unref(): void;
}

type DesktopDrainOutcome = "drained" | "failed" | "timed-out" | "cancelled";

export const DESKTOP_SHUTDOWN_DEADLINE_MS = 30_000;

function waitForDesktopDrain(input: {
  readonly drain: () => Promise<void>;
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
  readonly setTimeout: (callback: () => void, delayMs: number) => DesktopShutdownTimerHandle;
  readonly clearTimeout: (handle: DesktopShutdownTimerHandle) => void;
}): Promise<DesktopDrainOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: DesktopShutdownTimerHandle | undefined;
    const finish = (outcome: DesktopDrainOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) input.clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onAbort = (): void => finish("cancelled");
    if (input.signal?.aborted === true) {
      finish("cancelled");
      return;
    }
    input.signal?.addEventListener("abort", onAbort, { once: true });
    const scheduled = input.setTimeout(() => finish("timed-out"), input.deadlineMs);
    timer = scheduled;
    if (settled) input.clearTimeout(scheduled);
    else scheduled.unref();
    try {
      void input.drain().then(
        () => finish("drained"),
        () => finish("failed"),
      );
    } catch {
      finish("failed");
    }
  });
}

export async function completeDesktopShutdown(input: {
  readonly drain: () => Promise<void>;
  readonly updateController: Pick<DesktopUpdateController, "completeInstallAfterDrain">;
  readonly allowFinalQuit: () => void;
  readonly exit: (code: number) => void;
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
  readonly setTimeout?: (callback: () => void, delayMs: number) => DesktopShutdownTimerHandle;
  readonly clearTimeout?: (handle: DesktopShutdownTimerHandle) => void;
}): Promise<void> {
  const drainOutcome = await waitForDesktopDrain({
    drain: input.drain,
    deadlineMs: input.deadlineMs ?? DESKTOP_SHUTDOWN_DEADLINE_MS,
    signal: input.signal,
    setTimeout:
      input.setTimeout ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs)),
    clearTimeout:
      input.clearTimeout ??
      ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>)),
  });
  if (drainOutcome === "cancelled") return;
  if (drainOutcome !== "drained") {
    input.exit(1);
    return;
  }
  if (input.signal?.aborted === true) return;
  let updateInstall: "started" | "not-requested" | "failed";
  try {
    updateInstall = input.updateController.completeInstallAfterDrain(input.allowFinalQuit);
  } catch {
    input.exit(1);
    return;
  }
  if (updateInstall === "started") {
    // quitAndInstall owns the real quit. Returning here skips app.exit, so a
    // MacUpdater deferred Squirrel handoff that never reaches ShipIt leaves
    // the process alive on Restarting.
    return;
  }
  if (updateInstall === "failed") {
    input.exit(1);
    return;
  }
  input.allowFinalQuit();
  input.exit(0);
}

export function createDesktopQuitCoordinator(input: {
  readonly drain: () => Promise<void>;
  readonly updateController: Pick<DesktopUpdateController, "completeInstallAfterDrain">;
  readonly exit: (code: number) => void;
  readonly deadlineMs?: number;
  readonly setTimeout?: (callback: () => void, delayMs: number) => DesktopShutdownTimerHandle;
  readonly clearTimeout?: (handle: DesktopShutdownTimerHandle) => void;
}): {
  readonly beforeQuit: (event: DesktopBeforeQuitEvent) => "allowed" | "draining";
  readonly forceQuit: () => void;
} {
  let drainPromise: Promise<void> | undefined;
  let finalQuitAllowed = false;
  let terminated = false;
  const cancellation = new AbortController();
  const exitOnce = (code: number): void => {
    if (terminated) return;
    terminated = true;
    cancellation.abort();
    input.exit(code);
  };
  return {
    beforeQuit(event) {
      if (finalQuitAllowed || terminated) return "allowed";
      event.preventDefault();
      drainPromise ??= completeDesktopShutdown({
        ...input,
        signal: cancellation.signal,
        exit: exitOnce,
        allowFinalQuit: () => {
          finalQuitAllowed = true;
        },
      });
      return "draining";
    },
    forceQuit() {
      exitOnce(1);
    },
  };
}
