import type { OnboardingCompletion } from "./machine";

const COMPLETION_STORAGE_KEY = "enduragent.desktop.onboarding";
const COMPLETION_STORAGE_VALUE = '{"version":1,"completed":true}';

export interface OnboardingCompletionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface OnboardingCompletionController {
  isCompleted(): boolean;
  openOnStartup(openSetup: () => Promise<void>): Promise<void>;
  openManually(openSetup: () => Promise<void>): Promise<void>;
  complete(completion: OnboardingCompletion): void;
}

export function createOnboardingCompletionController(options: {
  readonly storage: () => OnboardingCompletionStorage;
  readonly onComplete: (completion: OnboardingCompletion) => void;
}): OnboardingCompletionController {
  const storedCompletion = (): boolean => {
    try {
      return options.storage().getItem(COMPLETION_STORAGE_KEY) === COMPLETION_STORAGE_VALUE;
    } catch {
      return false;
    }
  };
  let completionObserved = storedCompletion();
  const completed = (): boolean => completionObserved || storedCompletion();

  return {
    isCompleted: completed,
    openOnStartup(openSetup) {
      return completed() ? Promise.resolve() : openSetup();
    },
    openManually: (openSetup) => openSetup(),
    complete(completion) {
      const firstCompletion = !completed();
      completionObserved = true;
      try {
        options.storage().setItem(COMPLETION_STORAGE_KEY, COMPLETION_STORAGE_VALUE);
      } catch {}
      if (firstCompletion) options.onComplete(completion);
    },
  };
}
