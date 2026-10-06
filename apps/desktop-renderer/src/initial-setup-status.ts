export const INITIAL_SETUP_SETTLED_REPORT_ATTEMPTS = 3;
export const INITIAL_SETUP_SETTLED_REPORT_RETRY_DELAY_MS = 1_000;

export function settleInitialSetupStatus(input: {
  readonly captureGeneration: () => Promise<number>;
  readonly open: () => Promise<void>;
  readonly markSettled: () => void;
  readonly reportSettled: (generation: number) => Promise<void>;
  readonly reportFailure: () => void;
  readonly retryDelay?: () => Promise<void>;
}): void {
  const retryDelay =
    input.retryDelay ??
    (() =>
      new Promise<void>((resolve) =>
        setTimeout(resolve, INITIAL_SETUP_SETTLED_REPORT_RETRY_DELAY_MS),
      ));
  const report = async (generation: number): Promise<void> => {
    for (let attempt = 1; attempt <= INITIAL_SETUP_SETTLED_REPORT_ATTEMPTS; attempt += 1) {
      try {
        await input.reportSettled(generation);
        return;
      } catch {
        if (attempt === INITIAL_SETUP_SETTLED_REPORT_ATTEMPTS) {
          input.reportFailure();
          return;
        }
      }
      await retryDelay();
    }
  };
  let generation: Promise<number | undefined>;
  try {
    generation = input.captureGeneration().then(
      (value) => value,
      () => {
        input.reportFailure();
        return undefined;
      },
    );
  } catch {
    input.reportFailure();
    generation = Promise.resolve(undefined);
  }
  void input
    .open()
    .finally(() => {
      input.markSettled();
      void generation.then((value) => {
        if (value === undefined) return;
        void report(value);
      });
    })
    .catch(() => {});
}
