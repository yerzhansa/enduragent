export interface WallClockSchedulerDependencies {
  readonly nowEpochMs: () => number;
  readonly setTimeout: typeof globalThis.setTimeout;
  readonly clearTimeout: typeof globalThis.clearTimeout;
}

export interface WallClockScheduler {
  start(): void;
  close(): Promise<void>;
}

export interface CreateWallClockSchedulerInput {
  readonly cadenceMs: number;
  readonly run: () => Promise<void>;
  readonly onError?: (error: unknown) => void;
  readonly dependencies?: Partial<WallClockSchedulerDependencies>;
}

const MAX_WAIT_MS = 60_000;

export function createWallClockScheduler(input: CreateWallClockSchedulerInput): WallClockScheduler {
  if (!Number.isSafeInteger(input.cadenceMs) || input.cadenceMs <= 0) {
    throw new RangeError("cadenceMs must be a positive safe integer");
  }
  const dependencies: WallClockSchedulerDependencies = {
    nowEpochMs: input.dependencies?.nowEpochMs ?? Date.now,
    setTimeout: input.dependencies?.setTimeout ?? globalThis.setTimeout,
    clearTimeout: input.dependencies?.clearTimeout ?? globalThis.clearTimeout,
  };
  let started = false;
  let closed = false;
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let activeRun: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;

  const schedule = (now: number): void => {
    if (closed) return;
    const deadline = (Math.floor(now / input.cadenceMs) + 1) * input.cadenceMs;
    const delay = Math.min(deadline - now, MAX_WAIT_MS);
    timer = dependencies.setTimeout(() => {
      timer = undefined;
      if (closed) return;
      const firedAt = dependencies.nowEpochMs();
      if (firedAt < deadline) {
        schedule(firedAt);
        return;
      }
      activeRun = Promise.resolve()
        .then(input.run)
        .catch((error: unknown) => input.onError?.(error))
        .finally(() => {
          activeRun = undefined;
          schedule(dependencies.nowEpochMs());
        });
    }, delay);
    timer.unref?.();
  };

  return {
    start() {
      if (started || closed) return;
      started = true;
      schedule(dependencies.nowEpochMs());
    },
    close() {
      closePromise ??= (async () => {
        closed = true;
        if (timer !== undefined) {
          dependencies.clearTimeout(timer);
          timer = undefined;
        }
        await activeRun;
      })();
      return closePromise;
    },
  };
}
