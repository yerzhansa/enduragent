import { createSafeLog } from "./safe-log.js";
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

type QuitUpdateController = Pick<DesktopUpdateController, "completeInstallAfterDrain"> &
  Partial<Pick<DesktopUpdateController, "isInstallRequested">>;

type QuitCoordinatorPhase =
  | { readonly kind: "running" }
  | { readonly kind: "draining"; readonly intent: "quit" | "update-install" }
  | { readonly kind: "handing-off"; handoffTimer?: DesktopShutdownTimerHandle }
  | { readonly kind: "handoff-accepted" }
  | { readonly kind: "terminated" };

export const DESKTOP_SHUTDOWN_DEADLINE_MS = 30_000;
export const DESKTOP_UPDATE_HANDOFF_DEADLINE_MS = 30_000;

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
  readonly updateController: QuitUpdateController;
  readonly allowFinalQuit: () => void;
  readonly revokeFinalQuit?: () => void;
  readonly exit: (code: number) => void;
  readonly relaunch?: () => void;
  readonly log?: (message: string) => void;
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
  readonly updaterQuitAccepted?: () => boolean;
  readonly retainHandoffTimer?: (handle: DesktopShutdownTimerHandle) => void;
  readonly handoffDeadlineMs?: number;
  readonly setTimeout?: (callback: () => void, delayMs: number) => DesktopShutdownTimerHandle;
  readonly clearTimeout?: (handle: DesktopShutdownTimerHandle) => void;
}): Promise<void> {
  const log = createSafeLog(input.log);
  const isAborted = (): boolean => input.signal?.aborted === true;
  const installRequested = input.updateController.isInstallRequested?.() === true;
  let relaunched = false;
  const relaunchAndExit = (code: number): void => {
    if (isAborted() || relaunched) return;
    relaunched = true;
    if (input.relaunch !== undefined) {
      try {
        input.relaunch();
      } catch {
        log("desktop-update-relaunch-failed");
      }
    }
    input.exit(code);
  };
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
  if (drainOutcome === "cancelled" || isAborted()) return;
  if (drainOutcome !== "drained") {
    if (installRequested) relaunchAndExit(1);
    else input.exit(1);
    return;
  }
  let updateInstall: "started" | "not-requested" | "failed";
  try {
    updateInstall = input.updateController.completeInstallAfterDrain(input.allowFinalQuit, () => {
      if (isAborted() || input.updaterQuitAccepted?.() === true) return;
      input.revokeFinalQuit?.();
      log("desktop-update-install-error");
      relaunchAndExit(1);
    });
  } catch {
    input.revokeFinalQuit?.();
    if (installRequested) relaunchAndExit(1);
    else if (!isAborted()) input.exit(1);
    return;
  }
  if (updateInstall === "started") {
    if (isAborted() || input.updaterQuitAccepted?.() === true) return;
    const scheduleTimeout =
      input.setTimeout ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
    const handle = scheduleTimeout(() => {
      if (isAborted() || input.updaterQuitAccepted?.() === true) return;
      input.revokeFinalQuit?.();
      log("desktop-update-handoff-timeout");
      relaunchAndExit(1);
    }, input.handoffDeadlineMs ?? DESKTOP_UPDATE_HANDOFF_DEADLINE_MS);
    handle.unref();
    input.retainHandoffTimer?.(handle);
    return;
  }
  if (updateInstall === "failed") {
    input.revokeFinalQuit?.();
    relaunchAndExit(1);
    return;
  }
  input.allowFinalQuit();
  input.exit(0);
}

export function createDesktopQuitCoordinator(input: {
  readonly drain: () => Promise<void>;
  readonly updateController: QuitUpdateController;
  readonly exit: (code: number) => void;
  readonly relaunch?: () => void;
  readonly log?: (message: string) => void;
  readonly deadlineMs?: number;
  readonly handoffDeadlineMs?: number;
  readonly setTimeout?: (callback: () => void, delayMs: number) => DesktopShutdownTimerHandle;
  readonly clearTimeout?: (handle: DesktopShutdownTimerHandle) => void;
}): {
  readonly beforeQuit: (event: DesktopBeforeQuitEvent) => "allowed" | "draining";
  readonly forceQuit: () => void;
} {
  const log = createSafeLog(input.log);
  let phase: QuitCoordinatorPhase = { kind: "running" };
  const cancellation = new AbortController();
  const cancelTimeout =
    input.clearTimeout ??
    ((handle: DesktopShutdownTimerHandle) =>
      globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>));
  const clearTimer = (handle: DesktopShutdownTimerHandle | undefined): undefined => {
    if (handle === undefined) return undefined;
    try {
      cancelTimeout(handle);
    } catch {
      log("desktop-quit-timer-cleanup-failed");
    }
    return undefined;
  };
  const exitOnce = (code: number): void => {
    if (phase.kind === "terminated") return;
    if (phase.kind === "handing-off") {
      phase.handoffTimer = clearTimer(phase.handoffTimer);
    }
    phase = { kind: "terminated" };
    cancellation.abort();
    input.exit(code);
  };
  return {
    beforeQuit(event) {
      if (phase.kind === "terminated" || phase.kind === "handoff-accepted") {
        return "allowed";
      }
      if (phase.kind === "handing-off") {
        phase.handoffTimer = clearTimer(phase.handoffTimer);
        phase = { kind: "handoff-accepted" };
        return "allowed";
      }
      event.preventDefault();
      if (phase.kind === "draining") return "draining";
      const intent =
        input.updateController.isInstallRequested?.() === true ? "update-install" : "quit";
      phase = { kind: "draining", intent };
      void completeDesktopShutdown({
        ...input,
        signal: cancellation.signal,
        exit: exitOnce,
        updaterQuitAccepted: () => phase.kind === "handoff-accepted",
        retainHandoffTimer: (handle) => {
          if (phase.kind !== "handing-off") {
            clearTimer(handle);
            return;
          }
          phase.handoffTimer = handle;
        },
        allowFinalQuit: () => {
          if (phase.kind === "draining") phase = { kind: "handing-off" };
        },
        revokeFinalQuit: () => {
          if (phase.kind !== "handing-off") return;
          phase.handoffTimer = clearTimer(phase.handoffTimer);
          phase = { kind: "draining", intent };
        },
      });
      return "draining";
    },
    forceQuit() {
      exitOnce(1);
    },
  };
}
