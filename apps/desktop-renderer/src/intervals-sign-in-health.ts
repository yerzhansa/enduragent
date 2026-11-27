import {
  GetRuntimeConfigRpcResultSchema,
  type RuntimeConfigSnapshot,
} from "@enduragent/coach-contract";
import type { DesktopCoachClient, DesktopCoachClientProvider } from "./coach-client";
import type { IntervalsCredentialMutationResult } from "./onboarding/bridge";
import type { TrainingSyncCoordinator, TrainingSyncState } from "./training-sync";

export const NOT_IN_USE_RECHECK_MS = 30_000;

export interface IntervalsSignInHealthStore {
  getState(): { setIntervalsSignInRejected(rejected: boolean): void };
}

export interface IntervalsSignInHealth {
  readonly clients: DesktopCoachClientProvider;
  follow(
    coordinator: Pick<TrainingSyncCoordinator, "subscribe" | "request">,
    focusTarget: Pick<Window, "addEventListener" | "removeEventListener">,
  ): () => void;
  refresh(): Promise<void>;
  signedIn(
    result: Promise<IntervalsCredentialMutationResult>,
  ): Promise<IntervalsCredentialMutationResult>;
}

export function intervalsSignInRejected(snapshot: RuntimeConfigSnapshot): boolean {
  return snapshot.intervals.credential_rejected === true;
}

function signInNotInUse(state: TrainingSyncState): boolean {
  return state.status === "failed" && state.kind === "not-in-use";
}

function syncInProgress(state: TrainingSyncState): boolean {
  return state.status === "queued" || state.status === "running";
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

  const snapshotListeners = new Set<(snapshot: RuntimeConfigSnapshot) => void>();

  const observe = (response: Promise<unknown>): void => {
    const observed = ++revision;
    void Promise.allSettled([response]).then(([outcome]) => {
      if (outcome?.status !== "fulfilled") return;
      const snapshot = GetRuntimeConfigRpcResultSchema.safeParse(outcome.value);
      if (!snapshot.success) return;
      for (const listener of snapshotListeners) listener(snapshot.data);
      if (observed === revision) publish(intervalsSignInRejected(snapshot.data));
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
      let notInUse = false;
      let requestedForKey = false;
      let recheck: ReturnType<typeof setInterval> | undefined;
      const stopRecheck = (): void => {
        if (recheck !== undefined) clearInterval(recheck);
        recheck = undefined;
      };
      const onSnapshot = (snapshot: RuntimeConfigSnapshot): void => {
        if (!notInUse) return;
        if (!snapshot.intervals.credential_configured) {
          requestedForKey = false;
          return;
        }
        if (requestedForKey) return;
        requestedForKey = true;
        void coordinator.request();
      };
      snapshotListeners.add(onSnapshot);
      const unsubscribe = coordinator.subscribe((state) => {
        notInUse = signInNotInUse(state);
        if (!notInUse && !syncInProgress(state)) requestedForKey = false;
        if (!notInUse) stopRecheck();
        else recheck ??= setInterval(() => void refresh(), NOT_IN_USE_RECHECK_MS);
        if (state.status === "succeeded" || state.status === "failed") void refresh();
      });
      const onFocus = (): void => {
        void refresh();
      };
      focusTarget.addEventListener("focus", onFocus);
      void refresh();
      return () => {
        unsubscribe();
        stopRecheck();
        snapshotListeners.delete(onSnapshot);
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
