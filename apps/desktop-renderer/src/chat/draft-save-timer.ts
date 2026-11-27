export const DRAFT_SAVE_DELAY_MS = 300;

export interface DraftSaveTimer {
  schedule(run: () => void): void;
  cancel(): void;
}

export function createDraftSaveTimer(delayMs = DRAFT_SAVE_DELAY_MS): DraftSaveTimer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  return {
    schedule(run) {
      cancel();
      timer = setTimeout(() => {
        timer = null;
        run();
      }, delayMs);
    },
    cancel,
  };
}
