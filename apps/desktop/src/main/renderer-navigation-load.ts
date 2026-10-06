export const RENDERER_NAVIGATION_LOAD_ATTEMPTS = 3;
export const RENDERER_NAVIGATION_LOAD_RETRY_DELAY_MS = 250;

export interface DesktopRendererNavigation<Window> {
  readonly window: Window;
  readonly url: string;
  readonly task: Promise<void>;
}

export interface DesktopRendererNavigationTracker<Window> {
  start(
    window: Window,
    url: string,
    load: () => Promise<void>,
  ): DesktopRendererNavigation<Window>;
  waitForCurrent(navigation: DesktopRendererNavigation<Window>): Promise<void>;
}

export interface DesktopRendererNavigationTrackerOptions {
  readonly attempts?: number;
  readonly retryDelay?: () => Promise<void>;
}

function isAbortedNavigationRejection(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const rejection = error as { readonly code?: unknown; readonly errno?: unknown };
  return rejection.errno === -3 || rejection.code === "ERR_ABORTED";
}

function attemptLoad(load: () => Promise<void>): Promise<void> {
  try {
    return load();
  } catch (error) {
    return Promise.reject(error);
  }
}

export function createDesktopRendererNavigationTracker<Window>(
  options: DesktopRendererNavigationTrackerOptions = {},
): DesktopRendererNavigationTracker<Window> {
  const attempts = options.attempts ?? RENDERER_NAVIGATION_LOAD_ATTEMPTS;
  const retryDelay =
    options.retryDelay ??
    (() =>
      new Promise<void>((resolve) =>
        setTimeout(resolve, RENDERER_NAVIGATION_LOAD_RETRY_DELAY_MS),
      ));
  let current: DesktopRendererNavigation<Window> | undefined;

  return {
    start(window, url, load) {
      let remainingAttempts = attempts;
      const guard = (task: Promise<void>): Promise<void> => {
        remainingAttempts -= 1;
        return task.catch(async (error: unknown) => {
          if (
            remainingAttempts < 1 ||
            current !== navigation ||
            isAbortedNavigationRejection(error)
          ) {
            throw error;
          }
          await retryDelay();
          if (current !== navigation) throw error;
          return guard(attemptLoad(load));
        });
      };
      const task = guard(attemptLoad(load));
      const navigation = { window, url, task };
      current = navigation;
      void task.catch(() => {});
      return navigation;
    },
    async waitForCurrent(navigation) {
      let candidate = navigation;
      for (;;) {
        try {
          await candidate.task;
        } catch (error) {
          const replacement = current;
          if (
            replacement !== undefined &&
            replacement !== candidate &&
            replacement.window === candidate.window
          ) {
            candidate = replacement;
            continue;
          }
          throw error;
        }
        const replacement = current;
        if (replacement === candidate) return;
        if (replacement === undefined || replacement.window !== candidate.window) {
          throw new Error("desktop renderer navigation superseded");
        }
        candidate = replacement;
      }
    },
  };
}
