export const DRAFT_SAVE_DELAY_MS = 300;

export interface DraftSaveTimer {
  schedule(run: () => void): void;
  cancel(): void;
  flush(): void;
}

export function createDraftSaveTimer(delayMs = DRAFT_SAVE_DELAY_MS): DraftSaveTimer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: (() => void) | null = null;
  const cancel = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending = null;
  };
  return {
    schedule(run) {
      cancel();
      pending = run;
      timer = setTimeout(() => {
        const task = pending;
        timer = null;
        pending = null;
        task?.();
      }, delayMs);
    },
    cancel,
    flush() {
      const task = pending;
      cancel();
      task?.();
    },
  };
}
