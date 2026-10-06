import type { LanguageTag } from "@enduragent/coach-contract";
import type { CoachClient } from "@enduragent/coach-client";

export interface LanguagePreferenceViewState {
  readonly status: "loading" | "ready" | "saving" | "unavailable";
  readonly value: LanguageTag | null;
}

export function createLanguageSettingsController(input: {
  readonly clients: { getClient(): Promise<Pick<CoachClient, "call">> };
  readonly view: { render(state: LanguagePreferenceViewState): void };
}) {
  let disposed = false;
  let tail = Promise.resolve();
  let started: Promise<void> | undefined;
  let state: LanguagePreferenceViewState = { status: "loading", value: null };

  const publish = (next: LanguagePreferenceViewState): void => {
    if (disposed) return;
    state = next;
    input.view.render(state);
  };

  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    const task = tail.then(async () => {
      if (!disposed) await operation();
    });
    tail = task.catch(() => {});
    return task;
  };

  const refresh = (): Promise<void> =>
    enqueue(async () => {
      publish({ ...state, status: "loading" });
      try {
        const client = await input.clients.getClient();
        if (disposed) return;
        const result = await client.call("getLanguagePreference", {});
        publish({ status: "ready", value: result.value });
      } catch {
        publish({ ...state, status: "unavailable" });
      }
    });

  publish(state);
  return {
    start(): Promise<void> {
      started ??= refresh();
      return started;
    },
    refresh,
    set(value: LanguageTag | null): Promise<void> {
      return enqueue(async () => {
        const previous = state.value;
        publish({ status: "saving", value: previous });
        try {
          const client = await input.clients.getClient();
          if (disposed) return;
          const result = await client.call("setLanguagePreference", { value });
          publish({ status: "ready", value: result.value });
        } catch {
          publish({ status: "unavailable", value: previous });
        }
      });
    },
    dispose(): void {
      disposed = true;
    },
  };
}
