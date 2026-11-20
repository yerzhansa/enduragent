import {
  GetRuntimeConfigRpcResultSchema,
  type RuntimeConfigSnapshot,
} from "@enduragent/coach-contract";
import type { DesktopCoachClient, DesktopCoachClientProvider } from "./coach-client";
import type { IntervalsCredentialMutationResult } from "./onboarding/bridge";
import type { TrainingSyncCoordinator } from "./training-sync";

export interface IntervalsSignInHealthStore {
  getState(): { setIntervalsSignInRejected(rejected: boolean): void };
}

export interface IntervalsSignInHealth {
  readonly clients: DesktopCoachClientProvider;
  follow(
    coordinator: Pick<TrainingSyncCoordinator, "subscribe">,
    focusTarget: Pick<Window, "addEventListener" | "removeEventListener">,
  ): () => void;
  refresh(): Promise<void>;
  signedIn(
    result: Promise<IntervalsCredentialMutationResult>,
  ): Promise<IntervalsCredentialMutationResult>;
}

export function intervalsSignInRejected(snapshot: RuntimeConfigSnapshot): boolean {
  return (
    snapshot.intervals.credential_configured && snapshot.intervals.credential_rejected === true
  );
}

export function createIntervalsSignInHealth(
  provider: DesktopCoachClientProvider,
  store: IntervalsSignInHealthStore,
): IntervalsSignInHealth {
  const wrappers = new WeakMap<DesktopCoachClient, DesktopCoachClient>();
  const originals = new WeakMap<DesktopCoachClient, DesktopCoachClient>();
  let revision = 0;

  const publish = (rejected: boolean): void => {
    store.getState().setIntervalsSignInRejected(rejected);
  };

  const observe = (response: Promise<unknown>): void => {
    const observed = ++revision;
    void Promise.allSettled([response]).then(([outcome]) => {
      if (observed !== revision || outcome?.status !== "fulfilled") return;
      const snapshot = GetRuntimeConfigRpcResultSchema.safeParse(outcome.value);
      if (snapshot.success) publish(intervalsSignInRejected(snapshot.data));
    });
  };

  const watch = (client: DesktopCoachClient): DesktopCoachClient => {
    const existing = wrappers.get(client);
    if (existing !== undefined) return existing;
    const wrapper: DesktopCoachClient = {
      handshake: client.handshake,
      call(method, request, options) {
        const response =
          options === undefined
            ? client.call(method, request)
            : client.call(method, request, options);
        if (method === "getRuntimeConfig") observe(response);
        return response;
      },
    };
    wrappers.set(client, wrapper);
    originals.set(wrapper, client);
    return wrapper;
  };

  const clients: DesktopCoachClientProvider = {
    getClient: () => provider.getClient().then(watch),
    reconnect: (failedClient) =>
      provider
        .reconnect(
          failedClient === undefined ? undefined : (originals.get(failedClient) ?? failedClient),
        )
        .then(watch),
    close: () => provider.close(),
  };

  const refresh = async (): Promise<void> => {
    await Promise.allSettled([
      clients.getClient().then((client) => client.call("getRuntimeConfig", {})),
    ]);
  };

  return {
    clients,
    refresh,
    follow(coordinator, focusTarget) {
      const unsubscribe = coordinator.subscribe((state) => {
        if (state.status === "succeeded" || state.status === "failed") void refresh();
      });
      const onFocus = (): void => {
        void refresh();
      };
      focusTarget.addEventListener("focus", onFocus);
      void refresh();
      return () => {
        unsubscribe();
        focusTarget.removeEventListener("focus", onFocus);
      };
    },
    signedIn(result) {
      return result.then((value) => {
        if (value.outcome === "applied") {
          revision += 1;
          publish(false);
        }
        return value;
      });
    },
  };
}
