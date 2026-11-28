export type DesktopUpdateState =
  | { readonly status: "disabled" | "idle" | "checking" | "current" }
  | { readonly status: "downloading" | "downloaded" | "installing"; readonly version: string }
  | { readonly status: "restart-required"; readonly stage: "check" | "download" }
  | { readonly status: "failed"; readonly stage: "check" | "download" };

export type DesktopUpdatePendingAction = "none" | "hydrating" | "checking" | "restarting";

export interface DesktopUpdateBridge {
  getUpdateState(): Promise<DesktopUpdateState>;
  checkForUpdates(): Promise<DesktopUpdateState>;
  restartToUpdate(): Promise<DesktopUpdateState>;
  onUpdateState(listener: (state: DesktopUpdateState) => void): () => void;
}

export interface DesktopUpdateView {
  bind(handler: () => void): void;
  render(
    state: DesktopUpdateState,
    options?: { readonly pendingAction?: DesktopUpdatePendingAction },
  ): void;
  dispose(): void;
}

type RendererUpdatePhase =
  | { readonly kind: "hydrating"; readonly state: DesktopUpdateState }
  | { readonly kind: "ready"; readonly state: DesktopUpdateState }
  | {
      readonly kind: "checking";
      readonly state: DesktopUpdateState;
      readonly requestId: number;
    }
  | {
      readonly kind: "restarting";
      readonly state: DesktopUpdateState;
      readonly requestId: number;
    }
  | { readonly kind: "disposed" };

function canActivateState(state: DesktopUpdateState): boolean {
  return (
    state.status !== "disabled" &&
    state.status !== "checking" &&
    state.status !== "downloading" &&
    state.status !== "installing" &&
    state.status !== "restart-required"
  );
}

export function createDesktopUpdateController(input: {
  readonly bridge: DesktopUpdateBridge;
  readonly view: DesktopUpdateView;
}): { readonly start: () => Promise<void>; readonly dispose: () => void } {
  let phase: RendererUpdatePhase = { kind: "hydrating", state: { status: "idle" } };
  let revision = 0;
  let nextRequestId = 0;

  const renderCurrent = (): void => {
    if (phase.kind === "disposed") return;
    if (phase.kind === "ready") {
      input.view.render(phase.state);
      return;
    }
    input.view.render(phase.state, {
      pendingAction: phase.kind,
    });
  };

  const applyPushedState = (next: DesktopUpdateState): void => {
    if (phase.kind === "disposed") return;
    revision += 1;
    if (phase.kind === "hydrating" || phase.kind === "ready") {
      phase = { kind: "ready", state: next };
    } else {
      phase = { ...phase, state: next };
    }
    renderCurrent();
  };

  const unsubscribe = input.bridge.onUpdateState(applyPushedState);

  const activate = (): void => {
    if (phase.kind !== "ready" || !canActivateState(phase.state)) return;
    const restarting = phase.state.status === "downloaded";
    const action = restarting ? input.bridge.restartToUpdate : input.bridge.checkForUpdates;
    const before = revision;
    const requestId = ++nextRequestId;
    phase = restarting
      ? { kind: "restarting", state: phase.state, requestId }
      : { kind: "checking", state: phase.state, requestId };
    renderCurrent();
    void Promise.resolve()
      .then(() => action.call(input.bridge))
      .then(
        (next) => {
          if (
            (phase.kind !== "checking" && phase.kind !== "restarting") ||
            phase.requestId !== requestId
          ) {
            return;
          }
          if (revision === before) {
            revision += 1;
            phase = { kind: "ready", state: next };
          } else {
            phase = { kind: "ready", state: phase.state };
          }
          renderCurrent();
        },
        () => {
          if (
            (phase.kind !== "checking" && phase.kind !== "restarting") ||
            phase.requestId !== requestId
          ) {
            return;
          }
          if (
            phase.kind === "checking" &&
            (revision === before ||
              phase.state.status === "idle" ||
              phase.state.status === "checking" ||
              phase.state.status === "downloading")
          ) {
            const stage = phase.state.status === "downloading" ? "download" : "check";
            revision += 1;
            phase = { kind: "ready", state: { status: "failed", stage } };
            renderCurrent();
            return;
          }
          phase = { kind: "ready", state: phase.state };
          renderCurrent();
        },
      );
  };
  input.view.bind(activate);

  return {
    async start() {
      if (phase.kind !== "hydrating") return;
      const before = revision;
      try {
        const initial = await input.bridge.getUpdateState();
        if (phase.kind === "hydrating" && revision === before) {
          revision += 1;
          phase = { kind: "ready", state: initial };
          renderCurrent();
        }
      } catch {
        if (phase.kind === "hydrating" && revision === before) {
          revision += 1;
          phase = { kind: "ready", state: { status: "failed", stage: "check" } };
          renderCurrent();
        }
      }
    },
    dispose() {
      if (phase.kind === "disposed") return;
      phase = { kind: "disposed" };
      unsubscribe();
      input.view.dispose();
    },
  };
}
