import type { PlanCalendarRpcResult } from "@enduragent/coach-contract";
import { approvalFor, firstApproval, sendingFailures, type ApprovalScope } from "./approval";
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
  observe(read: PlanCalendarRead): void;
  open(scope: ApprovalScope): void;
  approve(): Promise<void>;
  notNow(): void;
  retry(): void;
}

export interface ApproveControllerDeps {
  approve(input: {
    readonly planId: string;
    readonly scope: ApprovalScope;
  }): Promise<PlanCalendarRpcResult>;
  refresh(): void;
  later(run: () => void): void;
  publish(state: ApproveSheetState): void;
}

export function createApproveController(deps: ApproveControllerDeps): ApproveController {
  let state: ApproveSheetState = APPROVE_SHEET_CLOSED;
  let dismissed: "no" | "first-weeks" = "no";
  let latest: PlanCalendarRead | null = null;

  const publish = (next: ApproveSheetState): void => {
    state = next;
    deps.publish(next);
  };

  const poll = (weeks: readonly number[], scope: ApprovalScope, polls: number): void => {
    publish({ kind: "sending", scope, weeks, polls });
    deps.later(() => {
      if (state.kind === "sending" && state.polls === polls) deps.refresh();
    });
  };

  return {
    pageOpened() {
      dismissed = "no";
    },
    observe(read) {
      latest = read;
      if (state.kind === "closed") {
        if (dismissed === "no" && firstApproval(read) !== null) {
          publish({ kind: "open", scope: { kind: "first-weeks" } });
        }
        return;
      }
      if (state.kind === "open" && approvalFor(read, state.scope) === null) {
        publish(APPROVE_SHEET_CLOSED);
        return;
      }
      if (state.kind !== "sending") return;
      const progress = sendingFailures(read, state.weeks);
      if (progress.waiting > 0 && state.polls < SENDING_POLLS) {
        poll(state.weeks, state.scope, state.polls + 1);
        return;
      }
      if (progress.failed.length > 0) {
        publish({ kind: "send-failed", scope: state.scope, weeks: state.weeks });
        return;
      }
      publish(APPROVE_SHEET_CLOSED);
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
      deps.refresh();
    },
    notNow() {
      if (state.kind !== "closed" && state.scope.kind === "first-weeks") dismissed = "first-weeks";
      publish(APPROVE_SHEET_CLOSED);
    },
    retry() {
      if (state.kind !== "send-failed") return;
      poll(state.weeks, state.scope, 0);
      deps.refresh();
    },
  };
}
