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

export function createWallClockScheduler(input: CreateWallClockSchedulerInput): WallClockScheduler {
  if (!Number.isSafeInteger(input.cadenceMs) || input.cadenceMs <= 0) {
    throw new RangeError("cadenceMs must be a positive safe integer");
  }
  const dependencies: WallClockSchedulerDependencies = {
    nowEpochMs: input.dependencies?.nowEpochMs ?? Date.now,
    setTimeout: input.dependencies?.setTimeout ?? globalThis.setTimeout,
    clearTimeout: input.dependencies?.clearTimeout ?? globalThis.clearTimeout,
  };
  const onError = input.onError ?? (() => {});
  let started = false;
  let closed = false;
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  let activeRun: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;

  const schedule = (): void => {
    if (closed) return;
    const now = dependencies.nowEpochMs();
    const deadline = (Math.floor(now / input.cadenceMs) + 1) * input.cadenceMs;
    const delay = Math.max(0, deadline - dependencies.nowEpochMs());
    timer = dependencies.setTimeout(() => {
      timer = undefined;
      if (closed) return;
      const task = Promise.resolve().then(input.run);
      activeRun = task;
      void task
        .catch((error) => {
          try {
            onError(error);
          } catch {}
        })
        .finally(() => {
          if (activeRun === task) activeRun = undefined;
          schedule();
        });
    }, delay);
    timer.unref?.();
  };

  return {
    start() {
      if (started || closed) return;
      started = true;
      schedule();
    },
    close() {
      closePromise ??= (async () => {
        closed = true;
        if (timer !== undefined) {
          dependencies.clearTimeout(timer);
          timer = undefined;
        }
        try {
          await activeRun;
        } catch {}
      })();
      return closePromise;
    },
  };
}
