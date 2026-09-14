import { CoachClientDisconnectedError } from "@enduragent/coach-client";
import type { SpendSummary } from "@enduragent/coach-contract";
import type { DesktopCoachClient, DesktopCoachClientProvider } from "../coach-client";

export const SPEND_REFRESH_INTERVAL_MS = 30_000;

type DailyCapUsd = number & { readonly __brand: "DailyCapUsd" };

export type SpendCapDraft =
  | { readonly kind: "invalid"; readonly text: string }
  | { readonly kind: "valid"; readonly text: string; readonly value: DailyCapUsd };

export type SpendCapOperation =
  | { readonly kind: "idle" }
  | { readonly kind: "saving" }
  | {
      readonly kind: "error";
      readonly reason: "request-failed" | "not-applied";
    };

export interface SpendMeterState {
  readonly status: "loading" | "ready" | "unavailable";
  readonly summary: SpendSummary | null;
  readonly stale: boolean;
  readonly capDraft: SpendCapDraft;
  readonly capOperation: SpendCapOperation;
}

export const INITIAL_SPEND_METER_STATE: SpendMeterState = Object.freeze({
  status: "loading",
  summary: null,
  stale: false,
  capDraft: Object.freeze({ kind: "invalid", text: "" }),
  capOperation: Object.freeze({ kind: "idle" }),
});

export interface SpendMeterView {
  bind(handlers: {
    readonly onChangeCap: (value: string) => void;
    readonly onCommitCap: () => void;
    readonly onRetryCap: () => void;
  }): void;
  render(state: SpendMeterState): void;
  dispose(): void;
}

export interface SpendMeterController {
  start(): void;
  refresh(): Promise<void>;
  commitCap(): Promise<void>;
  retryCap(): Promise<void>;
  dispose(): void;
}

interface CommittedCap {
  readonly revision: number;
  readonly value: DailyCapUsd;
}

function parseCapDraft(text: string): SpendCapDraft {
  if (text.trim().length === 0) return { kind: "invalid", text };
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) return { kind: "invalid", text };
  return { kind: "valid", text, value: value as DailyCapUsd };
}

function capDraftFromSummary(summary: SpendSummary): SpendCapDraft {
  return parseCapDraft(String(summary.dailyCapUsd));
}

function isSaveFailure(operation: SpendCapOperation): boolean {
  return operation.kind === "error";
}

export function createSpendMeterController(input: {
  readonly clients: DesktopCoachClientProvider;
  readonly view: SpendMeterView;
  readonly setInterval?: typeof globalThis.setInterval;
  readonly clearInterval?: typeof globalThis.clearInterval;
}): SpendMeterController {
  const schedule = input.setInterval ?? globalThis.setInterval;
  const cancel = input.clearInterval ?? globalThis.clearInterval;
  let currentState = INITIAL_SPEND_METER_STATE;
  let started = false;
  let disposed = false;
  let hadSummary = false;
  let draftRevision = 0;
  let draftDirty = false;
  let interval: ReturnType<typeof globalThis.setInterval> | undefined;
  let refreshOperation: Promise<void> | undefined;
  let saveOperation: Promise<void> | undefined;
  let postSaveRefresh: Promise<void> | undefined;
  let queuedCap: CommittedCap | undefined;
  let reconnectRequired = false;
  let failedClient: DesktopCoachClient | undefined;
  let recoveryRequired = false;

  const render = (state: SpendMeterState): void => {
    currentState = state;
    if (!disposed) input.view.render(state);
  };

  const renderSummary = (summary: SpendSummary, stale: boolean): void => {
    hadSummary = true;
    render({
      ...currentState,
      status: "ready",
      summary,
      stale,
      capDraft: draftDirty ? currentState.capDraft : capDraftFromSummary(summary),
    });
  };

  const clientForOperation = async (): Promise<DesktopCoachClient> => {
    if (!reconnectRequired) return input.clients.getClient();
    const current = await input.clients.getClient();
    const client =
      failedClient === undefined || current === failedClient
        ? await input.clients.reconnect(
            failedClient === undefined
              ? { kind: "replace-current" }
              : { kind: "failed-client", client: failedClient },
          )
        : current;
    reconnectRequired = false;
    failedClient = undefined;
    return client;
  };

  const noteFailure = (error: unknown, client: DesktopCoachClient | undefined): void => {
    if (error instanceof CoachClientDisconnectedError) {
      reconnectRequired = true;
      failedClient = client;
    }
  };

  const executeRefresh = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (refreshOperation !== undefined) return refreshOperation;
    let activeClient: DesktopCoachClient | undefined;
    const pending = Promise.resolve()
      .then(async () => {
        activeClient = await clientForOperation();
        return activeClient.call("getSpendSummary", {});
      })
      .then(
        (summary) => {
          if (!disposed) renderSummary(summary, false);
        },
        (error: unknown) => {
          noteFailure(error, activeClient);
          if (disposed) return;
          if (hadSummary && currentState.summary !== null) {
            render({ ...currentState, status: "ready", stale: true });
            return;
          }
          render({ ...currentState, status: "unavailable", summary: null, stale: false });
        },
      )
      .finally(() => {
        if (refreshOperation === pending) refreshOperation = undefined;
      });
    refreshOperation = pending;
    return pending;
  };

  const refresh = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (saveOperation === undefined) return executeRefresh();
    if (postSaveRefresh !== undefined) return postSaveRefresh;
    const activeSave = saveOperation;
    const pending = activeSave
      .catch(() => undefined)
      .then(() => executeRefresh())
      .finally(() => {
        if (postSaveRefresh === pending) postSaveRefresh = undefined;
      });
    postSaveRefresh = pending;
    return pending;
  };

  const applyAuthoritativeCap = (
    summary: SpendSummary,
    committed: CommittedCap,
  ): "applied" | "not-applied" => {
    const currentDraftIsCommit = draftRevision === committed.revision;
    const applied = summary.dailyCapUsd === committed.value;
    if (applied && currentDraftIsCommit) draftDirty = false;
    render({
      ...currentState,
      status: "ready",
      summary,
      stale: false,
      capDraft:
        applied && currentDraftIsCommit ? capDraftFromSummary(summary) : currentState.capDraft,
      capOperation: { kind: "saving" },
    });
    recoveryRequired = !applied;
    return applied ? "applied" : "not-applied";
  };

  const drain = async (): Promise<void> => {
    while (!disposed && queuedCap !== undefined) {
      const committed = queuedCap;
      queuedCap = undefined;
      const authority = currentState.summary;
      if (authority !== null && authority.dailyCapUsd === committed.value) {
        if (draftRevision === committed.revision) draftDirty = false;
        continue;
      }
      let activeClient: DesktopCoachClient | undefined;
      try {
        activeClient = await clientForOperation();
        const summary = await activeClient.call("setDailySpendCap", {
          dailyCapUsd: committed.value,
        });
        if (disposed) return;
        if (
          applyAuthoritativeCap(summary, committed) === "not-applied" &&
          queuedCap === undefined
        ) {
          render({
            ...currentState,
            capOperation: { kind: "error", reason: "not-applied" },
          });
          return;
        }
      } catch (error) {
        noteFailure(error, activeClient);
        recoveryRequired = true;
        if (disposed) return;
        if (queuedCap === undefined) {
          render({
            ...currentState,
            capOperation: { kind: "error", reason: "request-failed" },
          });
          return;
        }
        await executeRefresh();
        if (disposed) return;
        if (currentState.status === "unavailable" || currentState.stale) {
          render({
            ...currentState,
            capOperation: { kind: "error", reason: "request-failed" },
          });
          return;
        }
        recoveryRequired = false;
      }
    }
    if (disposed) return;
    render({
      ...currentState,
      capOperation: { kind: "idle" },
    });
  };

  const startDrain = (waitForRefresh = true): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (saveOperation !== undefined) return saveOperation;
    const olderRefresh = waitForRefresh ? refreshOperation : undefined;
    render({ ...currentState, capOperation: { kind: "saving" } });
    const pending = Promise.resolve()
      .then(async () => {
        await olderRefresh?.catch(() => undefined);
        if (!disposed) await drain();
      })
      .finally(() => {
        if (saveOperation === pending) saveOperation = undefined;
      });
    saveOperation = pending;
    return pending;
  };

  const recoverAndDrain = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (saveOperation !== undefined) return saveOperation;
    render({ ...currentState, capOperation: { kind: "saving" } });
    const pending = Promise.resolve()
      .then(async () => {
        await refreshOperation?.catch(() => undefined);
        await executeRefresh();
        if (disposed) return;
        if (currentState.status === "unavailable" || currentState.stale) {
          render({
            ...currentState,
            capOperation: { kind: "error", reason: "request-failed" },
          });
          return;
        }
        recoveryRequired = false;
        if (queuedCap === undefined && currentState.capDraft.kind === "valid") {
          queuedCap = { revision: draftRevision, value: currentState.capDraft.value };
        }
        await drain();
      })
      .finally(() => {
        if (saveOperation === pending) saveOperation = undefined;
      });
    saveOperation = pending;
    return pending;
  };

  const changeCap = (value: string): void => {
    if (disposed) return;
    draftRevision += 1;
    draftDirty = true;
    const operation = currentState.capOperation;
    render({
      ...currentState,
      capDraft: parseCapDraft(value),
      capOperation: operation.kind === "error" ? { kind: "idle" } : operation,
    });
  };

  const commitCap = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (currentState.capDraft.kind === "invalid") {
      return Promise.resolve();
    }
    queuedCap = { revision: draftRevision, value: currentState.capDraft.value };
    if (recoveryRequired || isSaveFailure(currentState.capOperation)) return recoverAndDrain();
    return startDrain();
  };

  const retryCap = (): Promise<void> => {
    if (
      disposed ||
      !isSaveFailure(currentState.capOperation) ||
      currentState.capDraft.kind === "invalid"
    ) {
      return Promise.resolve();
    }
    return recoverAndDrain();
  };

  input.view.bind({
    onChangeCap: changeCap,
    onCommitCap: () => void commitCap(),
    onRetryCap: () => void retryCap(),
  });

  return {
    start() {
      if (started || disposed) return;
      started = true;
      render(INITIAL_SPEND_METER_STATE);
      void refresh();
      interval = schedule(() => void refresh(), SPEND_REFRESH_INTERVAL_MS);
    },
    refresh,
    commitCap,
    retryCap,
    dispose() {
      if (disposed) return;
      disposed = true;
      queuedCap = undefined;
      if (interval !== undefined) cancel(interval);
      interval = undefined;
      refreshOperation = undefined;
      saveOperation = undefined;
      postSaveRefresh = undefined;
      input.view.dispose();
    },
  };
}
