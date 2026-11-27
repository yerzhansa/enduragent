import type { PlanCalendarRpcResult } from "@enduragent/coach-contract";
import { approvalFor, firstApproval, sendingFailures, type ApprovalScope } from "./approval";
import type { CalendarRefresh } from "./controller";
import type { PlanCalendarRead } from "./grid";

export type ApproveSheetState =
  | { readonly kind: "closed" }
  | { readonly kind: "open"; readonly scope: ApprovalScope }
  | { readonly kind: "approving"; readonly scope: ApprovalScope }
  | {
      readonly kind: "sending";
      readonly scope: ApprovalScope;
      readonly weeks: readonly number[];
      readonly polls: number;
    }
  | {
      readonly kind: "send-failed";
      readonly scope: ApprovalScope;
      readonly weeks: readonly number[];
    }
  | { readonly kind: "refused"; readonly scope: ApprovalScope };

export const APPROVE_SHEET_CLOSED: ApproveSheetState = Object.freeze({ kind: "closed" });

export const SENDING_POLLS = 20;

export interface ApproveController {
  pageOpened(): void;
  observe(read: PlanCalendarRead, refresh: CalendarRefresh): void;
  open(scope: ApprovalScope): void;
  approve(): Promise<void>;
  notNow(): void;
  retry(): Promise<void>;
  dispose(): void;
}

export interface ApproveControllerDeps {
  approve(input: {
    readonly planId: string;
    readonly scope: ApprovalScope;
  }): Promise<PlanCalendarRpcResult>;
  sendAgain(): Promise<PlanCalendarRpcResult>;
  libraryChanged(): void;
  refresh(): void;
  later(run: () => void): () => void;
  publish(state: ApproveSheetState): void;
}

const NO_TIMER = (): void => undefined;

export function createApproveController(deps: ApproveControllerDeps): ApproveController {
  let state: ApproveSheetState = APPROVE_SHEET_CLOSED;
  let dismissed: "no" | "first-weeks" = "no";
  let latest: PlanCalendarRead | null = null;
  let cancelTimer: () => void = NO_TIMER;
  let disposed = false;

  const publish = (next: ApproveSheetState): void => {
    if (disposed) return;
    if (next.kind !== "sending") {
      cancelTimer();
      cancelTimer = NO_TIMER;
    }
    const leftSending = state.kind === "sending" && next.kind !== "sending";
    state = next;
    if (leftSending) deps.libraryChanged();
    deps.publish(next);
  };

  const poll = (weeks: readonly number[], scope: ApprovalScope, polls: number): void => {
    publish({ kind: "sending", scope, weeks, polls });
    cancelTimer();
    cancelTimer = deps.later(() => {
      cancelTimer = NO_TIMER;
      if (state.kind === "sending" && state.polls === polls) deps.refresh();
    });
  };

  const nextPoll = (current: Extract<ApproveSheetState, { kind: "sending" }>): void => {
    if (current.polls < SENDING_POLLS) {
      poll(current.weeks, current.scope, current.polls + 1);
      return;
    }
    publish({ kind: "send-failed", scope: current.scope, weeks: current.weeks });
  };

  const observeSending = (
    read: PlanCalendarRead,
    current: Extract<ApproveSheetState, { kind: "sending" }>,
  ): void => {
    const progress = sendingFailures(read, current.weeks);
    if (progress.waiting.length > 0) {
      nextPoll(current);
      return;
    }
    if (progress.failed.length > 0) {
      publish({ kind: "send-failed", scope: current.scope, weeks: current.weeks });
      return;
    }
    publish(APPROVE_SHEET_CLOSED);
  };

  return {
    pageOpened() {
      dismissed = "no";
    },
    observe(read, refresh) {
      if (refresh === "refreshing") return;
      if (refresh === "failed") {
        if (state.kind === "sending") nextPoll(state);
        return;
      }
      latest = read;
      switch (state.kind) {
        case "closed":
          if (dismissed === "no" && firstApproval(read) !== null) {
            publish({ kind: "open", scope: { kind: "first-weeks" } });
          }
          return;
        case "open":
        case "refused":
          if (approvalFor(read, state.scope) === null) publish(APPROVE_SHEET_CLOSED);
          return;
        case "approving":
          return;
        case "sending":
          observeSending(read, state);
          return;
        case "send-failed": {
          const progress = sendingFailures(read, state.weeks);
          if (progress.waiting.length === 0 && progress.failed.length === 0) {
            publish(APPROVE_SHEET_CLOSED);
          }
          return;
        }
      }
    },
    open(scope) {
      publish({ kind: "open", scope });
    },
    async approve() {
      const plan = latest?.plan;
      if (state.kind !== "open" || plan === null || plan === undefined) return;
      const scope = state.scope;
      const planId = plan.planId;
      publish({ kind: "approving", scope });
      let result: PlanCalendarRpcResult;
      try {
        result = await deps.approve({ planId, scope });
      } catch {
        publish({ kind: "open", scope });
        return;
      }
      if (result.status !== "approved") {
        publish({ kind: "refused", scope });
        deps.refresh();
        return;
      }
      poll(result.weeks, scope, 0);
      deps.libraryChanged();
      deps.refresh();
    },
    notNow() {
      if (state.kind === "approving") return;
      if (state.kind !== "closed" && state.scope.kind === "first-weeks") dismissed = "first-weeks";
      publish(APPROVE_SHEET_CLOSED);
    },
    async retry() {
      if (state.kind !== "send-failed") return;
      const { weeks, scope } = state;
      poll(weeks, scope, 0);
      try {
        await deps.sendAgain();
      } catch {
        publish({ kind: "send-failed", scope, weeks });
        return;
      }
      deps.refresh();
    },
    dispose() {
      disposed = true;
      cancelTimer();
      cancelTimer = NO_TIMER;
    },
  };
}
