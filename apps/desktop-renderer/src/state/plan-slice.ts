import type {
  CoachDecisionAnswer,
  ListPlansResult,
  PlanCreationCardModel,
  PlanCloseResult,
  PlanCloseRpcParams,
  PlanHistoryResult,
  PlanError,
  PlanHydrationState,
  PlanNavigationTarget,
  PlanProgressEvent,
  PlanReadModel,
  PlanTransitionId,
  PlanningReadModel,
} from "@enduragent/coach-contract";
import type { StateCreator } from "zustand";
import type { EnduragentState } from "./store";
import {
  EMPTY_CHAT_SURFACE,
  PLAN_CHANGES_PAUSED_NOTICE,
  PLAN_CHANGES_RESUMED_NOTICE,
  type ChatSurfaceState,
} from "./chat-slice";

export type PlanTransitionState =
  | { readonly status: "idle" }
  | {
      readonly status: "submitting";
      readonly commandId: string;
      readonly transitionId: PlanTransitionId;
    }
  | {
      readonly status: "running";
      readonly commandId: string;
      readonly transitionId: PlanTransitionId;
      readonly operationId: string;
      readonly progress: PlanProgressEvent | null;
    }
  | {
      readonly status: "failed";
      readonly commandId: string | null;
      readonly transitionId: PlanTransitionId | null;
      readonly error: PlanError;
    };

export interface PlanSurfaceState {
  readonly hydration: PlanHydrationState;
  readonly lastReady: PlanReadModel | null;
  readonly transition: PlanTransitionState;
  readonly coach: ChatSurfaceState;
  readonly discardConfirmation: boolean;
  readonly revisionComposer: boolean;
  readonly coursePicker: boolean;
  readonly datePicker: boolean;
  readonly settingPending: {
    readonly setting: "auto-apply" | "weekly-review";
    readonly value: boolean;
  } | null;
}

export type PlanReadSurfaceState =
  | { readonly status: "loading"; readonly value: null }
  | { readonly status: "ready"; readonly value: PlanningReadModel }
  | { readonly status: "unavailable"; readonly value: PlanningReadModel | null };

export type PlanLibraryState =
  | { readonly status: "loading"; readonly value: null }
  | { readonly status: "ready"; readonly value: ListPlansResult }
  | { readonly status: "unavailable"; readonly value: ListPlansResult | null };

export interface PlanLibraryActions {
  closePlan(input: PlanCloseRpcParams): Promise<PlanCloseResult>;
  readPlanHistory(planId: string): Promise<PlanHistoryResult>;
  refresh(): Promise<void>;
  startCreation(): void;
  continueCreation(creation: PlanCreationCardModel): void;
  changeInChat(): void;
}

export interface PlanningReadActions {
  refresh(): void;
  openFromChat(target: PlanNavigationTarget): void;
  backToChat(): void;
  returnToChatRequest(requestId: string): void;
}

export interface PlanActions {
  open(): void;
  startPlan(): void;
  closeCoach(): void;
  submitCoach(message: string): Promise<boolean>;
  stopCoach(): void;
  removeQueuedCoachMessage(id: string): void;
  retryQueuedCoachTurn(claimId: string): void;
  answerCoachDecision(decisionId: string, answer: CoachDecisionAnswer): void;
  skipCoachDecision(decisionId: string): void;
  saveFtp(watts: number): void;
  refreshFtp(): void;
  backToCoachInterview(): void;
  createDraft(): void;
  updateDraft(message: string): void;
  openDiscardConfirmation(): void;
  closeDiscardConfirmation(): void;
  discardDraft(): void;
  openRevisionComposer(): void;
  closeRevisionComposer(): void;
  openCoursePicker(): void;
  closeCoursePicker(): void;
  chooseCourseFile(): void;
  continueWithoutCourse(): void;
  useCourseWithoutElevation(): void;
  removeCourse(): void;
  openDatePicker(): void;
  closeDatePicker(): void;
  recalculateStartDate(startDate: string): void;
  approveDraft(): void;
  openReplacement(): void;
  closeReplacementConfirmation(): void;
  confirmReplacement(): void;
  retryReplacementCleanup(): void;
  verifyReplacementCleanup(): void;
  writeReplacementMirror(): void;
  openReplacementActivePlan(): void;
  reconcilePlan(): void;
  verifyReconciliation(): void;
  openSeason(): void;
  closeSeason(): void;
  openRaceWeek(): void;
  closeRaceWeek(): void;
  openReadiness(): void;
  closeReadiness(): void;
  refreshReadiness(): void;
  openWorkout(workoutId: string): void;
  closeWorkout(): void;
  resolveWorkoutMatch(workoutId: string, activityId: string, decision: "confirm" | "reject"): void;
  resolveWorkoutDrift(workoutId: string, eventId: string, decision: "adopt" | "restore"): void;
  openProposal(proposalId: string): void;
  closeProposal(): void;
  reviseProposal(proposalId: string, text: string): void;
  approveProposal(proposalId: string, expectedRevision: number): void;
  rejectProposal(proposalId: string): void;
  resolvePlanningRequestDate(
    requestId: string,
    resolution:
      | { readonly kind: "use-date"; readonly date: string }
      | { readonly kind: "replace-workout"; readonly workoutId: string },
  ): void;
  openHistory(): void;
  closeHistory(): void;
  undoPlanChange(ledgerId: string): void;
  openPlanSettings(): void;
  closePlanSettings(): void;
  setPlanSetting(setting: "auto-apply" | "weekly-review", value: boolean): void;
  openEndConfirmation(): void;
  closeEndConfirmation(): void;
  confirmEndPlan(): void;
  retryPlanCleanup(): void;
  verifyPlanCleanup(): void;
  openRaceOutcome(): void;
  recordRaceOutcome(outcome: "completed" | "not-completed"): void;
  openEndedConversation(): void;
  closeEndedConversation(): void;
  openAttention(attentionId: string): void;
  returnToCoach(): void;
  retry(): void;
}

export interface PlanSlice {
  readonly plan: PlanSurfaceState;
  readonly planSurface: PlanReadSurfaceState;
  readonly planLibrary: PlanLibraryState;
  readonly planCloseAttempt: {
    readonly command: PlanCloseRpcParams;
    readonly busy: boolean;
  } | null;
  setPlanCloseAttempt: (attempt: PlanSlice["planCloseAttempt"]) => void;
  readonly planLibraryActions: PlanLibraryActions | null;
  setPlanLibrary: (value: PlanLibraryState) => void;
  bindPlanLibraryActions: (actions: PlanLibraryActions | null) => void;
  readonly planFocus: PlanNavigationTarget | null;
  readonly planReturnToChat: boolean;
  readonly planActions: PlanActions | null;
  readonly planningReadActions: PlanningReadActions | null;
  setPlanSurface: (value: PlanReadSurfaceState) => void;
  setPlanFocus: (value: PlanNavigationTarget | null, returnToChat: boolean) => void;
  setPlanHydration: (next: PlanHydrationState) => void;
  setPlanTransition: (next: PlanTransitionState) => void;
  setPlanCoach: (next: ChatSurfaceState) => void;
  setPlanDiscardConfirmation: (open: boolean) => void;
  setPlanRevisionComposer: (open: boolean) => void;
  setPlanCoursePicker: (open: boolean) => void;
  setPlanDatePicker: (open: boolean) => void;
  setPlanSettingPending: (next: PlanSurfaceState["settingPending"]) => void;
  bindPlanActions: (actions: PlanActions | null) => void;
  bindPlanningReadActions: (actions: PlanningReadActions | null) => void;
}

export const EMPTY_PLAN_SURFACE: PlanSurfaceState = Object.freeze({
  hydration: Object.freeze({ status: "loading" }),
  lastReady: null,
  transition: Object.freeze({ status: "idle" }),
  coach: EMPTY_CHAT_SURFACE,
  discardConfirmation: false,
  revisionComposer: false,
  coursePicker: false,
  datePicker: false,
  settingPending: null,
});

export function planReadModel(plan: PlanSurfaceState): PlanReadModel | null {
  if (plan.hydration.status === "ready" || plan.hydration.status === "stale") {
    return plan.hydration.state;
  }
  return plan.lastReady;
}

export function planAttentionCount(plan: PlanSurfaceState): number {
  return planReadModel(plan)?.attention.count ?? 0;
}

export const createPlanSlice: StateCreator<EnduragentState, [], [], PlanSlice> = (set) => ({
  plan: EMPTY_PLAN_SURFACE,
  planLibrary: { status: "loading", value: null },
  planLibraryActions: null,
  planCloseAttempt: null,
  setPlanCloseAttempt(attempt) {
    set({ planCloseAttempt: attempt });
  },
  setPlanLibrary(value) {
    set((state) => {
      if (value.status !== "ready") return { planLibrary: value };
      const activePlanId = value.value.active?.planId;
      const surfaceOpen =
        activePlanId !== undefined &&
        ((state.planChange.open && state.planChange.planId === activePlanId) ||
          value.value.changes.some((change) => change.status === "pending"));
      if (!surfaceOpen) return { planLibrary: value };
      if (value.value.changesPaused !== null) {
        return {
          planLibrary: value,
          planChange: {
            ...state.planChange,
            editorOpen: false,
            error: null,
            notice: PLAN_CHANGES_PAUSED_NOTICE,
          },
        };
      }
      const wasPaused =
        state.planChange.notice === PLAN_CHANGES_PAUSED_NOTICE ||
        (state.planLibrary.status === "ready" && state.planLibrary.value.changesPaused !== null);
      return {
        planLibrary: value,
        ...(wasPaused
          ? { planChange: { ...state.planChange, notice: PLAN_CHANGES_RESUMED_NOTICE } }
          : {}),
      };
    });
  },
  bindPlanLibraryActions(actions) {
    set({ planLibraryActions: actions });
  },
  planSurface: { status: "loading", value: null },
  planFocus: null,
  planReturnToChat: false,
  planActions: null,
  planningReadActions: null,
  setPlanSurface(value) {
    set({ planSurface: value });
  },
  setPlanFocus(value, returnToChat) {
    set({ planFocus: value, planReturnToChat: returnToChat });
  },
  setPlanHydration(next) {
    set((current) => {
      const lastReady =
        next.status === "ready" || next.status === "stale" ? next.state : current.plan.lastReady;
      const hydration =
        next.status === "failed" && lastReady !== null
          ? ({ status: "stale", state: lastReady, error: next.error } as const)
          : next;
      return { plan: { ...current.plan, hydration, lastReady } };
    });
  },
  setPlanTransition(next) {
    set((current) => ({ plan: { ...current.plan, transition: next } }));
  },
  setPlanCoach(next) {
    set((current) => ({ plan: { ...current.plan, coach: next } }));
  },
  setPlanDiscardConfirmation(open) {
    set((current) => ({ plan: { ...current.plan, discardConfirmation: open } }));
  },
  setPlanRevisionComposer(open) {
    set((current) => ({ plan: { ...current.plan, revisionComposer: open } }));
  },
  setPlanCoursePicker(open) {
    set((current) => ({ plan: { ...current.plan, coursePicker: open } }));
  },
  setPlanDatePicker(open) {
    set((current) => ({ plan: { ...current.plan, datePicker: open } }));
  },
  setPlanSettingPending(next) {
    set((current) => ({ plan: { ...current.plan, settingPending: next } }));
  },
  bindPlanActions(actions) {
    set({ planActions: actions });
  },
  bindPlanningReadActions(actions) {
    set({ planningReadActions: actions });
  },
});
