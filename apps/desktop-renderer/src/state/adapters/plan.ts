import {
  PlanActiveProjectionDataSchema,
  PlanCoachProjectionDataSchema,
  type CoachDecisionAnswer,
  type CoachDecisionReadModel,
  type ExecutePlanTransitionRpcParams,
  type ExecutePlanTransitionRpcResult,
  type GetPlanStateRpcResult,
  type PlanError,
  type PlanCloseRpcParams,
  type PlanCloseResult,
  type PlanHistoryResult,
  type PlanChangePreviewRpcParams,
  type PlanChangeApplyRpcParams,
  type ListPlansResult,
  type PlanHydrationState,
  type PlanProgressEvent,
  type PlanReadModel,
  type PlanTransitionId,
} from "@enduragent/coach-contract";
import type { DesktopCoachClientProvider } from "../../coach-client";
import {
  EMPTY_CHAT_STATE,
  nextDrainGroup,
  reduceChatState,
  type ChatState,
} from "../../turn-state";
import type { ChatSurfaceState } from "../chat-slice";
import type { PlanSurfaceState, PlanTransitionState } from "../plan-slice";
import { planReadModel } from "../plan-slice";
import { createChatViewAdapter } from "./chat";

export async function listPlans(clients: DesktopCoachClientProvider): Promise<ListPlansResult> {
  return (await clients.getClient()).call("plan.list", {});
}

export async function readPlanHistory(
  clients: DesktopCoachClientProvider,
  planId: string,
): Promise<PlanHistoryResult> {
  return (await clients.getClient()).call("plan.history", { planId });
}

export async function closePlan(
  clients: DesktopCoachClientProvider,
  input: PlanCloseRpcParams,
): Promise<PlanCloseResult> {
  return (await clients.getClient()).call("plan.close", {
    ...input,
  });
}

export async function previewPlanChange(
  clients: DesktopCoachClientProvider,
  input: PlanChangePreviewRpcParams,
) {
  return (await clients.getClient()).call("plan_change.preview", {
    ...input,
  });
}

export async function applyPlanChange(
  clients: DesktopCoachClientProvider,
  input: PlanChangeApplyRpcParams,
) {
  return (await clients.getClient()).call("plan_change.apply", {
    ...input,
  });
}

export interface PlanBridge {
  getPlanState(): Promise<GetPlanStateRpcResult>;
  choosePlanRaceCourseFile(): Promise<string | null>;
  executePlanTransition(
    input: ExecutePlanTransitionRpcParams,
  ): Promise<ExecutePlanTransitionRpcResult>;
  onPlanProgress(listener: (progress: PlanProgressEvent) => void): () => void;
}

export interface PlanViewAdapter {
  start(): void;
  open(): void;
  openChatRequest(sourceConversationId: string, requestId: string): void;
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
  reload(): void;
  retry(): void;
  dispose(): void;
}

const UNAVAILABLE_ERROR: PlanError = Object.freeze({
  code: "unavailable",
  message: "Plan could not connect. Try again.",
  retryable: true,
});

function hydrationFromResult(result: GetPlanStateRpcResult): PlanHydrationState {
  return result;
}

function hydrationFromTransition(result: ExecutePlanTransitionRpcResult): PlanHydrationState {
  if (result.status === "unsupported-capability") return result;
  return { status: "ready", state: result.state };
}

function hydratedCoachState(model: PlanReadModel): ChatState | null {
  const parsed = PlanCoachProjectionDataSchema.safeParse(model.data);
  if (!parsed.success) return null;
  return reduceChatState(
    {
      ...EMPTY_CHAT_STATE,
      messages: parsed.data.messages.map((message) => ({
        id: message.id,
        ...(message.turnId === null ? {} : { turnId: message.turnId }),
        role: message.role,
        text: message.text,
        delivery: "complete",
      })),
      session: {
        ...EMPTY_CHAT_STATE.session,
        presence: parsed.data.messages.length > 1 ? "present" : "absent",
      },
    },
    { type: "queue-snapshot", snapshot: parsed.data.queue },
  );
}

export function createPlanViewAdapter(input: {
  readonly bridge: PlanBridge;
  readonly clients?: DesktopCoachClientProvider;
  readonly read: () => PlanSurfaceState;
  readonly publishHydration: (next: PlanHydrationState) => void;
  readonly publishTransition: (next: PlanTransitionState) => void;
  readonly publishCoach: (next: ChatSurfaceState) => void;
  readonly publishDiscardConfirmation: (open: boolean) => void;
  readonly publishRevisionComposer: (open: boolean) => void;
  readonly publishCoursePicker: (open: boolean) => void;
  readonly publishDatePicker: (open: boolean) => void;
  readonly publishSettingPending: (next: PlanSurfaceState["settingPending"]) => void;
  readonly createCommandId?: () => string;
  readonly createMessageId?: () => string;
}): PlanViewAdapter {
  const createCommandId = input.createCommandId ?? (() => globalThis.crypto.randomUUID());
  const createMessageId = input.createMessageId ?? (() => globalThis.crypto.randomUUID());
  let disposed = false;
  let started = false;
  let disposeProgress: (() => void) | null = null;
  let hydrationGeneration = 0;
  let lastCommand: ExecutePlanTransitionRpcParams | null = null;
  let coachState = EMPTY_CHAT_STATE;
  let coachRequestKey = 0;
  let coachDecision: CoachDecisionReadModel | null = null;
  let coachDecisionPhase: ChatSurfaceState["decisionPhase"] = "idle";
  let coachDecisionAnswerLabel: string | null = null;
  let coachDecisionError: string | null = null;
  let recoveringDecisionId: string | null = null;
  let autoResumingPlanId: string | null = null;
  let autoResumingCleanupPlanId: string | null = null;
  let autoResumingReplacementId: string | null = null;
  let attemptedWeeklyReviewSyncAtMs: number | null = null;
  let active: {
    readonly commandId: string;
    readonly transitionId: PlanTransitionId;
    operationId: string | null;
    accepted: boolean;
  } | null = null;

  const coachView = createChatViewAdapter({
    publish: input.publishCoach,
    bufferStreaming: false,
  }).view;

  const renderCoach = (): void => {
    coachView.render(coachState, {
      newConversationDisabled: true,
      workBlocked: false,
      decision: {
        value: coachDecision,
        phase: coachDecisionPhase,
        answerLabel: coachDecisionAnswerLabel,
        error: coachDecisionError,
      },
    });
  };

  const reduceCoach = (action: Parameters<typeof reduceChatState>[1]): void => {
    coachState = reduceChatState(coachState, action);
    renderCoach();
  };

  const decisionLabel = (decision: CoachDecisionReadModel): string | null => {
    if (decision.status !== "answered") return null;
    if (decision.answer.kind === "custom") return decision.answer.text;
    const optionId = decision.answer.optionId;
    return decision.options.find((option) => option.id === optionId)?.label ?? "Saved choice";
  };

  const syncCoach = (model: PlanReadModel): void => {
    const next = hydratedCoachState(model);
    if (next === null) return;
    const data = PlanCoachProjectionDataSchema.parse(model.data);
    coachState = next;
    coachDecision = data.decision;
    coachDecisionAnswerLabel = data.decision === null ? null : decisionLabel(data.decision);
    coachDecisionError = null;
    if (data.decision?.status === "answered" && data.decision.continuation.status === "pending") {
      coachDecisionPhase = "recovering";
      if (recoveringDecisionId !== data.decision.decisionId) {
        const decisionId = data.decision.decisionId;
        recoveringDecisionId = decisionId;
        queueMicrotask(() => {
          submitCommand(coachDecisionAnswerLabel ?? "Saved choice", {
            action: "resume",
            decisionId,
          });
        });
      }
    } else {
      coachDecisionPhase = "idle";
      recoveringDecisionId = null;
    }
    renderCoach();
  };

  const publishHydration = (next: PlanHydrationState): void => {
    input.publishHydration(next);
    if (next.status === "ready" || next.status === "stale") {
      syncCoach(next.state);
      if (
        (next.state.scenarioId === "PL-S037" || next.state.scenarioId === "PL-S042") &&
        next.state.planId !== null &&
        autoResumingPlanId !== next.state.planId &&
        active === null
      ) {
        const planId = next.state.planId;
        autoResumingPlanId = planId;
        queueMicrotask(() => {
          if (disposed || active !== null) return;
          void execute({
            transitionId: "PL-T12",
            commandId: createCommandId(),
            planId,
            mode: "reconcile",
          });
        });
      }
      if (
        (next.state.scenarioId === "PL-S052" ||
          (next.state.scenarioId === "PL-S094" &&
            next.state.reconciliation.status !== "verified")) &&
        next.state.planId !== null &&
        autoResumingCleanupPlanId !== next.state.planId &&
        active === null
      ) {
        const planId = next.state.planId;
        autoResumingCleanupPlanId = planId;
        queueMicrotask(() => {
          if (disposed || active !== null) return;
          void execute({
            transitionId: "PL-T24",
            commandId: createCommandId(),
            planId,
            mode: "cleanup",
          });
        });
      }
      if (next.state.scenarioId === "PL-S082" && next.state.planId !== null) {
        const parsed = PlanActiveProjectionDataSchema.safeParse(next.state.data);
        const replacement = parsed.success ? parsed.data.replacement : undefined;
        if (replacement !== undefined && autoResumingReplacementId !== replacement.id) {
          autoResumingReplacementId = replacement.id;
          queueMicrotask(() => {
            if (disposed || active !== null) return;
            void execute({
              transitionId: "PL-T27",
              commandId: createCommandId(),
              planId: replacement.previousPlan.id,
              replacementPlanId: next.state.planId!,
              mode: "cleanup",
            });
          });
        }
      }
      if (next.state.planId !== null && active === null) {
        const parsed = PlanActiveProjectionDataSchema.safeParse(next.state.data);
        const review = parsed.success ? parsed.data.weeklyReview : undefined;
        if (
          review?.status === "due" &&
          attemptedWeeklyReviewSyncAtMs !== review.lastSuccessfulSyncAtMs
        ) {
          attemptedWeeklyReviewSyncAtMs = review.lastSuccessfulSyncAtMs;
          queueMicrotask(() => {
            if (disposed || active !== null) return;
            void execute({
              transitionId: "PL-T35",
              commandId: createCommandId(),
              planId: next.state.planId!,
              weekStart: review.weekStart,
            });
          });
        }
      }
    }
  };

  const refresh = async (showLoading: boolean): Promise<void> => {
    const generation = ++hydrationGeneration;
    if (showLoading && input.read().lastReady === null) {
      input.publishHydration({ status: "loading" });
    }
    try {
      const result = await input.bridge.getPlanState();
      if (disposed || generation !== hydrationGeneration) return;
      publishHydration(hydrationFromResult(result));
    } catch {
      if (disposed || generation !== hydrationGeneration) return;
      input.publishHydration({ status: "failed", error: UNAVAILABLE_ERROR });
    }
  };

  const execute = async (command: ExecutePlanTransitionRpcParams): Promise<void> => {
    if (active !== null) return;
    active = {
      commandId: command.commandId,
      transitionId: command.transitionId,
      operationId: null,
      accepted: false,
    };
    lastCommand = command;
    input.publishTransition({
      status: "submitting",
      commandId: command.commandId,
      transitionId: command.transitionId,
    });
    try {
      const result = await input.bridge.executePlanTransition(command);
      if (
        disposed ||
        active?.commandId !== command.commandId ||
        active.transitionId !== command.transitionId
      ) {
        return;
      }
      publishHydration(hydrationFromTransition(result));
      if (result.status === "unsupported-capability") {
        active = null;
        if (command.transitionId === "PL-T22") input.publishSettingPending(null);
        input.publishTransition({ status: "idle" });
        return;
      }
      if (result.status === "rejected") {
        if (command.transitionId === "PL-T05") {
          coachDecisionError = result.error.message;
          reduceCoach({ type: "fail", requestKey: coachRequestKey, copy: result.error.message });
        }
        active = null;
        if (command.transitionId === "PL-T22") input.publishSettingPending(null);
        input.publishTransition({
          status: "failed",
          commandId: command.commandId,
          transitionId: command.transitionId,
          error: result.error,
        });
        return;
      }
      if (result.status === "accepted") {
        active.operationId = result.operationId;
        active.accepted = true;
        input.publishTransition({
          status: "running",
          commandId: command.commandId,
          transitionId: command.transitionId,
          operationId: result.operationId,
          progress: result.state.activeOperation,
        });
        return;
      }
      active = null;
      if (command.transitionId === "PL-T22") input.publishSettingPending(null);
      input.publishTransition({ status: "idle" });
      if (command.transitionId === "PL-T24" && result.state.scenarioId === "PL-S056") {
        queueMicrotask(() => void refresh(false));
      }
      if (
        command.transitionId === "PL-T04" &&
        (result.state.scenarioId === "PL-S060" || result.state.scenarioId === "PL-S062")
      ) {
        lastCommand = null;
        queueMicrotask(() => void refresh(false));
      }
    } catch {
      if (
        disposed ||
        active?.commandId !== command.commandId ||
        active.transitionId !== command.transitionId
      ) {
        return;
      }
      if (command.transitionId === "PL-T05") {
        coachDecisionError = UNAVAILABLE_ERROR.message;
        reduceCoach({ type: "fail", requestKey: coachRequestKey, copy: UNAVAILABLE_ERROR.message });
      }
      active = null;
      if (command.transitionId === "PL-T22") input.publishSettingPending(null);
      input.publishTransition({
        status: "failed",
        commandId: command.commandId,
        transitionId: command.transitionId,
        error: UNAVAILABLE_ERROR,
      });
    }
  };

  const currentCoachData = (): ReturnType<typeof PlanCoachProjectionDataSchema.parse> | null => {
    const model = planReadModel(input.read());
    if (model === null) return null;
    const parsed = PlanCoachProjectionDataSchema.safeParse(model.data);
    return parsed.success ? parsed.data : null;
  };

  const attachCourse = (filePath: string, elevation: "require" | "allow-missing"): void => {
    const data = currentCoachData();
    if (data === null) return;
    if (data.draft === null) {
      void execute({
        transitionId: "PL-T02",
        commandId: createCommandId(),
        conversationId: data.conversationId,
        filePath,
        elevation,
      });
      return;
    }
    void execute({
      transitionId: "PL-T09",
      commandId: createCommandId(),
      draftId: data.draft.id,
      course: { action: "attach", filePath, elevation },
    });
  };

  const beginCoachSubmission = (message: string, includeUser: boolean): void => {
    coachRequestKey += 1;
    reduceCoach({
      type: "submit",
      requestKey: coachRequestKey,
      userMessage: message,
      userMessageId: createMessageId(),
      assistantMessageId: createMessageId(),
      includeUser,
    });
  };

  const submitCommand = (
    message: string,
    decision?: Extract<ExecutePlanTransitionRpcParams, { transitionId: "PL-T05" }>["decision"],
  ): boolean => {
    const data = currentCoachData();
    if (data === null || active !== null || !/\S/u.test(message)) return false;
    beginCoachSubmission(message, decision === undefined);
    void execute({
      transitionId: "PL-T05",
      commandId: createCommandId(),
      conversationId: data.conversationId,
      text: message.trim(),
      ...(decision === undefined ? {} : { decision }),
    });
    return true;
  };

  const onCoachTurnEvent = (event: NonNullable<PlanProgressEvent["turnEvent"]>): void => {
    if (event.type === "turn-start") {
      const current = coachState.activeTurn;
      if (current?.finalText !== null && current?.finalText !== undefined) {
        reduceCoach({ type: "complete", requestKey: current.requestKey });
        const group = nextDrainGroup(coachState);
        if (group !== null) {
          reduceCoach({ type: "dequeue-group" });
          beginCoachSubmission(group.text, true);
        }
      }
      reduceCoach({ type: "bind-turn", requestKey: coachRequestKey, turnId: event.turnId });
    }
    if (event.type === "decision-requested") {
      coachDecision = event.decision;
      reduceCoach({
        type: "bind-decision",
        requestKey: coachRequestKey,
        decisionId: event.decision.decisionId,
      });
    }
    reduceCoach({ type: "event", requestKey: coachRequestKey, event });
  };

  const onProgress = (progress: PlanProgressEvent): void => {
    if (
      disposed ||
      active === null ||
      progress.commandId !== active.commandId ||
      progress.transitionId !== active.transitionId
    ) {
      return;
    }
    if (active.operationId === null) active.operationId = progress.operationId;
    if (progress.operationId !== active.operationId) return;
    if (progress.turnEvent !== undefined) onCoachTurnEvent(progress.turnEvent);
    input.publishTransition({
      status: "running",
      commandId: active.commandId,
      transitionId: active.transitionId,
      operationId: active.operationId,
      progress,
    });
    if ((progress.phase === "completed" || progress.phase === "failed") && active.accepted) {
      active = null;
      input.publishTransition({ status: "idle" });
      void refresh(false);
    }
  };

  const startPlan = (): void => {
    if (active !== null) return;
    void execute({
      transitionId: "PL-T01",
      commandId: createCommandId(),
      sourceConversationId: null,
    });
  };

  const open = (): void => {
    if (active !== null) return;
    const model = planReadModel(input.read());
    if (model === null || model.attention.destination === "none" || model.planId === null) {
      void refresh(false);
      return;
    }
    void execute({
      transitionId: "PL-T33",
      commandId: createCommandId(),
      planId: model.planId,
    });
  };

  return {
    start() {
      if (started || disposed) return;
      started = true;
      disposeProgress = input.bridge.onPlanProgress(onProgress);
      void refresh(true);
    },
    open,
    openChatRequest(sourceConversationId, requestId) {
      if (active !== null) return;
      void execute({
        transitionId: "PL-T36",
        commandId: createCommandId(),
        sourceConversationId,
        requestId,
      });
    },
    startPlan,
    closeCoach() {
      const model = planReadModel(input.read());
      if (
        active !== null ||
        model === null ||
        (model.scenarioId !== "PL-S017" && model.scenarioId !== "PL-S079")
      ) {
        return;
      }
      void execute({
        transitionId: "PL-T39",
        commandId: createCommandId(),
        action: "close",
        sourceScenarioId: model.scenarioId,
        destinationScenarioId: model.scenarioId === "PL-S079" ? "PL-S004" : "PL-S001",
        returnFocusId:
          model.scenarioId === "PL-S079" ? "plan-replacement-trigger" : "plan-start-coach",
      });
    },
    async submitCoach(message) {
      if (coachState.status === "streaming") {
        const data = currentCoachData();
        if (data === null || input.clients === undefined || !/\S/u.test(message)) return false;
        try {
          const client = await input.clients.getClient();
          const snapshot = await client.call("enqueueChatMessage", {
            chatId: data.chatId,
            submissionId: createMessageId(),
            text: message.trim(),
          });
          reduceCoach({ type: "queue-snapshot", snapshot });
          return true;
        } catch {
          return false;
        }
      }
      return submitCommand(message);
    },
    stopCoach() {
      const data = currentCoachData();
      const turnId = coachState.activeTurn?.turnId;
      if (data === null || turnId === null || turnId === undefined || input.clients === undefined) {
        return;
      }
      void input.clients
        .getClient()
        .then((client) => client.call("stopChat", { chatId: data.chatId, turnId }))
        .catch(() => undefined);
    },
    removeQueuedCoachMessage(id) {
      const data = currentCoachData();
      if (data === null || input.clients === undefined) return;
      void input.clients
        .getClient()
        .then((client) =>
          client.call("removeQueuedChatMessage", { chatId: data.chatId, queuedMessageId: id }),
        )
        .then((snapshot) => reduceCoach({ type: "queue-snapshot", snapshot }))
        .catch(() => undefined);
    },
    retryQueuedCoachTurn(claimId) {
      const retry = coachState.retryRequired;
      if (retry?.claimId !== claimId) return;
      const text = coachState.queued
        .filter((item) => retry.queuedMessageIds.includes(item.id))
        .map((item) => item.text)
        .join("\n\n");
      submitCommand(text);
    },
    answerCoachDecision(decisionId, answer) {
      const decision = coachDecision;
      if (decision?.decisionId !== decisionId) return;
      const label =
        answer.kind === "custom"
          ? answer.text
          : (decision.options.find((option) => option.id === answer.optionId)?.label ??
            "Saved choice");
      coachDecisionPhase = "continuing";
      coachDecisionAnswerLabel = label;
      coachDecisionError = null;
      submitCommand(label, { action: "answer", decisionId, answer });
    },
    skipCoachDecision(decisionId) {
      if (coachDecision?.decisionId !== decisionId) return;
      coachDecisionPhase = "continuing";
      coachDecisionAnswerLabel = "Question skipped";
      coachDecisionError = null;
      submitCommand("Question skipped", { action: "skip", decisionId });
    },
    saveFtp(watts) {
      const data = currentCoachData();
      if (data === null) return;
      void execute({
        transitionId: "PL-T04",
        commandId: createCommandId(),
        conversationId: data.conversationId,
        source: "manual",
        watts,
      });
    },
    refreshFtp() {
      const data = currentCoachData();
      if (data === null) return;
      void execute({
        transitionId: "PL-T04",
        commandId: createCommandId(),
        conversationId: data.conversationId,
        source: "intervals",
        watts: null,
      });
    },
    backToCoachInterview() {
      const model = planReadModel(input.read());
      const data = currentCoachData();
      if (model === null || data === null || active !== null) return;
      const destinationScenarioId = data.replacement ? "PL-S079" : "PL-S017";
      const sourceScenarioId = data.replacement ? "PL-S103" : "PL-S016";
      if (model.scenarioId !== sourceScenarioId || !data.readyToCreateDraft) return;
      void execute({
        transitionId: "PL-T39",
        commandId: createCommandId(),
        action: "back",
        sourceScenarioId,
        destinationScenarioId,
        returnFocusId: "plan-coach-composer",
      });
    },
    createDraft() {
      const data = currentCoachData();
      if (data === null || !data.readyToCreateDraft) return;
      void execute({
        transitionId: "PL-T06",
        commandId: createCommandId(),
        conversationId: data.conversationId,
      });
    },
    updateDraft(message) {
      const data = currentCoachData();
      if (data === null || data.draft === null || !/\S/u.test(message)) return;
      input.publishRevisionComposer(false);
      void execute({
        transitionId: "PL-T07",
        commandId: createCommandId(),
        draftId: data.draft.id,
        text: message.trim(),
      });
    },
    openDiscardConfirmation() {
      input.publishDiscardConfirmation(true);
    },
    closeDiscardConfirmation() {
      input.publishDiscardConfirmation(false);
    },
    discardDraft() {
      const data = currentCoachData();
      if (data === null || data.draft === null) return;
      input.publishDiscardConfirmation(false);
      void execute({
        transitionId: "PL-T10",
        commandId: createCommandId(),
        draftId: data.draft.id,
      });
    },
    openRevisionComposer() {
      input.publishRevisionComposer(true);
    },
    closeRevisionComposer() {
      input.publishRevisionComposer(false);
    },
    openCoursePicker() {
      input.publishCoursePicker(true);
    },
    closeCoursePicker() {
      input.publishCoursePicker(false);
    },
    chooseCourseFile() {
      if (active !== null) return;
      void input.bridge
        .choosePlanRaceCourseFile()
        .then((filePath) => {
          if (disposed || filePath === null) return;
          input.publishCoursePicker(false);
          attachCourse(filePath, "require");
        })
        .catch(() => undefined);
    },
    continueWithoutCourse() {
      const data = currentCoachData();
      if (data === null || active !== null) return;
      input.publishCoursePicker(false);
      if (data.draft === null) {
        void execute({
          transitionId: "PL-T03",
          commandId: createCommandId(),
          conversationId: data.conversationId,
        });
        return;
      }
      void execute({
        transitionId: "PL-T09",
        commandId: createCommandId(),
        draftId: data.draft.id,
        course: { action: "remove" },
      });
    },
    useCourseWithoutElevation() {
      if (active !== null || lastCommand === null) return;
      if (lastCommand.transitionId === "PL-T02") {
        attachCourse(lastCommand.filePath, "allow-missing");
      } else if (lastCommand.transitionId === "PL-T09" && lastCommand.course.action === "attach") {
        attachCourse(lastCommand.course.filePath, "allow-missing");
      }
    },
    removeCourse() {
      const data = currentCoachData();
      if (data?.draft === null || data?.draft === undefined || active !== null) return;
      void execute({
        transitionId: "PL-T09",
        commandId: createCommandId(),
        draftId: data.draft.id,
        course: { action: "remove" },
      });
    },
    openDatePicker() {
      input.publishDatePicker(true);
    },
    closeDatePicker() {
      input.publishDatePicker(false);
    },
    recalculateStartDate(startDate) {
      const data = currentCoachData();
      if (data?.draft === null || data?.draft === undefined || active !== null) return;
      input.publishDatePicker(false);
      void execute({
        transitionId: "PL-T08",
        commandId: createCommandId(),
        draftId: data.draft.id,
        startDate,
      });
    },
    approveDraft() {
      const data = currentCoachData();
      if (data?.draft === null || data?.draft === undefined || active !== null) return;
      if (data.replacement && data.replacesPlanId !== null) {
        void execute({
          transitionId: "PL-T26",
          commandId: createCommandId(),
          activePlanId: data.replacesPlanId,
          draftId: data.draft.id,
          expectedRevision: data.draft.revision,
        });
        return;
      }
      void execute({
        transitionId: "PL-T11",
        commandId: createCommandId(),
        draftId: data.draft.id,
        expectedRevision: data.draft.revision,
      });
    },
    openReplacement() {
      const model = planReadModel(input.read());
      if (model?.planId === null || model?.planId === undefined || active !== null) return;
      void execute({
        transitionId: "PL-T25",
        commandId: createCommandId(),
        planId: model.planId,
      });
    },
    closeReplacementConfirmation() {
      const data = currentCoachData();
      if (data?.draft === null || data?.draft === undefined || active !== null) return;
      void execute({
        transitionId: "PL-T39",
        commandId: createCommandId(),
        action: "back",
        sourceScenarioId: "PL-S081",
        destinationScenarioId: "PL-S080",
        returnFocusId: "plan-approve-replacement",
      });
    },
    confirmReplacement() {
      const data = currentCoachData();
      if (
        data?.draft === null ||
        data?.draft === undefined ||
        data.replacesPlanId === null ||
        active !== null
      ) {
        return;
      }
      void execute({
        transitionId: "PL-T26",
        commandId: createCommandId(),
        activePlanId: data.replacesPlanId,
        draftId: data.draft.id,
        expectedRevision: data.draft.revision,
        confirm: true,
      });
    },
    retryReplacementCleanup() {
      const model = planReadModel(input.read());
      if (model?.planId === null || model?.planId === undefined || active !== null) return;
      const parsed = PlanActiveProjectionDataSchema.safeParse(model.data);
      const replacement = parsed.success ? parsed.data.replacement : undefined;
      if (replacement === undefined) return;
      void execute({
        transitionId: "PL-T27",
        commandId: createCommandId(),
        planId: replacement.previousPlan.id,
        replacementPlanId: model.planId,
        mode: "cleanup",
      });
    },
    verifyReplacementCleanup() {
      const model = planReadModel(input.read());
      if (model?.planId === null || model?.planId === undefined || active !== null) return;
      const parsed = PlanActiveProjectionDataSchema.safeParse(model.data);
      const replacement = parsed.success ? parsed.data.replacement : undefined;
      if (replacement === undefined) return;
      void execute({
        transitionId: "PL-T27",
        commandId: createCommandId(),
        planId: replacement.previousPlan.id,
        replacementPlanId: model.planId,
        mode: "verify",
      });
    },
    writeReplacementMirror() {
      const model = planReadModel(input.read());
      if (model?.planId === null || model?.planId === undefined || active !== null) return;
      void execute({
        transitionId: "PL-T28",
        commandId: createCommandId(),
        planId: model.planId,
      });
    },
    openReplacementActivePlan() {
      const model = planReadModel(input.read());
      if (model?.planId === null || model?.planId === undefined || active !== null) return;
      void execute({
        transitionId: "PL-T39",
        commandId: createCommandId(),
        action: "open",
        sourceScenarioId: "PL-S087",
        destinationScenarioId: "PL-S088",
        returnFocusId: model.planId,
      });
    },
    reconcilePlan() {
      const model = planReadModel(input.read());
      if (model?.planId === null || model?.planId === undefined || active !== null) return;
      void execute({
        transitionId: "PL-T12",
        commandId: createCommandId(),
        planId: model.planId,
        mode: "reconcile",
      });
    },
    verifyReconciliation() {
      const model = planReadModel(input.read());
      if (model?.planId === null || model?.planId === undefined || active !== null) return;
      void execute({
        transitionId: "PL-T12",
        commandId: createCommandId(),
        planId: model.planId,
        mode: "verify",
      });
    },
    openSeason() {
      const model = planReadModel(input.read());
      if (model?.planId === null || model?.planId === undefined || active !== null) return;
      void execute({
        transitionId: "PL-T31",
        commandId: createCommandId(),
        planId: model.planId,
      });
    },
    closeSeason() {
      const model = planReadModel(input.read());
      if (model?.planId === null || model?.planId === undefined || active !== null) return;
      void execute({
        transitionId: "PL-T39",
        commandId: createCommandId(),
        action: "back",
        sourceScenarioId: "PL-S006",
        destinationScenarioId: "PL-S004",
        returnFocusId: "plan-season-trigger",
      });
    },
    openRaceWeek() {
      const model = planReadModel(input.read());
      if (model?.planId === null || model?.planId === undefined || active !== null) return;
      void execute({
        transitionId: "PL-T39",
        commandId: createCommandId(),
        action: "open",
        sourceScenarioId: "PL-S006",
        destinationScenarioId: "PL-S009",
        returnFocusId: "plan-race-week-trigger",
      });
    },
    closeRaceWeek() {
      const model = planReadModel(input.read());
      if (model?.planId === null || model?.planId === undefined || active !== null) return;
      void execute({
        transitionId: "PL-T39",
        commandId: createCommandId(),
        action: "back",
        sourceScenarioId: "PL-S009",
        destinationScenarioId: "PL-S006",
        returnFocusId: "plan-race-week-trigger",
      });
    },
    openReadiness() {
      const model = planReadModel(input.read());
      if (model?.planId === null || model?.planId === undefined || active !== null) return;
      void execute({
        transitionId: "PL-T32",
        commandId: createCommandId(),
        planId: model.planId,
        mode: "open",
      });
    },
    closeReadiness() {
      const model = planReadModel(input.read());
      if (model?.planId === null || model?.planId === undefined || active !== null) return;
      void execute({
        transitionId: "PL-T39",
        commandId: createCommandId(),
        action: "back",
        sourceScenarioId: model.scenarioId,
        destinationScenarioId: "PL-S004",
        returnFocusId: "plan-readiness-trigger",
      });
    },
    refreshReadiness() {
      const model = planReadModel(input.read());
      if (model?.planId === null || model?.planId === undefined || active !== null) return;
      void execute({
        transitionId: "PL-T32",
        commandId: createCommandId(),
        planId: model.planId,
        mode: "refresh",
      });
    },
    openWorkout(workoutId) {
      const model = planReadModel(input.read());
      if (model?.planId === null || model?.planId === undefined || active !== null) return;
      void execute({
        transitionId: "PL-T13",
        commandId: createCommandId(),
        planId: model.planId,
        workoutId,
        sourceScenarioId: model.scenarioId,
      });
    },
    closeWorkout() {
      if (active !== null) return;
      const model = planReadModel(input.read());
      const parsed = model === null ? null : PlanActiveProjectionDataSchema.safeParse(model.data);
      const sourceScenarioId = parsed?.success ? parsed.data.selectedWorkoutSourceScenarioId : null;
      if (
        model?.planId !== null &&
        model?.planId !== undefined &&
        parsed?.success === true &&
        parsed.data.selectedWorkoutId !== null &&
        sourceScenarioId !== null &&
        sourceScenarioId !== undefined
      ) {
        const raceWeek = sourceScenarioId === "PL-S009";
        const attention = sourceScenarioId === "PL-S028";
        const attentionKind = model.scenarioId === "PL-S032" ? "workout-drift" : "workout-match";
        void execute({
          transitionId: "PL-T39",
          commandId: createCommandId(),
          action: "back",
          sourceScenarioId: model.scenarioId === "PL-S032" ? "PL-S032" : "PL-S021",
          destinationScenarioId: sourceScenarioId,
          returnFocusId: raceWeek
            ? `race-week-workout-${parsed.data.selectedWorkoutId}`
            : attention
              ? `plan-attention-${attentionKind}:${parsed.data.selectedWorkoutId}`
              : `workout-row-${parsed.data.selectedWorkoutId}`,
        });
        return;
      }
      void refresh(false);
    },
    resolveWorkoutMatch(workoutId, activityId, decision) {
      const model = planReadModel(input.read());
      if (model?.planId === null || model?.planId === undefined || active !== null) return;
      void execute({
        transitionId: "PL-T14",
        commandId: createCommandId(),
        planId: model.planId,
        workoutId,
        activityId,
        decision,
      });
    },
    resolveWorkoutDrift(workoutId, eventId, decision) {
      const model = planReadModel(input.read());
      if (model?.planId === null || model?.planId === undefined || active !== null) return;
      void execute({
        transitionId: decision === "adopt" ? "PL-T15" : "PL-T16",
        commandId: createCommandId(),
        planId: model.planId,
        workoutId,
        eventId,
      });
    },
    openProposal(proposalId) {
      const model = planReadModel(input.read());
      if (model?.planId === null || model?.planId === undefined || active !== null) return;
      const parsed = PlanActiveProjectionDataSchema.safeParse(model.data);
      const proposal = parsed.success
        ? parsed.data.proposals?.find((candidate) => candidate.id === proposalId)
        : undefined;
      if (proposal === undefined) return;
      void execute({
        transitionId: "PL-T17",
        commandId: createCommandId(),
        planId: model.planId,
        proposalId,
        selectedProposalReturn: {
          sourceScenarioId: model.scenarioId === "PL-S011" ? "PL-S004" : model.scenarioId,
          returnFocusId: `workout-row-${proposal.targetWorkoutId}`,
        },
      });
    },
    closeProposal() {
      if (active !== null) return;
      const model = planReadModel(input.read());
      const parsed = model === null ? null : PlanActiveProjectionDataSchema.safeParse(model.data);
      const proposalReturn = parsed?.success ? parsed.data.selectedProposalReturn : null;
      if (
        model?.planId !== null &&
        model?.planId !== undefined &&
        proposalReturn !== null &&
        proposalReturn !== undefined
      ) {
        void execute({
          transitionId: "PL-T39",
          commandId: createCommandId(),
          action: "back",
          sourceScenarioId: model.scenarioId,
          destinationScenarioId: proposalReturn.sourceScenarioId,
          returnFocusId: proposalReturn.returnFocusId,
          selectedProposalReturn: proposalReturn,
        });
        return;
      }
      void refresh(false);
    },
    reviseProposal(proposalId, text) {
      if (active !== null || !/\S/u.test(text)) return;
      const model = planReadModel(input.read());
      const parsed = model === null ? null : PlanActiveProjectionDataSchema.safeParse(model.data);
      const selectedProposalReturn = parsed?.success
        ? parsed.data.selectedProposalReturn
        : undefined;
      void execute({
        transitionId: "PL-T18",
        commandId: createCommandId(),
        proposalId,
        text,
        ...(selectedProposalReturn === null || selectedProposalReturn === undefined
          ? {}
          : { selectedProposalReturn }),
      });
    },
    approveProposal(proposalId, expectedRevision) {
      if (active !== null) return;
      const model = planReadModel(input.read());
      const parsed = model === null ? null : PlanActiveProjectionDataSchema.safeParse(model.data);
      const selectedProposalReturn = parsed?.success
        ? parsed.data.selectedProposalReturn
        : undefined;
      void execute({
        transitionId: "PL-T19",
        commandId: createCommandId(),
        proposalId,
        expectedRevision,
        ...(selectedProposalReturn === null || selectedProposalReturn === undefined
          ? {}
          : { selectedProposalReturn }),
      });
    },
    rejectProposal(proposalId) {
      if (active !== null) return;
      const model = planReadModel(input.read());
      const parsed = model === null ? null : PlanActiveProjectionDataSchema.safeParse(model.data);
      const selectedProposalReturn = parsed?.success
        ? parsed.data.selectedProposalReturn
        : undefined;
      void execute({
        transitionId: "PL-T20",
        commandId: createCommandId(),
        proposalId,
        ...(selectedProposalReturn === null || selectedProposalReturn === undefined
          ? {}
          : { selectedProposalReturn }),
      });
    },
    resolvePlanningRequestDate(requestId, resolution) {
      if (active !== null) return;
      void execute({
        transitionId: "PL-T40",
        commandId: createCommandId(),
        requestId,
        resolution,
      });
    },
    openHistory() {
      const model = planReadModel(input.read());
      if (model?.planId === null || model?.planId === undefined || active !== null) return;
      void execute({
        transitionId: "PL-T39",
        commandId: createCommandId(),
        action: "open",
        sourceScenarioId: model.scenarioId,
        destinationScenarioId: "PL-S005",
        returnFocusId: model.planId,
      });
    },
    closeHistory() {
      const model = planReadModel(input.read());
      if (model?.planId === null || model?.planId === undefined || active !== null) return;
      void execute({
        transitionId: "PL-T39",
        commandId: createCommandId(),
        action: "back",
        sourceScenarioId: model.scenarioId,
        destinationScenarioId: "PL-S004",
        returnFocusId: model.planId,
      });
    },
    undoPlanChange(ledgerId) {
      const model = planReadModel(input.read());
      if (model?.planId === null || model?.planId === undefined || active !== null) return;
      void execute({
        transitionId: "PL-T21",
        commandId: createCommandId(),
        planId: model.planId,
        ledgerId,
      });
    },
    openPlanSettings() {
      const model = planReadModel(input.read());
      if (model?.planId === null || model?.planId === undefined || active !== null) return;
      void execute({
        transitionId: "PL-T39",
        commandId: createCommandId(),
        action: "open",
        sourceScenarioId: model.scenarioId,
        destinationScenarioId: "PL-S090",
        returnFocusId: "plan-settings-trigger",
      });
    },
    closePlanSettings() {
      const model = planReadModel(input.read());
      if (model?.planId === null || model?.planId === undefined || active !== null) return;
      void execute({
        transitionId: "PL-T39",
        commandId: createCommandId(),
        action: "back",
        sourceScenarioId: model.scenarioId,
        destinationScenarioId: "PL-S005",
        returnFocusId: "plan-settings-trigger",
      });
    },
    setPlanSetting(setting, value) {
      const model = planReadModel(input.read());
      if (model?.planId === null || model?.planId === undefined || active !== null) return;
      input.publishSettingPending({ setting, value });
      void execute({
        transitionId: "PL-T22",
        commandId: createCommandId(),
        planId: model.planId,
        setting,
        value,
      });
    },
    openEndConfirmation() {
      const model = planReadModel(input.read());
      if (model?.planId === null || model?.planId === undefined || active !== null) return;
      void execute({
        transitionId: "PL-T23",
        commandId: createCommandId(),
        planId: model.planId,
      });
    },
    closeEndConfirmation() {
      const model = planReadModel(input.read());
      if (model?.planId === null || model?.planId === undefined || active !== null) return;
      void execute({
        transitionId: "PL-T39",
        commandId: createCommandId(),
        action: "back",
        sourceScenarioId: "PL-S051",
        destinationScenarioId: "PL-S004",
        returnFocusId: "plan-end-trigger",
      });
    },
    confirmEndPlan() {
      const model = planReadModel(input.read());
      if (model?.planId === null || model?.planId === undefined || active !== null) return;
      void execute({
        transitionId: "PL-T24",
        commandId: createCommandId(),
        planId: model.planId,
        mode: "cleanup",
      });
    },
    retryPlanCleanup() {
      const model = planReadModel(input.read());
      if (model?.planId === null || model?.planId === undefined || active !== null) return;
      void execute({
        transitionId: "PL-T24",
        commandId: createCommandId(),
        planId: model.planId,
        mode: "cleanup",
      });
    },
    verifyPlanCleanup() {
      const model = planReadModel(input.read());
      if (model?.planId === null || model?.planId === undefined || active !== null) return;
      void execute({
        transitionId: "PL-T24",
        commandId: createCommandId(),
        planId: model.planId,
        mode: "verify",
      });
    },
    openRaceOutcome() {
      const model = planReadModel(input.read());
      if (
        model?.planId === null ||
        model?.planId === undefined ||
        model.scenarioId !== "PL-S094" ||
        active !== null
      ) {
        return;
      }
      void execute({
        transitionId: "PL-T39",
        commandId: createCommandId(),
        action: "open",
        sourceScenarioId: "PL-S094",
        destinationScenarioId: "PL-S095",
        returnFocusId: model.planId,
      });
    },
    recordRaceOutcome(outcome) {
      const model = planReadModel(input.read());
      if (model?.planId === null || model?.planId === undefined || active !== null) return;
      void execute({
        transitionId: "PL-T30",
        commandId: createCommandId(),
        planId: model.planId,
        outcome,
      });
    },
    openEndedConversation() {
      const model = planReadModel(input.read());
      if (
        model?.planId === null ||
        model?.planId === undefined ||
        model.scenarioId !== "PL-S089" ||
        active !== null
      ) {
        return;
      }
      void execute({
        transitionId: "PL-T39",
        commandId: createCommandId(),
        action: "open",
        sourceScenarioId: "PL-S089",
        destinationScenarioId: "PL-S102",
        returnFocusId: model.planId,
      });
    },
    closeEndedConversation() {
      const model = planReadModel(input.read());
      if (
        model?.planId === null ||
        model?.planId === undefined ||
        model.scenarioId !== "PL-S102" ||
        active !== null
      ) {
        return;
      }
      void execute({
        transitionId: "PL-T39",
        commandId: createCommandId(),
        action: "back",
        sourceScenarioId: "PL-S102",
        destinationScenarioId: "PL-S089",
        returnFocusId: model.planId,
      });
    },
    openAttention(attentionId) {
      if (active !== null) return;
      void execute({
        transitionId: "PL-T34",
        commandId: createCommandId(),
        attentionId,
      });
    },
    returnToCoach() {
      if (active !== null) return;
      lastCommand = null;
      void refresh(false);
    },
    reload() {
      void refresh(false);
    },
    retry() {
      if (lastCommand === null) {
        void refresh(input.read().lastReady === null);
        return;
      }
      const retry = {
        ...lastCommand,
        commandId: createCommandId(),
      } as ExecutePlanTransitionRpcParams;
      if (retry.transitionId === "PL-T22") {
        input.publishSettingPending({ setting: retry.setting, value: retry.value });
      }
      if (retry.transitionId === "PL-T05") {
        coachState = { ...coachState, status: "idle", activeTurn: null };
        submitCommand(retry.text, retry.decision);
      } else {
        void execute(retry);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      hydrationGeneration += 1;
      active = null;
      input.publishSettingPending(null);
      disposeProgress?.();
      disposeProgress = null;
    },
  };
}
