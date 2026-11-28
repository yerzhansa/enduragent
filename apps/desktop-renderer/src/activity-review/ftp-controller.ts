import type {
  PlanCalendarFtpAnswer,
  PlanCalendarFtpExpected,
  PlanCalendarFtpOutcome,
  PlanCalendarFtpRead,
  PlanCalendarRpcResult,
} from "@enduragent/coach-contract";

export type FtpNotice = PlanCalendarFtpOutcome | "failed";

export type FtpPanelState =
  | { readonly kind: "loading"; readonly open: boolean }
  | { readonly kind: "unavailable"; readonly open: boolean }
  | {
      readonly kind: "ready";
      readonly read: PlanCalendarFtpRead;
      readonly open: boolean;
      readonly busy: PlanCalendarFtpAnswer | null;
      readonly notice: FtpNotice;
    };

export const FTP_PANEL_START: FtpPanelState = Object.freeze({ kind: "loading", open: false });

export interface FtpController {
  load(): Promise<void>;
  open(): void;
  close(): void;
  answer(answer: PlanCalendarFtpAnswer): Promise<void>;
}

export interface FtpControllerDeps {
  read(): Promise<PlanCalendarRpcResult>;
  answer(request: {
    readonly answer: PlanCalendarFtpAnswer;
    readonly expected: PlanCalendarFtpExpected;
  }): Promise<PlanCalendarRpcResult>;
  publish(state: FtpPanelState): void;
  written(): void;
}

export function createFtpController(deps: FtpControllerDeps): FtpController {
  let state: FtpPanelState = FTP_PANEL_START;
  let generation = 0;
  const publish = (next: FtpPanelState): void => {
    state = next;
    deps.publish(next);
  };
  const load = async (): Promise<void> => {
    generation += 1;
    const mine = generation;
    if (state.kind !== "ready") publish({ kind: "loading", open: state.open });
    let result: PlanCalendarRpcResult | null;
    try {
      result = await deps.read();
    } catch {
      result = null;
    }
    if (mine !== generation) return;
    if (result?.status !== "ftp") {
      if (state.kind !== "ready") publish({ kind: "unavailable", open: state.open });
      return;
    }
    publish(
      state.kind === "ready"
        ? { ...state, read: result }
        : { kind: "ready", read: result, open: state.open, busy: null, notice: "none" },
    );
  };
  return {
    load,
    open() {
      publish(
        state.kind === "ready"
          ? { ...state, open: true, notice: "none" }
          : { ...state, open: true },
      );
      void load();
    },
    close() {
      if (state.kind === "ready" && state.busy !== null) return;
      publish({ ...state, open: false });
    },
    async answer(answer) {
      if (state.kind !== "ready" || state.busy !== null) return;
      const proposal = state.read.proposal;
      if (proposal.kind === "none") return;
      generation += 1;
      publish({ ...state, busy: answer, notice: "none" });
      let result: PlanCalendarRpcResult | null;
      try {
        result = await deps.answer({
          answer,
          expected: { kind: proposal.kind, watts: proposal.watts },
        });
      } catch {
        result = null;
      }
      const current = state;
      if (current.kind !== "ready") return;
      publish(
        result?.status === "ftp"
          ? { ...current, read: result, busy: null, notice: result.outcome }
          : { ...current, busy: null, notice: "failed" },
      );
      if (result?.status === "ftp" && result.outcome === "written") deps.written();
    },
  };
}
