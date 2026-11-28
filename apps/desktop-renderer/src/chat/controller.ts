import type { CoachClientCallOptions, CoachClientTerminalEnvelope } from "@enduragent/coach-client";
import {
  CoachClientCallAbortedError,
  CoachClientCallTimeoutError,
  CoachClientDisconnectedError,
  CoachClientProtocolError,
  CoachRpcRemoteError,
} from "@enduragent/coach-client";
import {
  PlanChangeIntentSchema,
  PlanActiveProjectionDataSchema,
  parseFeedbackCommand,
  type AttachmentAdmissionReadModel,
  type ChatAttachmentComposerReadModel,
  type CoachDecisionAnswer,
  type CoachDecisionReadModel,
  type ChatQueueSnapshot,
  type CoachTurnEventNotificationEnvelope,
  type CreatePlanningRequestRpcParams,
  type CreateWorkoutPlanningRequestRpcParams,
  type ListPlansResult,
  PlanChangeRequestSchema,
  type PlanChangePreviewRpcParams,
  type SubmitFeedbackResult,
  type PlanChangeApplyRpcParams,
  type PlanCreationActivateRpcParams,
  type PlanCreationAnswerInput,
  type PlanCreationAnswerSummary,
  type PlanCreationCardModel,
  type PlanningRequestDelivery,
  type TurnEvent,
} from "@enduragent/coach-contract";
import {
  CHAT_ATTACHMENT_FAILURE_COPY,
  CHAT_CONNECTION_INTERRUPTED_COPY,
  CHAT_DECISION_FAILURE_COPY,
  CHAT_DECISION_LOAD_FAILURE_COPY,
  CHAT_DECISION_SKIP_FAILURE_COPY,
  CHAT_DRAFT_SAVE_FAILURE_COPY,
  CHAT_EMPTY_RESPONSE_COPY,
  CHAT_FAILURE_COPY,
  CHAT_PLANNING_REQUEST_FAILURE_COPY,
  CHAT_PLANNING_REQUEST_LOAD_FAILURE_COPY,
  CHAT_PLAN_CREATION_CONTINUE_MISSING_COPY,
  CHAT_PLAN_CREATION_DISCARD_CONFLICT_COPY,
  CHAT_PLAN_CREATION_DISCARD_MISSING_COPY,
  CHAT_PLAN_CREATION_DISCARD_STALE_COPY,
  CHAT_PLAN_CREATION_FAILURE_COPY,
  CHAT_PROTOCOL_FAILURE_COPY,
  CHAT_QUEUE_LOAD_FAILURE_COPY,
  CHAT_QUEUE_REMOVE_FAILURE_COPY,
  CHAT_RESPONSE_STOPPED_COPY,
  CHAT_SEND_CONNECTING_COPY,
  DROPPED_ATTACHMENT_ADMISSION_TIMEOUT_MS,
  FEEDBACK_FAILED_COPY,
  FEEDBACK_SENT_COPY,
  FEEDBACK_TOO_LONG_COPY,
  FEEDBACK_USAGE_COPY,
  NEW_CONVERSATION_MEMORY_WARNING_COPY,
  NEW_CONVERSATION_NOT_STARTED_COPY,
  NEW_CONVERSATION_SUCCESS_COPY,
  NEW_CONVERSATION_UNCERTAIN_COPY,
  PLAN_CHANGE_TEXT_LENGTH_COPY,
  clearPlanCreationPause,
  newConversationOutcome,
  planChangeApplyRejectionCopy,
  planChangeParameterCopy,
  planCreationBuildRejectionCopy,
  planCreationDiscardNoticeCopy,
  planCreationQuestionKey,
  readPlanCreationPause,
  reportBestEffortAsync,
  reportBestEffortSync,
  writePlanCreationPause,
  type ActivePlanKnowledge,
  type ChatAppendDelta,
  type ChatController,
  type ChatView,
  type ChatViewControls,
  type NewConversationEvidence,
  type PlanCreationDiscardEvent,
} from "./controller-helpers";
import { previewPlanChange, applyPlanChange } from "../state/adapters/plan";
import {
  EMPTY_PLAN_CHANGE_SURFACE,
  PLAN_CHANGES_PAUSED_NOTICE,
  planChangePendingCheck,
  type PlanChangeSurfaceState,
} from "../state/chat-slice";
import type { DesktopCoachClient, DesktopCoachClientProvider } from "../coach-client";
import {
  DESKTOP_CHAT_ID,
  EMPTY_CHAT_STATE,
  hasClearableConversation,
  nextDrainGroup,
  type ChatSentAttachment,
  type NewConversationCheck,
} from "../turn-state";
import { reduceChatState } from "./message-state";
import {
  TRANSCRIPT_HYDRATION_PAGE_LIMIT,
  createTranscriptHydrator,
  emptyTranscriptHydration,
  mergeHydratedMessages,
  transcriptTurnIds,
  type TranscriptPage,
} from "./hydration";
import { COACH_RESPONSE_CODE_UNIT_LIMIT, COACH_TURN_EVENT_LIMIT } from "./limits";

export {
  CHAT_ATTACHMENT_FAILURE_COPY,
  CHAT_CONNECTION_INTERRUPTED_COPY,
  CHAT_DECISION_FAILURE_COPY,
  CHAT_DECISION_LOAD_FAILURE_COPY,
  CHAT_DECISION_SKIP_FAILURE_COPY,
  CHAT_DRAFT_SAVE_FAILURE_COPY,
  CHAT_EMPTY_RESPONSE_COPY,
  CHAT_FAILURE_COPY,
  CHAT_PLANNING_REQUEST_FAILURE_COPY,
  CHAT_PLANNING_REQUEST_LOAD_FAILURE_COPY,
  CHAT_PLAN_CREATION_CONTINUE_MISSING_COPY,
  CHAT_PLAN_CREATION_DISCARD_CONFLICT_COPY,
  CHAT_PLAN_CREATION_DISCARD_MISSING_COPY,
  CHAT_PLAN_CREATION_DISCARD_STALE_COPY,
  CHAT_PLAN_CREATION_FAILURE_COPY,
  CHAT_PROTOCOL_FAILURE_COPY,
  CHAT_QUEUE_LOAD_FAILURE_COPY,
  CHAT_QUEUE_REMOVE_FAILURE_COPY,
  CHAT_RESPONSE_STOPPED_COPY,
  CHAT_SEND_CONNECTING_COPY,
  DROPPED_ATTACHMENT_ADMISSION_TIMEOUT_MS,
  FEEDBACK_FAILED_COPY,
  FEEDBACK_SENT_COPY,
  FEEDBACK_TOO_LONG_COPY,
  FEEDBACK_USAGE_COPY,
  NEW_CONVERSATION_MEMORY_WARNING_COPY,
  NEW_CONVERSATION_NOT_STARTED_COPY,
  NEW_CONVERSATION_SUCCESS_COPY,
  NEW_CONVERSATION_UNCERTAIN_COPY,
  type ActivePlanKnowledge,
  type ChatAppendDelta,
  type ChatController,
  type ChatView,
  type ChatViewControls,
  type PlanCreationDiscardEvent,
};

interface QueuedRetry {
  readonly requestKey: number;
  readonly promise: Promise<void>;
  readonly token: object;
}

type ChatQueueCall =
  | {
      readonly method: "runQueuedCommand";
      readonly queuedMessageId: string;
      readonly queuedMessageIds: readonly string[];
    }
  | {
      readonly method: "retryQueuedTurn";
      readonly claimId: string;
      readonly queuedMessageIds: readonly string[];
    }
  | { readonly method: "resumeChatQueue"; readonly queuedMessageIds: readonly string[] };

interface InterruptedQueueOrigin {
  readonly requestKey: number;
  readonly call: ChatQueueCall;
}

interface ChatRun {
  readonly task: Promise<void>;
  allowInterruptedDrain(): boolean;
}

type BootProbeStatus = "idle" | "succeeded" | "failed";

interface ActiveStopRequest {
  readonly requestKey: number;
  request(): void;
}

type PendingPlanningRequestCreate =
  | {
      readonly kind: "generic";
      readonly request: CreatePlanningRequestRpcParams;
    }
  | {
      readonly kind: "workout";
      readonly request: CreateWorkoutPlanningRequestRpcParams;
    };

export function createChatController(input: {
  readonly clients: DesktopCoachClientProvider;
  readonly view: ChatView;
  readonly now?: () => number;
  readonly refreshTrainingContext: () => Promise<void>;
  readonly refreshSpend: () => Promise<void>;
  readonly refreshPlan?: () => Promise<void>;
  readonly readPlanLibrary?: () => ListPlansResult | null;
  readonly readPlanChange?: () => PlanChangeSurfaceState;
  readonly publishPlanChange?: (next: PlanChangeSurfaceState) => void;
  readonly refreshPlanLibrary?: () => Promise<void>;
  readonly openChat?: () => void;
  readonly readTranscriptPage?: (request: {
    readonly cursor: string | null;
    readonly limit: number;
  }) => Promise<TranscriptPage>;
  readonly canChat?: () => boolean;
  readonly initialQueueSnapshot?: ChatQueueSnapshot;
  readonly nativeAttachments?: {
    readonly choose: () => Promise<readonly AttachmentAdmissionReadModel[]>;
    readonly paste: () => Promise<readonly AttachmentAdmissionReadModel[]>;
  };
  readonly openPlanningRequest?: (chatId: string, requestId: string) => void;
  readonly submitAthleteFeedback?: (text: string) => Promise<SubmitFeedbackResult>;
}): ChatController {
  let state =
    input.initialQueueSnapshot === undefined
      ? EMPTY_CHAT_STATE
      : reduceChatState(EMPTY_CHAT_STATE, {
          type: "queue-snapshot",
          snapshot: input.initialQueueSnapshot,
        });
  let hydration = emptyTranscriptHydration();
  let sequence = 0;
  let disposed = false;
  let hydrationRenderSuppressed = false;
  let activeTask: Promise<void> | undefined;
  const outstandingChatTasks = new Set<Promise<void>>();
  let queuedRetry: QueuedRetry | undefined;
  let interruptedQueueOrigin: InterruptedQueueOrigin | undefined;
  let retryClient: DesktopCoachClient | undefined;
  let probeTask: Promise<void> | undefined;
  let resetTask: Promise<void> | undefined;
  let resetEvidence: NewConversationEvidence | null = null;
  let newConversationCheck:
    | { readonly trigger: "automatic" | "athlete"; readonly task: Promise<void> }
    | undefined;
  let activeStopRequest: ActiveStopRequest | undefined;
  let retryReconnect = true;
  let decision: CoachDecisionReadModel | null = null;
  let decisionPhase: "idle" | "continuing" | "recovering" = "idle";
  let decisionAnswerLabel: string | null = null;
  let decisionError: string | null = null;
  let decisionLoaded = true;
  let decisionLoadError: string | null = null;
  let decisionLoadTask: Promise<void> | undefined;
  let queueLoaded = input.initialQueueSnapshot !== undefined;
  let queueLoadError: string | null = null;
  let queueMutationError: string | null = null;
  let queueMutationCount = 0;
  let attachmentSurface: ChatAttachmentComposerReadModel | null = null;
  let attachmentAdmissions: readonly AttachmentAdmissionReadModel[] = [];
  let draftError: string | null = null;
  let attachmentError: string | null = null;
  let attachmentTextRevision = 0;
  let attachmentTextSaveTask: Promise<void> = Promise.resolve();
  let attachmentGeneration = 0;
  let attachmentSurfaceRevision = 0;
  let attachmentOperationSequence = 0;
  const attachmentWriteTokens = new Set<number>();
  const attachmentBusyTokens = new Set<number>();
  const attachmentWriteWaiters = new Set<() => void>();
  const droppedAttachmentAdmissions = new Map<
    string,
    {
      readonly token: number;
      readonly generation: number;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  >();
  const attachmentSummaries = new Map<string, ChatSentAttachment>();
  let planningRequests: readonly PlanningRequestDelivery[] = [];
  let planningRequestsLoaded = false;
  let planningRequestBusyId: string | null = null;
  let planningRequestError: string | null = null;
  let planningRequestFocusId: string | null = null;
  let planningRequestLoadTask: Promise<void> | undefined;
  let pendingPlanningRequestCreate: PendingPlanningRequestCreate | null = null;
  let planCreation: PlanCreationCardModel | null = null;
  let planCreationLoaded = false;
  let planCreationBusy = false;
  let activationAttempt: PlanCreationActivateRpcParams | null = null;
  let previewAttempt: PlanChangePreviewRpcParams | null = null;
  let applyAttempt: PlanChangeApplyRpcParams | null = null;
  let planCreationError: string | null = null;
  let planCreationPaused = false;
  let planCreationEditingKey: PlanCreationAnswerSummary["answerKey"] | null = null;
  let planCreationEditReturnPaused = false;
  let planCreationFocusRevision = 0;
  let planCreationDiscardConfirmationOpen = false;
  let planCreationActivateConfirmationOpen = false;
  let activePlanKnowledge: ActivePlanKnowledge = { kind: "unknown" };
  let planCreationDiscardEvents: readonly PlanCreationDiscardEvent[] = [];
  let planCreationNotice: string | null = null;
  let planCreationFocusRequest: {
    readonly target: "discard" | "activate" | "edit" | "start" | "continue" | "change" | "composer";
    readonly libraryTarget?: "continue" | "change";
    readonly revision: number;
  } | null = null;
  let planCreationActionFocusRevision = 0;
  let pendingPlanCreationCommand: { readonly key: string; readonly id: string } | null = null;
  let decisionActionTask: Promise<void> | undefined;
  let initialized = false;
  let stalledDrainHeadId: string | null = null;
  let activeDrainTask: Promise<void> | undefined;
  const bootProbes: {
    decision: BootProbeStatus;
    session: BootProbeStatus;
    queue: BootProbeStatus;
    attachments: BootProbeStatus;
    planningRequests: BootProbeStatus;
  } = {
    decision: "idle",
    session: "idle",
    queue: "idle",
    attachments: "idle",
    planningRequests: "idle",
  };
  let epoch = 0;
  const canChat = input.canChat ?? (() => true);

  const nextId = (prefix: "request" | "message"): string => `${prefix}-${++sequence}`;
  const refreshPlanLibraryBestEffort = (): Promise<void> =>
    reportBestEffortAsync("desktop-chat-refresh-plan-library-failed", () =>
      input.refreshPlanLibrary?.(),
    );
  const loadPlanningRequestsBestEffort = (): Promise<void> =>
    reportBestEffortAsync("desktop-chat-load-planning-requests-failed", () =>
      loadPlanningRequests(),
    );
  const now = input.now ?? Date.now;
  const resetBlocksWork = (): boolean =>
    state.session.resetPhase === "confirming" ||
    state.session.resetPhase === "resetting" ||
    (state.session.resetPhase === "uncertain" && newConversationCheck !== undefined);
  const decisionBlocksWork = (): boolean =>
    !decisionLoaded ||
    decision?.status === "unanswered" ||
    (decision?.status === "answered" && decision.continuation.status === "pending");
  const commitmentQuestionAllowsChat = (): boolean =>
    planCreation !== null &&
    (planCreation.pendingCommitment !== null ||
      (!planCreationPaused &&
        (planCreationEditingKey === "commitments" ||
          (planCreationEditingKey === null &&
            planCreation.openQuestion?.kind === "commitments-question"))));
  const planCreationBlocksWork = (): boolean =>
    planCreationDiscardConfirmationOpen ||
    planCreationActivateConfirmationOpen ||
    (!planCreationPaused &&
      (planCreation?.pendingCheck != null || planCreation?.pendingCommitment != null) &&
      planCreationEditingKey === null) ||
    (!planCreationPaused &&
      planCreation !== null &&
      !commitmentQuestionAllowsChat() &&
      (planCreationEditingKey !== null || planCreation.openQuestion !== null));
  const decisionBlocksReset = (): boolean =>
    !decisionLoaded ||
    (decision?.status === "answered" && decision.continuation.status === "pending");
  const chatWorkInFlight = (): boolean =>
    state.status === "streaming" ||
    activeTask !== undefined ||
    decisionActionTask !== undefined ||
    outstandingChatTasks.size > 0 ||
    attachmentWriteTokens.size > 0 ||
    queueMutationCount > 0 ||
    queuedRetry !== undefined;
  const canOpenNewConversation = (): boolean =>
    canChat() &&
    queueLoaded &&
    !disposed &&
    (hasClearableConversation(state) ||
      hydration.turns.length > 0 ||
      hydration.entries.length > 0 ||
      attachmentSurface?.draft != null) &&
    state.session.resetPhase === "idle" &&
    !chatWorkInFlight() &&
    !decisionBlocksReset() &&
    state.retryRequired == null &&
    resetTask === undefined;
  const newConversationCheckControl = (): NewConversationCheck => {
    if (state.session.resetPhase !== "uncertain" || newConversationCheck?.trigger === "automatic") {
      return "hidden";
    }
    return canChat() && newConversationCheck === undefined && !chatWorkInFlight()
      ? "ready"
      : "busy";
  };
  const render = (appendDelta?: ChatAppendDelta): void => {
    if (disposed) return;
    reportBestEffortSync("desktop-chat-view-render-failed", () => {
      input.view.render(
        hydration.turns.length === 0 && hydration.entries.length === 0
          ? state
          : {
              ...state,
              messages: mergeHydratedMessages(hydration.turns, state.messages, hydration.entries),
            },
        {
          newConversationDisabled: !canOpenNewConversation(),
          newConversationCheck: newConversationCheckControl(),
          workBlocked: resetBlocksWork() || !queueLoaded,
          decisionLoading: !decisionLoaded,
          decisionLoadError,
          queueLoadError,
          queueMutationError,
          attachments: {
            value: attachmentSurface,
            admissions: attachmentAdmissions,
            busy: attachmentBusyTokens.size > 0,
            draftError,
            error: attachmentError,
          },
          planningRequests: {
            value: planningRequests,
            loaded: planningRequestsLoaded,
            busyId: planningRequestBusyId,
            error: planningRequestError,
            focusId: planningRequestFocusId,
          },
          planCreation: {
            value: planCreation,
            loaded: planCreationLoaded,
            busy: planCreationBusy,
            error: planCreationError,
            paused: planCreationPaused,
            editingKey: planCreationEditingKey,
            focusRevision: planCreationFocusRevision,
            discardConfirmationOpen: planCreationDiscardConfirmationOpen,
            activateConfirmationOpen: planCreationActivateConfirmationOpen,
            activePlanKnowledge,
            discardEvents: planCreationDiscardEvents,
            notice: planCreationNotice,
            focusRequest: planCreationFocusRequest,
          },
          ...(appendDelta === undefined ? {} : { appendDelta }),
          hydration: {
            status: hydration.status,
            hasEarlier: hydration.nextCursor !== null,
            revision: hydration.revision,
            change: hydration.change,
            entries: hydration.entries,
          },
          decision: {
            value: decision,
            phase: decisionPhase,
            answerLabel: decisionAnswerLabel,
            error: decisionError,
          },
        },
      );
    });
    scheduleDrainIfEligible();
  };
  const attachmentGenerationIsCurrent = (generation: number): boolean =>
    !disposed && generation === attachmentGeneration;
  const attachmentSurfaceIsCurrent = (generation: number, revision: number): boolean =>
    attachmentGenerationIsCurrent(generation) && revision === attachmentSurfaceRevision;
  const claimAttachmentSurface = (): number => ++attachmentSurfaceRevision;
  const beginAttachmentWrite = (
    busy: boolean,
  ): { readonly token: number; readonly generation: number } | null => {
    if (disposed || resetBlocksWork()) return null;
    const token = ++attachmentOperationSequence;
    claimAttachmentSurface();
    attachmentWriteTokens.add(token);
    if (busy) attachmentBusyTokens.add(token);
    render();
    return { token, generation: attachmentGeneration };
  };
  const finishAttachmentWrite = (token: number): void => {
    attachmentWriteTokens.delete(token);
    attachmentBusyTokens.delete(token);
    if (attachmentWriteTokens.size === 0) {
      for (const resolve of attachmentWriteWaiters) resolve();
      attachmentWriteWaiters.clear();
    }
    render();
  };
  const waitForAttachmentWrites = (): Promise<void> =>
    attachmentWriteTokens.size === 0
      ? Promise.resolve()
      : new Promise((resolve) => attachmentWriteWaiters.add(resolve));
  const clearDroppedAttachmentAdmissions = (): void => {
    for (const entry of droppedAttachmentAdmissions.values()) {
      globalThis.clearTimeout(entry.timer);
    }
    droppedAttachmentAdmissions.clear();
  };
  const releaseDroppedAttachmentAdmission = (operationId: string): void => {
    const ownership = droppedAttachmentAdmissions.get(operationId);
    if (ownership === undefined) return;
    droppedAttachmentAdmissions.delete(operationId);
    globalThis.clearTimeout(ownership.timer);
    finishAttachmentWrite(ownership.token);
  };
  const reduce = (
    action: Parameters<typeof reduceChatState>[1],
    appendDelta?: ChatAppendDelta,
  ): void => {
    state = reduceChatState(state, action);
    render(appendDelta);
  };
  const applyQueueSnapshot = (snapshot: ChatQueueSnapshot): void => {
    state = reduceChatState(state, { type: "queue-snapshot", snapshot });
    if (stalledDrainHeadId !== null && state.queued[0]?.id !== stalledDrainHeadId) {
      stalledDrainHeadId = null;
    }
    render();
  };
  const readTranscriptPage =
    input.readTranscriptPage ??
    (async (): Promise<TranscriptPage> => ({
      schemaVersion: 1,
      status: "page",
      turns: [],
      nextCursor: null,
    }));
  const hydrator = createTranscriptHydrator({
    readPage: readTranscriptPage,
    onChange(next) {
      hydration = next;
      if (!hydrationRenderSuppressed) render();
    },
  });
  const updateReset = (
    hydrate: () => void,
    action: Parameters<typeof reduceChatState>[1],
  ): void => {
    hydrationRenderSuppressed = true;
    try {
      hydrate();
      state = reduceChatState(state, action);
    } finally {
      hydrationRenderSuppressed = false;
    }
    render();
  };
  const finishNewConversation = (
    nextAttachmentSurface: ChatAttachmentComposerReadModel | null,
    action: Extract<
      Parameters<typeof reduceChatState>[1],
      { readonly type: "reset-succeeded" | "reset-checked" }
    >,
    page?: Extract<TranscriptPage, { readonly status: "page" }>,
  ): void => {
    resetEvidence = null;
    attachmentSurface = nextAttachmentSurface;
    attachmentAdmissions = [];
    clearDroppedAttachmentAdmissions();
    draftError = null;
    attachmentError = null;
    stalledDrainHeadId = null;
    sequence += 1;
    retryClient = undefined;
    queuedRetry = undefined;
    interruptedQueueOrigin = undefined;
    decision = null;
    decisionLoaded = true;
    decisionLoadError = null;
    decisionPhase = "idle";
    decisionAnswerLabel = null;
    decisionError = null;
    attachmentSummaries.clear();
    planCreationDiscardEvents = [];
    implicitPlanChangeRouting = false;
    input.publishPlanChange?.(EMPTY_PLAN_CHANGE_SURFACE);
    updateReset(() => hydrator.resetSucceeded(page), action);
  };
  const settleNewConversation = async (
    before: NewConversationEvidence,
    current: () => boolean,
  ): Promise<void> => {
    const client = await input.clients.getClient();
    await client.call("hasSession", { chatId: DESKTOP_CHAT_ID });
    const page = await readTranscriptPage({
      cursor: null,
      limit: TRANSCRIPT_HYDRATION_PAGE_LIMIT,
    });
    const queue = await client.call("getChatQueue", { chatId: DESKTOP_CHAT_ID });
    const sentTurnIds = new Set(
      state.messages.flatMap((message) =>
        message.turnId === undefined || before.turnIds.has(message.turnId) ? [] : [message.turnId],
      ),
    );
    const outcome = newConversationOutcome(before, page, queue, sentTurnIds);
    if (!current() || outcome === "unknown" || page.status !== "page") return;
    if (outcome === "not-started") {
      resetEvidence = null;
      reduce({ type: "reset-checked", outcome, announcement: NEW_CONVERSATION_NOT_STARTED_COPY });
      return;
    }
    const keepDraft = attachmentOperationSequence !== before.draftWrites;
    await attachmentTextSaveTask;
    if (!current()) return;
    const nextAttachmentSurface = keepDraft
      ? attachmentSurface
      : await client.call("clearChatAttachmentDraft", { chatId: DESKTOP_CHAT_ID });
    if (!current()) return;
    finishNewConversation(
      nextAttachmentSurface,
      {
        type: "reset-checked",
        outcome,
        announcement: NEW_CONVERSATION_MEMORY_WARNING_COPY,
        keepDraft,
      },
      page,
    );
    applyQueueSnapshot(queue);
  };
  const runNewConversationCheck = (trigger: "automatic" | "athlete"): Promise<void> => {
    if (newConversationCheck !== undefined) return newConversationCheck.task;
    const before = resetEvidence;
    if (disposed || before === null || state.session.resetPhase !== "uncertain") {
      return Promise.resolve();
    }
    const checkAttachmentGeneration = ++attachmentGeneration;
    claimAttachmentSurface();
    const task: Promise<void> = settleNewConversation(
      before,
      () =>
        attachmentGenerationIsCurrent(checkAttachmentGeneration) &&
        state.session.resetPhase === "uncertain",
    )
      .catch(() => undefined)
      .finally(() => {
        if (newConversationCheck?.task === task) newConversationCheck = undefined;
        render();
      });
    newConversationCheck = { trigger, task };
    render();
    return task;
  };

  const run = (
    userMessage: string,
    includeUser: boolean,
    reconnect: boolean,
    queueCall?: ChatQueueCall,
    attachments: readonly ChatSentAttachment[] = [],
    reconnectQueueOrigin?: ChatQueueCall,
  ): ChatRun => {
    epoch += 1;
    const requestKey = Number(nextId("request").slice("request-".length));
    const userMessageId = nextId("message");
    const assistantMessageId = nextId("message");
    let allowInterruptedDrain = false;
    reduce({
      type: "submit",
      requestKey,
      occurredAtMs: now(),
      userMessage,
      userMessageId,
      assistantMessageId,
      includeUser,
      attachments,
    });
    let callStarted = false;
    let task!: Promise<void>;
    task = (async () => {
      const immutableQueueOrigin = queueCall ?? reconnectQueueOrigin;
      let activeQueueCall = immutableQueueOrigin;
      let boundRequestId: string | number | undefined;
      let boundTurnId: string | undefined;
      let pendingEnvelope: CoachTurnEventNotificationEnvelope | undefined;
      let eventCount = 0;
      let startSeen = false;
      let finalText: string | undefined;
      let interruptedText: string | undefined;
      let terminal: CoachClientTerminalEnvelope | undefined;
      let terminalHadFinal = false;
      let protocolFault = false;
      let requestedDecision: CoachDecisionReadModel | undefined;
      const callAbortController = new AbortController();
      let client: DesktopCoachClient | undefined;
      let stopRequested = false;
      let stopTask: Promise<void> | undefined;
      const current = (): boolean => !disposed && state.activeTurn?.requestKey === requestKey;
      const preserveInterruptedQueueOrigin = (): void => {
        interruptedQueueOrigin =
          immutableQueueOrigin === undefined
            ? undefined
            : { requestKey, call: immutableQueueOrigin };
      };
      const failProtocol = (): void => {
        if (protocolFault) return;
        protocolFault = true;
        callAbortController.abort();
      };
      const requestStop = (): void => {
        stopRequested = true;
        if (client === undefined || boundTurnId === undefined || stopTask !== undefined) return;
        const stopClient = client;
        const stopTurnId = boundTurnId;
        stopTask = reportBestEffortAsync("desktop-chat-stop-chat-failed", () =>
          stopClient.call("stopChat", { chatId: DESKTOP_CHAT_ID, turnId: stopTurnId }),
        );
      };
      activeStopRequest = { requestKey, request: requestStop };

      try {
        if (reconnect) {
          client = await input.clients.reconnect(retryClient);
          retryClient = undefined;
        } else {
          client = await input.clients.getClient();
        }
        if (!current()) return;
        if (reconnect || reconnectQueueOrigin !== undefined) {
          const snapshot = await refreshQueue(client);
          if (reconnectQueueOrigin !== undefined) {
            const originIds = reconnectQueueOrigin.queuedMessageIds;
            const matchesOrigin = (ids: readonly string[]): boolean =>
              ids.length === originIds.length && ids.every((id, index) => id === originIds[index]);
            const recovery = snapshot.retryRequired;
            if (recovery !== undefined && matchesOrigin(recovery.queuedMessageIds)) {
              activeQueueCall = {
                method: "retryQueuedTurn",
                claimId: recovery.claimId,
                queuedMessageIds: recovery.queuedMessageIds,
              };
            } else if (
              recovery === undefined &&
              matchesOrigin(
                snapshot.items.slice(0, originIds.length).map((item) => item.queuedMessageId),
              )
            ) {
              activeQueueCall = reconnectQueueOrigin;
            } else if (
              recovery === undefined &&
              originIds.every((id) => !snapshot.items.some((item) => item.queuedMessageId === id))
            ) {
              interruptedQueueOrigin = undefined;
              reduce({ type: "discard-submission", requestKey });
              return;
            } else {
              throw new CoachClientProtocolError();
            }
          }
        }
        if (!current()) return;
        callStarted = true;
        const callOptions = {
          signal: callAbortController.signal,
          onNotificationEnvelope(envelope) {
            if (!current() || protocolFault) return;
            if (
              envelope.method !== "coach.turnEvent" ||
              envelope.params.requestMethod !== (activeQueueCall?.method ?? "chat") ||
              envelope.params.turnId.length === 0
            ) {
              failProtocol();
              return;
            }
            if (boundRequestId === undefined) {
              boundRequestId = envelope.params.requestId;
              boundTurnId = envelope.params.turnId;
              reduce({ type: "bind-turn", requestKey, turnId: boundTurnId });
              if (stopRequested) requestStop();
            } else if (
              envelope.params.requestId !== boundRequestId ||
              envelope.params.turnId !== boundTurnId
            ) {
              failProtocol();
              return;
            }
            pendingEnvelope = envelope;
          },
          onEvent(event: TurnEvent) {
            if (!current() || protocolFault) return;
            const envelope = pendingEnvelope;
            pendingEnvelope = undefined;
            if (
              envelope === undefined ||
              boundTurnId === undefined ||
              event.turnId !== boundTurnId ||
              envelope.params.event.turnId !== boundTurnId
            ) {
              failProtocol();
              return;
            }
            if (eventCount >= COACH_TURN_EVENT_LIMIT) {
              failProtocol();
              return;
            }
            eventCount += 1;
            if (requestedDecision !== undefined) {
              failProtocol();
              return;
            }
            if (event.type === "turn-start") {
              if (eventCount !== 1 || startSeen || event.chatId !== DESKTOP_CHAT_ID) {
                failProtocol();
                return;
              }
              startSeen = true;
              if (activeQueueCall !== undefined) {
                reduce({ type: "queue-claimed", ids: activeQueueCall.queuedMessageIds });
              }
            }
            let appendDelta: ChatAppendDelta | undefined;
            if (event.type === "text_delta") {
              const activeTurn = state.activeTurn;
              if (activeTurn === null || activeTurn.requestKey !== requestKey) return;
              const previousTextLength = activeTurn.draft.length;
              if (event.delta.length > COACH_RESPONSE_CODE_UNIT_LIMIT - previousTextLength) {
                failProtocol();
                return;
              }
              appendDelta = {
                messageId: activeTurn.assistantMessageId,
                previousTextLength,
                nextTextLength: previousTextLength + event.delta.length,
                delta: event.delta,
              };
            } else if (
              (event.type === "final-text" || event.type === "interrupted") &&
              event.text.length > COACH_RESPONSE_CODE_UNIT_LIMIT
            ) {
              failProtocol();
              return;
            }
            if (event.type === "final-text") finalText = event.text;
            if (event.type === "interrupted") interruptedText = event.text;
            if (event.type === "decision-requested") {
              if (
                !startSeen ||
                event.chatId !== DESKTOP_CHAT_ID ||
                event.decision.status !== "unanswered"
              ) {
                failProtocol();
                return;
              }
              requestedDecision = event.decision;
              reduce({
                type: "bind-decision",
                requestKey,
                decisionId: event.decision.decisionId,
              });
              decision = event.decision;
              decisionPhase = "idle";
              decisionAnswerLabel = null;
              decisionError = null;
              render();
              return;
            }
            reduce({ type: "event", requestKey, event }, appendDelta);
          },
          onTerminalEnvelope(envelope) {
            if (!current()) return;
            terminal = envelope;
            terminalHadFinal = finalText !== undefined;
          },
        } satisfies CoachClientCallOptions<"chat">;
        const queuedResult =
          activeQueueCall?.method === "resumeChatQueue"
            ? await client.call("resumeChatQueue", { chatId: DESKTOP_CHAT_ID }, callOptions)
            : activeQueueCall?.method === "runQueuedCommand"
              ? await client.call(
                  "runQueuedCommand",
                  {
                    chatId: DESKTOP_CHAT_ID,
                    queuedMessageId: activeQueueCall.queuedMessageId,
                  },
                  callOptions,
                )
              : activeQueueCall?.method === "retryQueuedTurn"
                ? await client.call(
                    "retryQueuedTurn",
                    { chatId: DESKTOP_CHAT_ID, claimId: activeQueueCall.claimId },
                    callOptions,
                  )
                : undefined;
        const result =
          queuedResult === undefined
            ? await client.call(
                "chat",
                { chatId: DESKTOP_CHAT_ID, message: userMessage },
                callOptions,
              )
            : (queuedResult.response ?? { text: "" });
        if (!current()) return;
        if (queuedResult !== undefined) applyQueueSnapshot(queuedResult.snapshot);
        if (
          queuedResult !== undefined &&
          queuedResult.response === undefined &&
          boundTurnId === undefined
        ) {
          interruptedQueueOrigin = undefined;
          const headId = state.queued[0]?.id;
          if (headId !== undefined && activeQueueCall?.queuedMessageIds.includes(headId) === true) {
            stalledDrainHeadId = headId;
          }
          reduce({ type: "discard-submission", requestKey });
          return;
        }
        if (interruptedText !== undefined) {
          if (
            protocolFault ||
            terminal === undefined ||
            !("result" in terminal) ||
            finalText !== undefined ||
            result.text !== interruptedText
          ) {
            retryClient = client;
            retryReconnect = true;
            preserveInterruptedQueueOrigin();
            reduce({ type: "interrupt", requestKey, copy: CHAT_PROTOCOL_FAILURE_COPY });
            return;
          }
          retryClient = undefined;
          retryReconnect = false;
          preserveInterruptedQueueOrigin();
          allowInterruptedDrain = true;
          return;
        }
        if (requestedDecision !== undefined) {
          if (
            protocolFault ||
            terminal === undefined ||
            !("result" in terminal) ||
            finalText !== undefined
          ) {
            retryClient = client;
            retryReconnect = true;
            decision = null;
            preserveInterruptedQueueOrigin();
            reduce({ type: "interrupt", requestKey, copy: CHAT_PROTOCOL_FAILURE_COPY });
            return;
          }
          interruptedQueueOrigin = undefined;
          reduce({ type: "discard", requestKey });
          return;
        }
        if (
          protocolFault ||
          terminal === undefined ||
          !("result" in terminal) ||
          !terminalHadFinal ||
          finalText === undefined ||
          !("text" in result) ||
          result.text !== finalText
        ) {
          retryClient = client;
          retryReconnect = true;
          preserveInterruptedQueueOrigin();
          reduce({ type: "interrupt", requestKey, copy: CHAT_PROTOCOL_FAILURE_COPY });
          return;
        }
        if (!/\S/u.test(finalText)) {
          retryClient = client;
          retryReconnect = true;
          preserveInterruptedQueueOrigin();
          reduce({ type: "interrupt", requestKey, copy: CHAT_EMPTY_RESPONSE_COPY });
          return;
        }
        interruptedQueueOrigin = undefined;
        stalledDrainHeadId = null;
        reduce({ type: "complete", requestKey, message: result.message });
      } catch (error) {
        if (!current()) return;
        if (activeQueueCall !== undefined && client !== undefined) {
          const queueClient = client;
          await reportBestEffortAsync("desktop-chat-refresh-queue-failed", async () => {
            applyQueueSnapshot(await queueClient.call("getChatQueue", { chatId: DESKTOP_CHAT_ID }));
          });
        }
        if (protocolFault || error instanceof CoachClientProtocolError) {
          retryClient = client;
          retryReconnect = true;
          preserveInterruptedQueueOrigin();
          reduce({ type: "interrupt", requestKey, copy: CHAT_PROTOCOL_FAILURE_COPY });
        } else if (
          error instanceof CoachClientDisconnectedError ||
          error instanceof CoachClientCallTimeoutError ||
          error instanceof CoachClientCallAbortedError
        ) {
          retryClient = client;
          retryReconnect = true;
          preserveInterruptedQueueOrigin();
          reduce({ type: "interrupt", requestKey, copy: CHAT_CONNECTION_INTERRUPTED_COPY });
        } else {
          interruptedQueueOrigin = undefined;
          const headId = state.queued[0]?.id;
          if (headId !== undefined && activeQueueCall?.queuedMessageIds.includes(headId) === true) {
            stalledDrainHeadId = headId;
          }
          reduce({ type: "fail", requestKey, copy: CHAT_FAILURE_COPY });
        }
      } finally {
        if (activeStopRequest?.requestKey === requestKey) activeStopRequest = undefined;
        if (callStarted) {
          void reportBestEffortAsync("desktop-chat-refresh-spend-failed", () =>
            input.refreshSpend(),
          );
          await reportBestEffortAsync("desktop-chat-refresh-training-context-failed", () =>
            input.refreshTrainingContext(),
          );
        }
        const released = outstandingChatTasks.delete(task);
        if (activeTask === task) {
          activeTask = undefined;
        }
        if (released) render();
      }
    })();
    activeTask = task;
    outstandingChatTasks.add(task);
    render();
    return { task, allowInterruptedDrain: () => allowInterruptedDrain };
  };

  const dispatch = (
    userMessage: string,
    includeUser: boolean,
    reconnect: boolean,
    queueOrigin?: ChatQueueCall,
  ): Promise<void> => {
    const chatRun = run(userMessage, includeUser, reconnect, undefined, [], queueOrigin);
    return chatRun.task.then(() => drain(chatRun.allowInterruptedDrain()));
  };

  const dispatchQueue = (
    userMessage: string,
    queueCall: ChatQueueCall,
    includeUser = true,
  ): Promise<void> => {
    const attachments = queueCall.queuedMessageIds
      .flatMap((id) => state.queued.find((message) => message.id === id)?.attachmentIds ?? [])
      .map((id) => attachmentSummaries.get(id))
      .filter((attachment): attachment is ChatSentAttachment => attachment !== undefined);
    const chatRun = run(userMessage, includeUser, false, queueCall, attachments);
    return chatRun.task.then(() => drain(chatRun.allowInterruptedDrain()));
  };

  const answerLabel = (
    currentDecision: CoachDecisionReadModel,
    answer: CoachDecisionAnswer,
  ): string => {
    if (answer.kind === "custom") return answer.text;
    return (
      currentDecision.options.find((option) => option.id === answer.optionId)?.label ??
      "Saved choice"
    );
  };

  const refreshDecision = async (
    client?: DesktopCoachClient,
  ): Promise<CoachDecisionReadModel | null> => {
    const activeClient = client ?? (await input.clients.getClient());
    const result = await activeClient.call("getCoachDecision", { chatId: DESKTOP_CHAT_ID });
    if (disposed) return null;
    decision = result.decision;
    decisionPhase =
      decision?.status === "answered" && decision.continuation.status === "pending"
        ? "recovering"
        : "idle";
    if (decision?.status !== "answered") decisionAnswerLabel = null;
    decisionError = null;
    decisionLoaded = true;
    decisionLoadError = null;
    bootProbes.decision = "succeeded";
    render();
    return decision;
  };

  const refreshQueue = async (client?: DesktopCoachClient): Promise<ChatQueueSnapshot> => {
    const activeClient = client ?? (await input.clients.getClient());
    const snapshot = await activeClient.call("getChatQueue", { chatId: DESKTOP_CHAT_ID });
    if (disposed) return snapshot;
    queueLoaded = true;
    queueLoadError = null;
    bootProbes.queue = "succeeded";
    applyQueueSnapshot(snapshot);
    return snapshot;
  };

  const refreshAttachments = async (
    client?: DesktopCoachClient,
    generation = attachmentGeneration,
    reportError = true,
  ): Promise<boolean> => {
    const attemptRevision = attachmentSurfaceRevision;
    let activeClient: DesktopCoachClient;
    try {
      activeClient = client ?? (await input.clients.getClient());
    } catch {
      if (bootProbes.attachments !== "succeeded") bootProbes.attachments = "failed";
      if (reportError && attachmentSurfaceIsCurrent(generation, attemptRevision)) {
        attachmentError = CHAT_ATTACHMENT_FAILURE_COPY;
        render();
      }
      return false;
    }
    if (attachmentWriteTokens.size > 0) await waitForAttachmentWrites();
    if (!attachmentGenerationIsCurrent(generation)) return true;
    const revision = claimAttachmentSurface();
    let surface: ChatAttachmentComposerReadModel;
    try {
      surface = await activeClient.call("getChatAttachmentComposer", {
        chatId: DESKTOP_CHAT_ID,
      });
    } catch {
      if (bootProbes.attachments !== "succeeded") bootProbes.attachments = "failed";
      if (reportError && attachmentSurfaceIsCurrent(generation, revision)) {
        attachmentError = CHAT_ATTACHMENT_FAILURE_COPY;
        render();
      }
      return false;
    }
    if (!attachmentSurfaceIsCurrent(generation, revision)) return true;
    attachmentSurface = surface;
    attachmentError = null;
    bootProbes.attachments = "succeeded";
    render();
    return true;
  };

  const replacePlanningRequest = (delivery: PlanningRequestDelivery): void => {
    planningRequests = [
      ...planningRequests.filter((item) => item.requestId !== delivery.requestId),
      delivery,
    ].sort(
      (left, right) =>
        left.createdAtMs - right.createdAtMs || left.requestId.localeCompare(right.requestId),
    );
  };

  const loadPlanningRequests = async (client?: DesktopCoachClient): Promise<void> => {
    const activeClient = client ?? (await input.clients.getClient());
    const result = await activeClient.call("listPlanningRequests", { chatId: DESKTOP_CHAT_ID });
    if (disposed) return;
    planningRequests = result.deliveries;
    installPlanCreation(result.planCreation);
    planCreationLoaded = true;
    planningRequestsLoaded = true;
    planningRequestError = null;
    render();
  };

  const installPlanCreation = (
    next: PlanCreationCardModel | null,
    focusTarget?: "discard" | "activate" | "edit" | "start" | "continue" | "change" | "composer",
  ): void => {
    const previous = planCreation;
    let actionFocusRequested = false;
    const requestActionFocus = (
      target: "discard" | "activate" | "edit" | "start" | "continue" | "change" | "composer",
    ): void => {
      requestPlanCreationFocus(target);
      actionFocusRequested = true;
    };
    if (focusTarget !== undefined) requestActionFocus(focusTarget);
    let installed = false;
    if (next === null) {
      planCreation = null;
      planCreationActivateConfirmationOpen = false;
      installed = true;
      if (planCreationDiscardConfirmationOpen) {
        planCreationDiscardConfirmationOpen = false;
        planCreationNotice = CHAT_PLAN_CREATION_DISCARD_MISSING_COPY;
        if (!actionFocusRequested) requestActionFocus("start");
      }
    } else if (
      planCreation === null ||
      next.creationId !== planCreation.creationId ||
      next.version >= planCreation.version
    ) {
      planCreation = next;
      installed = true;
    }
    if (installed) {
      const modelIdentityChanged =
        previous?.creationId !== planCreation?.creationId ||
        previous?.version !== planCreation?.version;
      const editedAnswerRemoved =
        planCreationEditingKey !== null &&
        planCreation?.answeredSummaries.some(
          (summary) => summary.answerKey === planCreationEditingKey,
        ) !== true;
      const resetInteraction = modelIdentityChanged || editedAnswerRemoved;
      if (!resetInteraction) return;
      planCreationEditingKey = null;
      planCreationEditReturnPaused = false;
      const pausedIdentity = readPlanCreationPause();
      if (planCreation === null) {
        planCreationPaused = false;
        clearPlanCreationPause();
      } else if (
        pausedIdentity?.creationId === planCreation.creationId &&
        (planCreation.openQuestion === null
          ? null
          : planCreationQuestionKey(planCreation.openQuestion)) === pausedIdentity.answerKey
      ) {
        planCreationPaused = true;
      } else {
        planCreationPaused = false;
        clearPlanCreationPause();
      }
      if (!actionFocusRequested) planCreationFocusRevision += 1;
    }
  };
  const latestMessageId = (): string | null =>
    mergeHydratedMessages(hydration.turns, state.messages, hydration.entries)
      .filter((message) => message.role === "athlete" || message.text.length > 0)
      .at(-1)?.id ?? null;
  const requestPlanCreationFocus = (
    target: "discard" | "activate" | "edit" | "start" | "continue" | "change" | "composer",
  ): void => {
    planCreationFocusRequest = {
      ...(target === "start" || planCreationFocusRequest?.libraryTarget === undefined
        ? {}
        : { libraryTarget: planCreationFocusRequest.libraryTarget }),
      target,
      revision: ++planCreationActionFocusRevision,
    };
  };
  const planCreationDiscardNotice = planCreationDiscardNoticeCopy;
  const trackPlanningRequestLoad = (task: Promise<void>): Promise<void> => {
    planningRequestLoadTask = task;
    void task.then(
      () => {
        if (planningRequestLoadTask === task) {
          planningRequestLoadTask = undefined;
          scheduleDrainIfEligible();
        }
      },
      () => {
        if (planningRequestLoadTask === task) {
          planningRequestLoadTask = undefined;
          scheduleDrainIfEligible();
        }
      },
    );
    return task;
  };
  const waitForPlanningRequestLoad = async (): Promise<void> => {
    while (planningRequestLoadTask !== undefined) await planningRequestLoadTask;
  };
  const planCommandId = (key: string): string => {
    if (pendingPlanCreationCommand?.key !== key) {
      pendingPlanCreationCommand = { key, id: globalThis.crypto.randomUUID() };
    }
    return pendingPlanCreationCommand.id;
  };

  const recoverPlanningRequests = async (client?: DesktopCoachClient): Promise<void> => {
    const activeClient = client ?? (await input.clients.getClient());
    let recoveryFailed = false;
    try {
      await activeClient.call("resumePlanningRequests", {});
    } catch {
      recoveryFailed = true;
    }
    await loadPlanningRequests(activeClient);
    if (recoveryFailed) throw new Error("Planning request recovery failed.");
    bootProbes.planningRequests = "succeeded";
  };

  const runPlanningRecovery = (client?: DesktopCoachClient): Promise<void> =>
    trackPlanningRequestLoad(
      recoverPlanningRequests(client).catch(() => {
        bootProbes.planningRequests = "failed";
        if (!disposed) {
          planningRequestsLoaded = false;
          planningRequestError = CHAT_PLANNING_REQUEST_LOAD_FAILURE_COPY;
          render();
        }
      }),
    );

  const runSessionProbe = async (client?: DesktopCoachClient): Promise<void> => {
    const probeEpoch = epoch;
    try {
      const activeClient = client ?? (await input.clients.getClient());
      const result = await activeClient.call("hasSession", { chatId: DESKTOP_CHAT_ID });
      if (disposed || epoch !== probeEpoch) return;
      bootProbes.session = "succeeded";
      reduce({ type: "session-probe", hasSession: result.hasSession });
    } catch {
      if (bootProbes.session !== "succeeded") bootProbes.session = "failed";
    }
  };

  const routeToPlanningRequest = (requestId: string): void => {
    const delivery = planningRequests.find((item) => item.requestId === requestId);
    if (delivery?.state !== "delivered") return;
    input.openPlanningRequest?.(DESKTOP_CHAT_ID, requestId);
  };

  const retrySavedPlanningRequest = (requestId: string): void => {
    const delivery = planningRequests.find((item) => item.requestId === requestId);
    if (
      disposed ||
      planningRequestBusyId !== null ||
      delivery?.state !== "failed" ||
      !delivery.retryable
    ) {
      return;
    }
    planningRequestBusyId = requestId;
    planningRequestError = null;
    render();
    void input.clients
      .getClient()
      .then((client) => client.call("retryPlanningRequest", { requestId }))
      .then((result) => {
        if (disposed) return;
        planningRequestBusyId = null;
        if (result.status === "missing") {
          planningRequestError = CHAT_PLANNING_REQUEST_FAILURE_COPY;
          render();
          return;
        }
        replacePlanningRequest(result.delivery);
        planningRequestError = null;
        render();
        routeToPlanningRequest(requestId);
      })
      .catch(() => {
        if (disposed) return;
        planningRequestBusyId = null;
        planningRequestError = CHAT_PLANNING_REQUEST_FAILURE_COPY;
        render();
      });
  };

  const deliverWorkoutPlanningRequest = (request: CreateWorkoutPlanningRequestRpcParams): void => {
    if (disposed || planningRequestBusyId !== null) return;
    pendingPlanningRequestCreate = { kind: "workout", request };
    planningRequestBusyId = request.requestId;
    planningRequestError = null;
    render();
    void input.clients
      .getClient()
      .then((client) => client.call("createWorkoutPlanningRequest", request))
      .then((result) => {
        if (disposed) return;
        planningRequestBusyId = null;
        if (result.status === "rejected") {
          pendingPlanningRequestCreate = null;
          planningRequestError = CHAT_PLANNING_REQUEST_FAILURE_COPY;
          render();
          return;
        }
        pendingPlanningRequestCreate = null;
        replacePlanningRequest(result.delivery);
        planningRequestError = null;
        render();
        routeToPlanningRequest(request.requestId);
      })
      .catch(() => {
        if (disposed) return;
        planningRequestBusyId = null;
        planningRequestError = CHAT_PLANNING_REQUEST_FAILURE_COPY;
        render();
      });
  };

  const deliverPlanningRequest = (request: CreatePlanningRequestRpcParams): void => {
    if (disposed || planningRequestBusyId !== null) return;
    pendingPlanningRequestCreate = { kind: "generic", request };
    planningRequestBusyId = request.payload.requestId;
    planningRequestError = null;
    render();
    void input.clients
      .getClient()
      .then((client) => client.call("createPlanningRequest", request))
      .then((result) => {
        if (disposed) return;
        planningRequestBusyId = null;
        if (result.status === "rejected") {
          pendingPlanningRequestCreate = null;
          planningRequestError = CHAT_PLANNING_REQUEST_FAILURE_COPY;
          render();
          return;
        }
        pendingPlanningRequestCreate = null;
        replacePlanningRequest(result.delivery);
        planningRequestError = null;
        render();
        routeToPlanningRequest(request.payload.requestId);
      })
      .catch(() => {
        if (disposed) return;
        planningRequestBusyId = null;
        planningRequestError = CHAT_PLANNING_REQUEST_FAILURE_COPY;
        render();
      });
  };

  const receiveAdmissions = (
    results: readonly AttachmentAdmissionReadModel[],
    generation = attachmentGeneration,
  ): void => {
    if (!attachmentGenerationIsCurrent(generation)) return;
    attachmentAdmissions = results.filter((result) => result.status !== "accepted");
    attachmentError = null;
    render();
    void refreshAttachments(undefined, generation);
  };

  const runNativeAttachmentAction = async (
    operation: (() => Promise<readonly AttachmentAdmissionReadModel[]>) | undefined,
  ): Promise<void> => {
    if (operation === undefined || attachmentBusyTokens.size > 0) return;
    const ownership = beginAttachmentWrite(true);
    if (ownership === null) return;
    attachmentError = null;
    render();
    try {
      const results = await operation();
      if (attachmentGenerationIsCurrent(ownership.generation)) {
        receiveAdmissions(results, ownership.generation);
      }
    } catch {
      if (attachmentGenerationIsCurrent(ownership.generation)) {
        attachmentError = CHAT_ATTACHMENT_FAILURE_COPY;
      }
    } finally {
      finishAttachmentWrite(ownership.token);
    }
  };

  const mutateAttachment = async (
    operation: (client: DesktopCoachClient) => Promise<ChatAttachmentComposerReadModel>,
  ): Promise<void> => {
    if (attachmentBusyTokens.size > 0) return;
    const ownership = beginAttachmentWrite(true);
    if (ownership === null) return;
    let revision = attachmentSurfaceRevision;
    attachmentError = null;
    render();
    try {
      const client = await input.clients.getClient();
      revision = claimAttachmentSurface();
      const surface = await operation(client);
      if (attachmentSurfaceIsCurrent(ownership.generation, revision)) {
        attachmentSurface = surface;
        attachmentError = null;
      }
    } catch {
      if (attachmentSurfaceIsCurrent(ownership.generation, revision)) {
        attachmentError = CHAT_ATTACHMENT_FAILURE_COPY;
      }
    } finally {
      finishAttachmentWrite(ownership.token);
    }
  };

  const continueDecision = (
    method: "answerCoachDecision" | "resumeCoachDecision",
    currentDecision: CoachDecisionReadModel,
    answer: CoachDecisionAnswer | undefined,
  ): Promise<void> => {
    if (decisionActionTask !== undefined) return decisionActionTask;
    if (disposed || resetBlocksWork() || state.status === "streaming") {
      return Promise.resolve();
    }
    const requestKey = Number(nextId("request").slice("request-".length));
    const userMessageId = nextId("message");
    const assistantMessageId = nextId("message");
    const restoreCompletedContinuation = (
      completed: Extract<CoachDecisionReadModel, { status: "answered" }> & {
        readonly continuation: Extract<
          Extract<CoachDecisionReadModel, { status: "answered" }>["continuation"],
          { status: "completed" }
        >;
      },
    ): void => {
      if (
        state.messages.some(
          (message) => message.role === "coach" && message.turnId === completed.continuation.turnId,
        )
      ) {
        return;
      }
      reduce({
        type: "submit",
        requestKey,
        occurredAtMs: now(),
        userMessage: "",
        userMessageId,
        assistantMessageId,
        includeUser: false,
      });
      reduce({
        type: "bind-turn",
        requestKey,
        turnId: completed.continuation.turnId,
      });
      reduce({
        type: "event",
        requestKey,
        event: {
          type: "final-text",
          turnId: completed.continuation.turnId,
          text: completed.continuation.coachText,
        },
      });
      reduce({ type: "complete", requestKey });
    };
    decisionPhase = method === "resumeCoachDecision" ? "recovering" : "continuing";
    decisionAnswerLabel =
      answer === undefined
        ? currentDecision.status === "answered"
          ? answerLabel(currentDecision, currentDecision.answer)
          : "Saved choice"
        : answerLabel(currentDecision, answer);
    decisionError = null;
    reduce({
      type: "submit",
      requestKey,
      occurredAtMs: now(),
      userMessage: "",
      userMessageId,
      assistantMessageId,
      includeUser: false,
    });
    let task!: Promise<void>;
    task = (async () => {
      let client: DesktopCoachClient | undefined;
      let boundRequestId: string | number | undefined;
      let boundTurnId: string | undefined;
      let pendingEnvelope: CoachTurnEventNotificationEnvelope | undefined;
      let terminal: CoachClientTerminalEnvelope | undefined;
      let finalText: string | undefined;
      let interruptedText: string | undefined;
      let eventCount = 0;
      let startSeen = false;
      let protocolFault = false;
      const callAbortController = new AbortController();
      let stopRequested = false;
      let stopTask: Promise<void> | undefined;
      const current = (): boolean =>
        !disposed &&
        state.activeTurn?.requestKey === requestKey &&
        decision?.decisionId === currentDecision.decisionId;
      const failProtocol = (): void => {
        if (protocolFault) return;
        protocolFault = true;
        callAbortController.abort();
      };
      const requestStop = (): void => {
        stopRequested = true;
        if (client === undefined || boundTurnId === undefined || stopTask !== undefined) return;
        const stopClient = client;
        const stopTurnId = boundTurnId;
        stopTask = reportBestEffortAsync("desktop-chat-stop-chat-failed", () =>
          stopClient.call("stopChat", { chatId: DESKTOP_CHAT_ID, turnId: stopTurnId }),
        );
      };
      activeStopRequest = { requestKey, request: requestStop };
      const callOptions = {
        signal: callAbortController.signal,
        onNotificationEnvelope(envelope) {
          if (!current() || protocolFault) return;
          if (
            envelope.method !== "coach.turnEvent" ||
            envelope.params.requestMethod !== method ||
            envelope.params.turnId.length === 0
          ) {
            failProtocol();
            return;
          }
          if (boundRequestId === undefined) {
            boundRequestId = envelope.params.requestId;
            boundTurnId = envelope.params.turnId;
            reduce({ type: "bind-turn", requestKey, turnId: boundTurnId });
            if (stopRequested) requestStop();
          } else if (
            envelope.params.requestId !== boundRequestId ||
            envelope.params.turnId !== boundTurnId
          ) {
            failProtocol();
            return;
          }
          pendingEnvelope = envelope;
        },
        onEvent(event) {
          if (!current() || protocolFault) return;
          const envelope = pendingEnvelope;
          pendingEnvelope = undefined;
          if (
            envelope === undefined ||
            boundTurnId === undefined ||
            event.turnId !== boundTurnId ||
            envelope.params.event.turnId !== boundTurnId ||
            event.type === "decision-requested"
          ) {
            failProtocol();
            return;
          }
          if (eventCount >= COACH_TURN_EVENT_LIMIT) {
            failProtocol();
            return;
          }
          eventCount += 1;
          if (event.type === "turn-start") {
            if (eventCount !== 1 || startSeen || event.chatId !== DESKTOP_CHAT_ID) {
              failProtocol();
              return;
            }
            startSeen = true;
          } else if (!startSeen) {
            failProtocol();
            return;
          }
          if (event.type === "text_delta") {
            const previousTextLength = state.activeTurn?.draft.length ?? 0;
            if (event.delta.length > COACH_RESPONSE_CODE_UNIT_LIMIT - previousTextLength) {
              failProtocol();
              return;
            }
          }
          if (
            (event.type === "final-text" || event.type === "interrupted") &&
            event.text.length > COACH_RESPONSE_CODE_UNIT_LIMIT
          ) {
            failProtocol();
            return;
          }
          if (event.type === "final-text") finalText = event.text;
          if (event.type === "interrupted") interruptedText = event.text;
          reduce({ type: "event", requestKey, event });
        },
        onTerminalEnvelope(envelope) {
          if (current()) terminal = envelope;
        },
      } satisfies CoachClientCallOptions<"answerCoachDecision">;
      try {
        client = await input.clients.getClient();
        if (!current()) return;
        const result =
          method === "answerCoachDecision"
            ? await client.call(
                "answerCoachDecision",
                {
                  chatId: DESKTOP_CHAT_ID,
                  decisionId: currentDecision.decisionId,
                  answer: answer as CoachDecisionAnswer,
                },
                callOptions,
              )
            : await client.call(
                "resumeCoachDecision",
                { chatId: DESKTOP_CHAT_ID, decisionId: currentDecision.decisionId },
                callOptions,
              );
        if (!current()) return;
        if (protocolFault || terminal === undefined || !("result" in terminal)) {
          throw new CoachClientProtocolError();
        }
        decision = result.decision;
        if (interruptedText !== undefined) {
          if (
            finalText !== undefined ||
            result.decision.status !== "answered" ||
            result.decision.continuation.status !== "pending"
          ) {
            throw new CoachClientProtocolError();
          }
          decisionPhase = "recovering";
          decisionError = CHAT_RESPONSE_STOPPED_COPY;
          return;
        }
        if (
          result.decision.status === "answered" &&
          result.decision.continuation.status === "completed"
        ) {
          if (
            finalText === undefined ||
            result.decision.continuation.coachText !== finalText ||
            result.decision.continuation.turnId !== boundTurnId
          ) {
            throw new CoachClientProtocolError();
          }
          reduce({ type: "complete", requestKey });
          decisionPhase = "idle";
          decisionError = null;
          return;
        }
        reduce({ type: "discard", requestKey });
        decisionPhase = "recovering";
        decisionError = CHAT_DECISION_FAILURE_COPY;
      } catch {
        if (!current()) return;
        reduce({ type: "discard", requestKey });
        decisionPhase = "recovering";
        decisionError = CHAT_DECISION_FAILURE_COPY;
        try {
          const refreshed = await refreshDecision(client);
          if (refreshed?.status === "answered" && refreshed.continuation.status === "pending") {
            decisionError = CHAT_DECISION_FAILURE_COPY;
            render();
          } else if (
            refreshed?.status === "answered" &&
            refreshed.continuation.status === "completed"
          ) {
            restoreCompletedContinuation({
              ...refreshed,
              continuation: refreshed.continuation,
            });
            decisionPhase = "idle";
            decisionError = null;
            render();
          } else if (refreshed?.status === "unanswered") {
            decisionPhase = "idle";
            decisionError = CHAT_DECISION_FAILURE_COPY;
            render();
          }
        } catch {
          render();
        }
      } finally {
        if (activeStopRequest?.requestKey === requestKey) activeStopRequest = undefined;
        void reportBestEffortAsync("desktop-chat-refresh-spend-failed", () => input.refreshSpend());
        await reportBestEffortAsync("desktop-chat-refresh-training-context-failed", () =>
          input.refreshTrainingContext(),
        );
        if (decisionActionTask === task) decisionActionTask = undefined;
        if (activeTask === task) activeTask = undefined;
        render();
      }
    })();
    decisionActionTask = task;
    activeTask = task;
    render();
    return task;
  };

  function canDrainState(allowInterrupted = false): boolean {
    if (
      !canChat() ||
      !queueLoaded ||
      disposed ||
      resetBlocksWork() ||
      resetTask !== undefined ||
      decisionBlocksWork() ||
      planCreationBlocksWork() ||
      planCreationBusy ||
      planningRequestLoadTask !== undefined ||
      decisionLoadTask !== undefined ||
      queueMutationCount > 0 ||
      activeTask !== undefined ||
      decisionActionTask !== undefined
    ) {
      return false;
    }
    if (state.status === "streaming") return false;
    if (state.status === "interrupted" && !allowInterrupted) return false;
    if (state.retryRequired != null) return false;
    const head = state.queued[0];
    if (head === undefined) return false;
    if (head.command && head.restored === true) return false;
    if (head.id === stalledDrainHeadId) return false;
    return true;
  }

  const drain = (allowInterrupted = false): Promise<void> => {
    if (activeDrainTask !== undefined) return activeDrainTask;
    let task!: Promise<void>;
    task = (async () => {
      try {
        let allow = allowInterrupted;
        while (true) {
          await waitForPlanningRequestLoad();
          if (!canDrainState(allow)) return;
          const group = nextDrainGroup(state);
          if (group === null) return;
          const queuedIds = state.queued.slice(0, group.size).map((item) => item.id);
          const attachments = queuedIds
            .flatMap((id) => state.queued.find((message) => message.id === id)?.attachmentIds ?? [])
            .map((id) => attachmentSummaries.get(id))
            .filter((attachment): attachment is ChatSentAttachment => attachment !== undefined);
          const chatRun = run(
            group.text,
            true,
            false,
            { method: "resumeChatQueue", queuedMessageIds: queuedIds },
            attachments,
          );
          await chatRun.task;
          allow = chatRun.allowInterruptedDrain();
        }
      } finally {
        if (activeDrainTask === task) activeDrainTask = undefined;
      }
    })();
    activeDrainTask = task;
    return task;
  };

  function scheduleDrainIfEligible(allowInterrupted = false): void {
    if (!initialized || activeDrainTask !== undefined || !canDrainState(allowInterrupted)) return;
    void drain(allowInterrupted);
  }

  const start = (): Promise<void> => {
    if (!canChat() || disposed) return Promise.resolve();
    if (probeTask !== undefined) return probeTask;
    const tasks: Promise<void>[] = [];
    if (hydration.status === "idle") {
      tasks.push(hydrator.start());
    } else if (hydration.status === "failed") {
      tasks.push(hydrator.retry());
    }
    if (bootProbes.decision !== "succeeded") {
      decisionLoaded = false;
      decisionLoadError = null;
      render();
      const loadTask = (async () => {
        try {
          const loaded = await refreshDecision();
          if (
            loaded?.status === "answered" &&
            loaded.continuation.status === "pending" &&
            decisionActionTask === undefined
          ) {
            await continueDecision("resumeCoachDecision", loaded, undefined);
          }
        } catch {
          bootProbes.decision = "failed";
          decisionLoaded = false;
          decisionLoadError = CHAT_DECISION_LOAD_FAILURE_COPY;
          decisionPhase = "idle";
          render();
        }
      })();
      decisionLoadTask = loadTask;
      void loadTask.finally(() => {
        if (decisionLoadTask === loadTask) decisionLoadTask = undefined;
        render();
      });
      tasks.push(loadTask);
    }
    if (bootProbes.session !== "succeeded") {
      tasks.push(runSessionProbe());
    }
    if (bootProbes.queue !== "succeeded") {
      const queueLoadTask = (async () => {
        try {
          await refreshQueue();
        } catch {
          bootProbes.queue = "failed";
          queueLoaded = false;
          queueLoadError = CHAT_QUEUE_LOAD_FAILURE_COPY;
          render();
        }
      })();
      tasks.push(queueLoadTask);
    }
    if (bootProbes.attachments !== "succeeded") {
      const attachmentLoadGeneration = attachmentGeneration;
      tasks.push(refreshAttachments(undefined, attachmentLoadGeneration).then(() => undefined));
    }
    if (bootProbes.planningRequests !== "succeeded") {
      tasks.push(runPlanningRecovery());
    }
    if (tasks.length === 0) return drain();
    const task = Promise.all(tasks)
      .then(() => drain())
      .finally(() => {
        if (probeTask === task) probeTask = undefined;
      });
    probeTask = task;
    return task;
  };

  let implicitPlanChangeRouting = true;
  const readChange = (): PlanChangeSurfaceState =>
    input.readPlanChange?.() ?? EMPTY_PLAN_CHANGE_SURFACE;
  const publishChange = (patch: Partial<PlanChangeSurfaceState>): void => {
    if (!disposed) input.publishPlanChange?.({ ...readChange(), ...patch });
  };
  const routesTextToPlanChange = (): boolean => {
    const library = input.readPlanLibrary?.();
    const surface = readChange();
    return Boolean(
      library?.active &&
      ((surface.textRouting && surface.planId === library.active.planId) ||
        (implicitPlanChangeRouting &&
          library.changes.some(
            (change) => change.status === "pending" && change.planId === library.active?.planId,
          ))),
    );
  };
  const pendingChangeCheck = () =>
    planChangePendingCheck(readChange(), input.readPlanLibrary?.() ?? null);
  const changesPaused = () => input.readPlanLibrary?.()?.changesPaused != null;
  const changeFocus = (target: "editor" | "preview" | "change" | "check") => ({
    target,
    revision: (readChange().focusRequest?.revision ?? 0) + 1,
  });

  render();
  initialized = true;
  const clearSubmittedDraftError = (submittedTextRevision: number): void => {
    if (submittedTextRevision === attachmentTextRevision) draftError = null;
  };
  function saveAttachmentDraftText(text: string): void {
    const ownership = beginAttachmentWrite(false);
    if (ownership === null) return;
    const textRevision = ++attachmentTextRevision;
    let surfaceRevision = attachmentSurfaceRevision;
    const task = attachmentTextSaveTask
      .then(async () => {
        try {
          const client = await input.clients.getClient();
          surfaceRevision = claimAttachmentSurface();
          const surface = await client.call("saveChatAttachmentDraftText", {
            chatId: DESKTOP_CHAT_ID,
            text,
          });
          if (
            !attachmentSurfaceIsCurrent(ownership.generation, surfaceRevision) ||
            textRevision !== attachmentTextRevision
          ) {
            return;
          }
          attachmentSurface = surface;
          draftError = null;
          render();
        } catch {
          if (
            !attachmentSurfaceIsCurrent(ownership.generation, surfaceRevision) ||
            textRevision !== attachmentTextRevision
          ) {
            return;
          }
          draftError = CHAT_DRAFT_SAVE_FAILURE_COPY;
          render();
        }
      })
      .finally(() => {
        finishAttachmentWrite(ownership.token);
      });
    attachmentTextSaveTask = task;
  }

  async function answerPlanCreation(answer: PlanCreationAnswerInput): Promise<void> {
    if (
      disposed ||
      planCreationBusy ||
      planCreationDiscardConfirmationOpen ||
      planCreationActivateConfirmationOpen ||
      planCreation === null ||
      (!(
        !planCreationPaused &&
        (planCreationEditingKey !== null || planCreation.openQuestion !== null)
      ) &&
        !(
          planCreation.pendingCheck !== null &&
          (answer.kind === "check-action" || answer.kind === "check-submit")
        ) &&
        !(
          planCreation.pendingCommitment !== null &&
          (answer.kind === "commitments" ||
            answer.kind === "commitments-confirm" ||
            answer.kind === "commitments-cancel")
        ))
    )
      return;
    const key = JSON.stringify({
      creationId: planCreation.creationId,
      expectedVersion: planCreation.version,
      answer,
    });
    const submittedEditingKey = planCreationEditingKey;
    const submittedEditReturnPaused = planCreationEditReturnPaused;
    planCreationBusy = true;
    planCreationError = null;
    planCreationNotice = null;
    render();
    try {
      const result = await (
        await input.clients.getClient()
      ).call(
        "plan_creation.answer",
        {
          commandId: planCommandId(key),
          creationId: planCreation.creationId,
          expectedVersion: planCreation.version,
          answer,
        },
        {
          onEvent(event) {
            if (disposed || event.type !== "answer-check") return;
            installPlanCreation(event.planCreation);
            if (event.planCreation.pendingCheck !== null) planCreationEditingKey = null;
            render();
          },
        },
      );
      if (disposed) return;
      pendingPlanCreationCommand = null;
      installPlanCreation(result.planCreation);
      if (result.planCreation?.pendingCheck != null) planCreationEditingKey = null;
      if (
        result.status !== "rejected" &&
        (answer.kind === "commitments-confirm" ||
          answer.kind === "commitments-cancel" ||
          answer.kind === "check-action") &&
        planCreation?.pendingCheck === null &&
        planCreation.pendingCommitment === null &&
        planCreation.openQuestion === null
      )
        requestPlanCreationFocus("composer");
      if (result.status === "rejected") {
        if (
          submittedEditingKey !== null &&
          planCreation?.answeredSummaries.some(
            (summary) => summary.answerKey === submittedEditingKey,
          ) === true
        ) {
          planCreationEditingKey = submittedEditingKey;
          planCreationEditReturnPaused = submittedEditReturnPaused;
          planCreationPaused = false;
        }
        planCreationError = CHAT_PLAN_CREATION_FAILURE_COPY;
      }
    } catch {
      if (disposed) return;
      planCreationError = CHAT_PLAN_CREATION_FAILURE_COPY;
    } finally {
      if (!disposed) {
        planCreationBusy = false;
        render();
      }
    }
  }

  const controller: ChatController = {
    requestPlanLibraryFocus(target) {
      if (disposed) return;
      planCreationFocusRequest = {
        target,
        libraryTarget: target,
        revision: ++planCreationActionFocusRevision,
      };
      render();
    },
    openPlanChangeEditor() {
      const active = input.readPlanLibrary?.()?.active;
      if (
        disposed ||
        readChange().busy ||
        !active ||
        changesPaused() ||
        pendingChangeCheck() != null
      )
        return;
      publishChange({
        open: true,
        textRouting: true,
        planId: active.planId,
        editorOpen: true,
        error: null,
        focusRequest: changeFocus("editor"),
      });
    },
    backFromPlanChangeEditor() {
      if (disposed || readChange().busy) return;
      implicitPlanChangeRouting = false;
      publishChange({
        open: false,
        textRouting: false,
        editorOpen: false,
        error: null,
        focusRequest: changeFocus("change"),
      });
    },
    async previewPlanChange(intent) {
      const library = input.readPlanLibrary?.();
      const active = library?.active;
      if (disposed || readChange().busy || !active || changesPaused()) return;
      if (
        pendingChangeCheck() != null &&
        intent.kind !== "check-action" &&
        !(intent.kind === "text" && readChange().checkEditing === true)
      )
        return;
      const parameterCopy = planChangeParameterCopy(intent);
      const parsedIntent =
        intent.kind === "text" || intent.kind === "check-action"
          ? PlanChangeRequestSchema.safeParse(intent)
          : PlanChangeIntentSchema.safeParse(intent);
      if (!parsedIntent.success) {
        publishChange({ error: parameterCopy });
        return;
      }
      if (
        previewAttempt?.planId !== active.planId ||
        JSON.stringify(
          "request" in previewAttempt ? previewAttempt.request : previewAttempt.intent,
        ) !== JSON.stringify(parsedIntent.data)
      ) {
        previewAttempt = {
          commandId: globalThis.crypto.randomUUID(),
          planId: active.planId,
          expectedVersion: active.version,
          ...(parsedIntent.data.kind === "text" ||
          parsedIntent.data.kind === "check-action" ||
          parsedIntent.data.kind === "intent"
            ? { request: parsedIntent.data }
            : { intent: parsedIntent.data }),
        };
      }
      const previewEpoch = epoch;
      publishChange({
        busy: true,
        textRouting: true,
        planId: active.planId,
        error: null,
        notice: null,
      });
      try {
        const result = await previewPlanChange(input.clients, previewAttempt, {
          onEvent(event) {
            if (
              disposed ||
              epoch !== previewEpoch ||
              event.type !== "answer-check" ||
              event.planId !== active.planId
            )
              return;
            publishChange({
              pendingCheck: event.pendingCheck,
              checkEditing: false,
              editorOpen: false,
            });
          },
        });
        if (disposed || epoch !== previewEpoch) return;
        previewAttempt = null;
        if (result.status === "rejected") {
          if (result.reason === "unsupported-request") {
            publishChange({ editorOpen: false, error: null, notice: result.explanation });
            return;
          }
          if (result.reason === "sync-stale") {
            publishChange({ editorOpen: false, error: null, notice: PLAN_CHANGES_PAUSED_NOTICE });
            await refreshPlanLibraryBestEffort();
            return;
          }
          if (result.reason === "race-window") {
            publishChange({
              notice:
                "Only training reductions are allowed during this race window. Training is unchanged.",
            });
            await refreshPlanLibraryBestEffort();
            return;
          }
          if (result.reason === "invalid-intent" && parsedIntent.data.kind === "inverse") {
            publishChange({ notice: "The latest Change is no longer eligible for Undo." });
            await refreshPlanLibraryBestEffort();
            return;
          }
          const rejectionCopy =
            result.reason === "stale-version"
              ? "This request used an older Plan revision. Request a fresh preview."
              : result.reason === "invalid-intent"
                ? (result.explanation ?? result.message ?? parameterCopy)
                : "This Change could not be previewed. Training is unchanged.";
          publishChange(
            parsedIntent.data.kind === "text"
              ? { editorOpen: false, error: null, notice: rejectionCopy }
              : { error: rejectionCopy },
          );
          if (result.reason === "stale-version") {
            await refreshPlanLibraryBestEffort();
          }
          return;
        }
        if (result.status === "checked") {
          publishChange({
            open: true,
            planId: active.planId,
            editorOpen: false,
            checkEditing: false,
            pendingCheck: result.pendingCheck,
            error: null,
            notice: null,
            focusRequest: changeFocus("check"),
          });
          await refreshPlanLibraryBestEffort();
          if (disposed || epoch !== previewEpoch) return;
          if (result.pendingCheck === null) requestPlanCreationFocus("composer");
          render();
          return;
        }
        publishChange({ pendingCheck: null, checkEditing: false });
        const superseded = library.changes.find(
          (change) => change.changeId === result.change.supersedes,
        );
        publishChange({
          open: true,
          planId: active.planId,
          editorOpen: false,
          notice: superseded
            ? `This preview supersedes “${superseded.title}”. Training is unchanged until confirmation.`
            : "Review the exact changes before confirming.",
        });
        await refreshPlanLibraryBestEffort();
        if (disposed || epoch !== previewEpoch) return;
        publishChange({ focusRequest: changeFocus("preview") });
      } catch (error) {
        if (disposed || epoch !== previewEpoch) return;
        publishChange({
          error:
            error instanceof CoachRpcRemoteError && parsedIntent.data.kind === "ftp"
              ? error.message
              : "The preview result could not be confirmed. The Plan library will show the current state after refresh.",
        });
        await refreshPlanLibraryBestEffort();
      } finally {
        if (!disposed && epoch === previewEpoch) publishChange({ busy: false });
      }
    },
    async applyPlanChange(decision) {
      const library = input.readPlanLibrary?.();
      const active = library?.active;
      if (
        disposed ||
        readChange().busy ||
        !active ||
        pendingChangeCheck() != null ||
        (decision === "apply" && changesPaused())
      )
        return;
      const pending = library.changes.find((change) => change.status === "pending");
      const retry =
        applyAttempt?.decision === decision &&
        applyAttempt.planId === active.planId &&
        (!pending || pending.changeId === applyAttempt.changeId)
          ? applyAttempt
          : null;
      if (!pending && retry === null) {
        publishChange({ notice: "This preview is no longer pending. Training is unchanged." });
        return;
      }
      if (retry !== null) applyAttempt = retry;
      else if (pending) {
        applyAttempt = {
          commandId: globalThis.crypto.randomUUID(),
          planId: active.planId,
          changeId: pending.changeId,
          expectedVersion: active.version,
          decision,
        };
      }
      if (applyAttempt === null) return;
      const attempt = applyAttempt;
      const applyEpoch = epoch;
      publishChange({ busy: true, error: null, notice: null });
      try {
        const result = await applyPlanChange(input.clients, attempt);
        if (disposed || epoch !== applyEpoch) return;
        if (applyAttempt === attempt) applyAttempt = null;
        if (result.status === "rejected") {
          if (result.reason === "sync-stale") {
            publishChange({ editorOpen: false, error: null, notice: PLAN_CHANGES_PAUSED_NOTICE });
            await refreshPlanLibraryBestEffort();
            return;
          }
          publishChange({ notice: planChangeApplyRejectionCopy(result.reason) });
          if (
            result.reason === "stale-version" ||
            result.reason === "not-pending" ||
            result.reason === "race-window" ||
            result.reason === "ftp-sources-changed" ||
            result.reason === "event-source-changed" ||
            result.reason === "day-changed" ||
            result.reason === "not-eligible"
          ) {
            await refreshPlanLibraryBestEffort();
          }
          return;
        }
        publishChange({
          open: true,
          planId: active.planId,
          editorOpen: false,
          notice:
            result.status === "applied"
              ? "Change applied locally. Training now matches the confirmed preview."
              : "Change cancelled. Training is unchanged; the preview remains in history.",
        });
        await refreshPlanLibraryBestEffort();
        if (disposed || epoch !== applyEpoch) return;
        implicitPlanChangeRouting = true;
        publishChange({ textRouting: false, focusRequest: changeFocus("change") });
      } catch {
        if (disposed || epoch !== applyEpoch) return;
        publishChange({
          notice:
            "The Change result could not be confirmed. The Plan library will show the current state after refresh.",
        });
        await refreshPlanLibraryBestEffort();
      } finally {
        if (!disposed && epoch === applyEpoch) publishChange({ busy: false });
      }
    },
    start() {
      return start();
    },
    resume() {
      stalledDrainHeadId = null;
      return start().then(() => drain());
    },
    async refreshAttachments() {
      if (disposed || resetBlocksWork()) return;
      const generation = attachmentGeneration;
      await refreshAttachments(undefined, generation);
    },
    beginDroppedAttachmentAdmission(operationId) {
      if (droppedAttachmentAdmissions.has(operationId) || attachmentBusyTokens.size > 0) {
        return false;
      }
      const ownership = beginAttachmentWrite(true);
      if (ownership === null) return false;
      const timer = globalThis.setTimeout(() => {
        releaseDroppedAttachmentAdmission(operationId);
      }, DROPPED_ATTACHMENT_ADMISSION_TIMEOUT_MS);
      droppedAttachmentAdmissions.set(operationId, { ...ownership, timer });
      return true;
    },
    settleDroppedAttachmentAdmission(operationId, results) {
      const ownership = droppedAttachmentAdmissions.get(operationId);
      if (ownership === undefined) return;
      droppedAttachmentAdmissions.delete(operationId);
      globalThis.clearTimeout(ownership.timer);
      if (results !== null && attachmentGenerationIsCurrent(ownership.generation)) {
        receiveAdmissions(results, ownership.generation);
      }
      finishAttachmentWrite(ownership.token);
    },
    async submit(message, attachmentIds = []) {
      const submittedTextRevision = attachmentTextRevision;
      const submittedAttachmentGeneration = attachmentGeneration;
      await waitForPlanningRequestLoad();
      const feedback = parseFeedbackCommand(message);
      if (feedback.kind !== "other") {
        if (disposed || resetBlocksWork() || attachmentIds.length !== 0) {
          return Promise.resolve(false);
        }
        if (feedback.kind === "usage") {
          reduce({ type: "announce", announcement: FEEDBACK_USAGE_COPY });
          return false;
        }
        if (feedback.kind === "too-long" || feedback.kind === "invalid") {
          reduce({
            type: "announce",
            announcement:
              feedback.kind === "too-long" ? FEEDBACK_TOO_LONG_COPY : FEEDBACK_FAILED_COPY,
          });
          return false;
        }
        let result: SubmitFeedbackResult;
        try {
          result =
            input.submitAthleteFeedback === undefined
              ? { ok: false, reason: "unavailable" }
              : await input.submitAthleteFeedback(feedback.text);
        } catch {
          result = { ok: false, reason: "unavailable" };
        }
        if (disposed) return false;
        if (!result.ok) {
          reduce({ type: "announce", announcement: FEEDBACK_FAILED_COPY });
          return false;
        }
        clearSubmittedDraftError(submittedTextRevision);
        reduce({ type: "announce", announcement: FEEDBACK_SENT_COPY });
        if (
          attachmentGenerationIsCurrent(submittedAttachmentGeneration) &&
          submittedTextRevision === attachmentTextRevision
        ) {
          saveAttachmentDraftText("");
          await attachmentTextSaveTask;
        }
        return true;
      }
      if (
        message.trim().toLowerCase() === "/plan" &&
        attachmentIds.length === 0 &&
        canChat() &&
        queueLoaded &&
        !disposed &&
        !resetBlocksWork() &&
        !decisionBlocksWork()
      ) {
        if (planCreation === null) await controller.startPlanCreation();
        else if (planCreationPaused) controller.continuePlanCreation();
        else return false;
        if (disposed || planCreation === null) return false;
        clearSubmittedDraftError(submittedTextRevision);
        if (
          attachmentGenerationIsCurrent(submittedAttachmentGeneration) &&
          submittedTextRevision === attachmentTextRevision
        ) {
          saveAttachmentDraftText("");
          await attachmentTextSaveTask;
        } else {
          render();
        }
        return true;
      }
      if (
        !canChat() ||
        !queueLoaded ||
        (!/\S/u.test(message) && attachmentIds.length === 0) ||
        (/^\s*\//u.test(message) && attachmentIds.length > 0) ||
        disposed ||
        resetBlocksWork() ||
        decisionBlocksWork() ||
        planCreationBlocksWork()
      ) {
        return Promise.resolve(false);
      }
      const changeSurface = readChange();
      if (pendingChangeCheck() !== null) return false;
      if (routesTextToPlanChange() && attachmentIds.length === 0) {
        if (changeSurface.busy) return false;
        if (changesPaused()) {
          publishChange({ notice: PLAN_CHANGES_PAUSED_NOTICE });
          return false;
        }
        if (!PlanChangeRequestSchema.safeParse({ kind: "text", text: message }).success) {
          publishChange({ error: PLAN_CHANGE_TEXT_LENGTH_COPY });
          return false;
        }
        clearSubmittedDraftError(submittedTextRevision);
        publishChange({ busy: true, error: null, notice: null });
        reduce({
          type: "append-athlete-message",
          id: nextId("message"),
          text: message,
          occurredAtMs: now(),
        });
        if (
          attachmentGenerationIsCurrent(submittedAttachmentGeneration) &&
          submittedTextRevision === attachmentTextRevision
        ) {
          controller.saveAttachmentDraftText("");
          await attachmentTextSaveTask;
        }
        if (disposed) return false;
        publishChange({ busy: false });
        await controller.previewPlanChange({ kind: "text", text: message });
        return true;
      }
      const ownership = beginAttachmentWrite(false);
      if (ownership === null) return Promise.resolve(false);
      const submissionId = globalThis.crypto.randomUUID();
      const submittedAttachments = (attachmentSurface?.draft?.attachments ?? [])
        .filter((attachment) => attachmentIds.includes(attachment.attachmentId))
        .map(({ attachmentId, displayName, kind, extension }) => ({
          attachmentId,
          displayName,
          kind,
          extension,
        }));
      return input.clients.getClient().then(
        async (client) => {
          try {
            await attachmentTextSaveTask;
            const revision = claimAttachmentSurface();
            const acknowledged = await client.call("enqueueChatMessage", {
              chatId: DESKTOP_CHAT_ID,
              submissionId,
              text: message,
              ...(attachmentIds.length === 0 ? {} : { attachmentIds: [...attachmentIds] }),
            });
            if (!attachmentGenerationIsCurrent(ownership.generation)) return false;
            for (const attachment of submittedAttachments) {
              attachmentSummaries.set(attachment.attachmentId, attachment);
            }
            if (attachmentSurfaceIsCurrent(ownership.generation, revision)) {
              attachmentAdmissions = [];
              attachmentSurface =
                attachmentSurface === null ? null : { ...attachmentSurface, draft: null };
            }
            clearSubmittedDraftError(submittedTextRevision);
            planCreationNotice = null;
            stalledDrainHeadId = null;
            applyQueueSnapshot(acknowledged);
            void refreshAttachments(client, ownership.generation, false);
            return true;
          } finally {
            finishAttachmentWrite(ownership.token);
          }
        },
        (error: unknown) => {
          finishAttachmentWrite(ownership.token);
          throw error;
        },
      );
    },
    chooseAttachments() {
      return runNativeAttachmentAction(input.nativeAttachments?.choose);
    },
    pasteAttachment() {
      return runNativeAttachmentAction(input.nativeAttachments?.paste);
    },
    receiveAttachmentAdmissions(results) {
      if (disposed || resetBlocksWork()) return;
      if (results.length === 0) {
        if (attachmentAdmissions.length === 0 && attachmentError === null) return;
        attachmentAdmissions = [];
        attachmentError = null;
        render();
        return;
      }
      if (attachmentBusyTokens.size > 0) return;
      receiveAdmissions(results);
    },
    saveAttachmentDraftText,
    removeAttachment(attachmentId) {
      void mutateAttachment((client) =>
        client.call("removeChatAttachment", { chatId: DESKTOP_CHAT_ID, attachmentId }),
      );
    },
    retryAttachment(attachmentId) {
      void mutateAttachment((client) =>
        client.call("retryChatAttachment", { chatId: DESKTOP_CHAT_ID, attachmentId }),
      );
    },
    selectAttachmentWorkout(attachmentId, workoutId) {
      void mutateAttachment((client) =>
        client.call("selectChatAttachmentWorkout", {
          chatId: DESKTOP_CHAT_ID,
          attachmentId,
          workoutId,
        }),
      );
    },
    reviewAttachmentInPlan(attachmentId) {
      if (
        disposed ||
        resetBlocksWork() ||
        !planningRequestsLoaded ||
        planningRequestBusyId !== null
      ) {
        return;
      }
      const attachment = attachmentSurface?.draft?.attachments.find(
        (item) => item.attachmentId === attachmentId,
      );
      if (
        attachment?.status !== "ready" ||
        attachment.preview.kind !== "workout" ||
        attachment.preview.selectedWorkoutId === null
      ) {
        return;
      }
      const existing = planningRequests.find(
        (delivery) =>
          delivery.source?.attachmentId === attachmentId &&
          (delivery.state !== "delivered" || delivery.planningRequest?.lifecycle === "open"),
      );
      if (existing !== undefined) {
        if (existing.state === "failed" && existing.retryable) {
          retrySavedPlanningRequest(existing.requestId);
        } else {
          routeToPlanningRequest(existing.requestId);
        }
        return;
      }
      const preview = attachment.preview;
      const selected = preview.workouts.find(
        (workout) => workout.workoutId === preview.selectedWorkoutId,
      );
      if (selected === undefined) return;
      const requestId = globalThis.crypto.randomUUID();
      deliverWorkoutPlanningRequest({
        requestId,
        intent: `Review ${selected.title} in Plan.`,
        source: {
          chatId: DESKTOP_CHAT_ID,
          messageId: globalThis.crypto.randomUUID(),
          attachmentId,
        },
      });
    },
    continueMessageInPlan(messageId, suggestion) {
      if (
        disposed ||
        resetBlocksWork() ||
        !planningRequestsLoaded ||
        planningRequestBusyId !== null
      ) {
        return;
      }
      const existing = planningRequests.find(
        (delivery) => delivery.source?.messageId === messageId && delivery.state !== "cancelled",
      );
      if (existing !== undefined) {
        if (existing.state === "failed" && existing.retryable) {
          retrySavedPlanningRequest(existing.requestId);
        } else {
          routeToPlanningRequest(existing.requestId);
        }
        return;
      }
      const requestId = globalThis.crypto.randomUUID();
      deliverPlanningRequest({
        payload: {
          requestId,
          kind: suggestion.kind,
          intent: suggestion.intent,
          source: { chatId: DESKTOP_CHAT_ID, messageId },
          sourceSnapshot: {
            capturedAt: new Date().toISOString(),
            attachment: null,
            selectedWorkout: null,
          },
          ...(suggestion.requestedDate === undefined
            ? {}
            : { requestedDate: suggestion.requestedDate }),
        },
      });
    },
    openPlanningRequest(requestId) {
      if (disposed) return;
      routeToPlanningRequest(requestId);
    },
    retryPlanningRequest(requestId) {
      retrySavedPlanningRequest(requestId);
    },
    retryPlanningRequestLoad() {
      if (disposed || planningRequestBusyId !== null) return;
      if (pendingPlanningRequestCreate !== null) {
        if (pendingPlanningRequestCreate.kind === "generic") {
          deliverPlanningRequest(pendingPlanningRequestCreate.request);
        } else {
          deliverWorkoutPlanningRequest(pendingPlanningRequestCreate.request);
        }
        return;
      }
      planningRequestError = null;
      render();
      void trackPlanningRequestLoad(
        recoverPlanningRequests().catch(() => {
          if (disposed) return;
          planningRequestsLoaded = false;
          planningRequestError = CHAT_PLANNING_REQUEST_LOAD_FAILURE_COPY;
          render();
        }),
      );
    },
    refreshPlanningRequests() {
      if (disposed || planningRequestBusyId !== null) return;
      void trackPlanningRequestLoad(
        loadPlanningRequests().catch(() => {
          if (disposed) return;
          planningRequestsLoaded = false;
          planningRequestError = CHAT_PLANNING_REQUEST_LOAD_FAILURE_COPY;
          render();
        }),
      );
    },
    focusPlanningRequest(requestId) {
      if (disposed) return;
      planningRequestFocusId = requestId;
      render();
    },
    clearPlanningRequestFocus() {
      if (disposed || planningRequestFocusId === null) return;
      planningRequestFocusId = null;
      render();
    },
    resumeCreation(model) {
      if (disposed || planCreationBusy) return;
      installPlanCreation(model);
      planCreationLoaded = true;
      planCreationEditingKey = null;
      clearPlanCreationPause();
      implicitPlanChangeRouting = false;
      publishChange({ textRouting: false });
      planCreationPaused = false;
      planCreationFocusRevision += 1;
      if (planCreation?.draft !== null && planCreation?.draft !== undefined) {
        requestPlanCreationFocus("activate");
      }
      render();
    },
    async continueCreationFromLibrary(creationId) {
      if (disposed || planCreationBusy) return;
      planCreationBusy = true;
      planCreationError = null;
      planCreationNotice = null;
      render();
      try {
        const result = await (
          await input.clients.getClient()
        ).call("listPlanningRequests", {
          chatId: DESKTOP_CHAT_ID,
        });
        if (disposed) return;
        if (result.planCreation?.creationId !== creationId) {
          planCreationNotice = CHAT_PLAN_CREATION_CONTINUE_MISSING_COPY;
          render();
          await input.refreshPlan?.();
          if (disposed) return;
          installPlanCreation(result.planCreation);
          planCreationLoaded = true;
          return;
        }
        input.openChat?.();
        installPlanCreation(result.planCreation);
        planCreationLoaded = true;
        planCreationEditingKey = null;
        clearPlanCreationPause();
        implicitPlanChangeRouting = false;
        publishChange({ textRouting: false });
        planCreationPaused = false;
        planCreationFocusRevision += 1;
        if (result.planCreation.draft !== null) requestPlanCreationFocus("activate");
        render();
      } catch {
        if (disposed) return;
        planCreationError = CHAT_PLAN_CREATION_FAILURE_COPY;
      } finally {
        if (!disposed) {
          planCreationBusy = false;
          render();
        }
      }
    },
    async startPlanCreation() {
      if (
        disposed ||
        planCreationBusy ||
        !planCreationLoaded ||
        planCreation !== null ||
        decisionBlocksWork()
      ) {
        return;
      }
      planCreationBusy = true;
      planCreationError = null;
      planCreationNotice = null;
      render();
      try {
        const result = await (
          await input.clients.getClient()
        ).call("plan_creation.start", {
          commandId: planCommandId("start"),
        });
        if (disposed) return;
        pendingPlanCreationCommand = null;
        if (result.status === "started") installPlanCreation(result.planCreation);
        else planCreationError = CHAT_PLAN_CREATION_FAILURE_COPY;
      } catch {
        if (disposed) return;
        planCreationError = CHAT_PLAN_CREATION_FAILURE_COPY;
      } finally {
        if (!disposed) {
          planCreationBusy = false;
          render();
        }
      }
    },
    async buildPlanCreationDraft() {
      if (
        disposed ||
        planCreationBusy ||
        planCreationDiscardConfirmationOpen ||
        planCreationActivateConfirmationOpen ||
        planCreation === null ||
        planCreation.readiness !== "ready" ||
        planCreation.pendingCommitment !== null ||
        planCreation.pendingCheck !== null ||
        planCreationEditingKey !== null
      )
        return;
      const creationId = planCreation.creationId;
      const expectedVersion = planCreation.version;
      const key = JSON.stringify({ operation: "preview", creationId, expectedVersion });
      planCreationBusy = true;
      planCreationError = null;
      planCreationNotice = null;
      render();
      try {
        const result = await (
          await input.clients.getClient()
        ).call("plan_creation.preview", {
          commandId: planCommandId(key),
          creationId,
          expectedVersion,
        });
        if (disposed) return;
        pendingPlanCreationCommand = null;
        installPlanCreation(result.planCreation);
        if (result.status === "rejected" && result.reason === "commitments-pending") {
          planCreationError = result.explanation;
          await loadPlanningRequestsBestEffort();
        } else if (result.status === "rejected") {
          planCreationNotice = planCreationBuildRejectionCopy(result.reason);
        }
      } catch (error) {
        if (disposed) return;
        if (
          error instanceof CoachRpcRemoteError &&
          error.data !== null &&
          typeof error.data === "object" &&
          "code" in error.data &&
          error.data.code === "commitments-pending"
        ) {
          pendingPlanCreationCommand = null;
          planCreationError = error.message;
          await loadPlanningRequestsBestEffort();
        } else {
          planCreationNotice = "Build failed. Your answers and last complete Draft are preserved.";
        }
      } finally {
        if (!disposed) {
          planCreationBusy = false;
          render();
        }
      }
    },
    answerPlanCreation,
    pausePlanCreation() {
      if (
        disposed ||
        planCreationBusy ||
        planCreation === null ||
        planCreationPaused ||
        (planCreationEditingKey === null && planCreation.openQuestion === null)
      )
        return;
      planCreationEditingKey = null;
      planCreationEditReturnPaused = false;
      if (planCreation?.openQuestion !== null && planCreation?.openQuestion !== undefined) {
        writePlanCreationPause({
          creationId: planCreation.creationId,
          answerKey: planCreationQuestionKey(planCreation.openQuestion),
        });
        planCreationPaused = true;
      } else {
        clearPlanCreationPause();
        planCreationPaused = false;
      }
      render();
    },
    continuePlanCreation() {
      if (
        disposed ||
        planCreationBusy ||
        planCreation === null ||
        !planCreationPaused ||
        planCreation.openQuestion === null
      ) {
        return;
      }
      clearPlanCreationPause();
      implicitPlanChangeRouting = false;
      publishChange({ textRouting: false });
      planCreationPaused = false;
      planCreationFocusRevision += 1;
      render();
    },
    editPlanCreation(answerKey) {
      if (
        disposed ||
        planCreationBusy ||
        planCreation === null ||
        (!(answerKey === "commitments" && planCreation.pendingCommitment !== null) &&
          !(
            planCreation.pendingCheck !== null &&
            answerKey ===
              (planCreation.pendingCheck.submission.field === "event"
                ? "goal"
                : planCreation.pendingCheck.submission.field)
          ) &&
          !planCreation.answeredSummaries.some((summary) => summary.answerKey === answerKey))
      ) {
        return;
      }
      planCreationEditReturnPaused = planCreationPaused;
      planCreationEditingKey = answerKey;
      planCreationPaused = false;
      planCreationFocusRevision += 1;
      render();
    },
    cancelPlanCreationEdit(returnFocus) {
      if (disposed || planCreationBusy || (planCreationEditingKey === null && !returnFocus)) return;
      if (planCreationEditingKey !== null) {
        planCreationEditingKey = null;
        planCreationPaused = planCreationEditReturnPaused;
        planCreationEditReturnPaused = false;
        planCreationFocusRevision += 1;
      }
      if (returnFocus) requestPlanCreationFocus(returnFocus);
      render();
    },
    openPlanCreationDiscard() {
      if (
        disposed ||
        planCreationBusy ||
        !planCreationLoaded ||
        planCreation === null ||
        planCreationDiscardConfirmationOpen ||
        planCreationActivateConfirmationOpen
      ) {
        return;
      }
      planCreationDiscardConfirmationOpen = true;
      planCreationError = null;
      planCreationNotice = null;
      render();
    },
    cancelPlanCreationDiscard() {
      if (disposed || planCreationBusy || !planCreationDiscardConfirmationOpen) return;
      planCreationDiscardConfirmationOpen = false;
      requestPlanCreationFocus("discard");
      render();
    },
    async confirmPlanCreationDiscard() {
      if (
        disposed ||
        planCreationBusy ||
        !planCreationDiscardConfirmationOpen ||
        planCreation === null
      ) {
        return;
      }
      const target = planCreation;
      const key = JSON.stringify({
        action: "discard",
        creationId: target.creationId,
        expectedVersion: target.version,
      });
      planCreationBusy = true;
      planCreationError = null;
      planCreationNotice = null;
      render();
      try {
        const result = await (
          await input.clients.getClient()
        ).call("plan_creation.discard", {
          commandId: planCommandId(key),
          creationId: target.creationId,
          expectedVersion: target.version,
        });
        if (disposed) return;
        pendingPlanCreationCommand = null;
        planCreationDiscardConfirmationOpen = false;
        if (result.status === "discarded") {
          input.openChat?.();
          installPlanCreation(null, "start");
          if (!planCreationDiscardEvents.some((event) => event.eventId === target.creationId)) {
            planCreationDiscardEvents = [
              ...planCreationDiscardEvents,
              { eventId: target.creationId, afterMessageId: latestMessageId() },
            ];
          }
        } else {
          installPlanCreation(
            result.planCreation,
            result.planCreation === null ? "start" : "discard",
          );
          planCreationNotice = planCreationDiscardNotice(result.reason);
        }
      } catch {
        if (disposed) return;
        planCreationError = CHAT_PLAN_CREATION_FAILURE_COPY;
      } finally {
        if (!disposed) {
          planCreationBusy = false;
          render();
        }
      }
    },
    async openPlanCreationActivate() {
      if (
        disposed ||
        planCreationBusy ||
        !planCreationLoaded ||
        planCreationDiscardConfirmationOpen ||
        planCreationActivateConfirmationOpen ||
        planCreation === null ||
        planCreation.draft === null ||
        planCreation.draftStale ||
        planCreation.pendingCommitment !== null ||
        planCreation.pendingCheck !== null ||
        !planCreation.draft.weeks.some((week) => week.workouts.length > 0)
      )
        return;
      const knowledge: ActivePlanKnowledge = { kind: "unknown" };
      activePlanKnowledge = knowledge;
      planCreationBusy = true;
      planCreationError = null;
      planCreationNotice = null;
      render();
      try {
        const result = await (await input.clients.getClient()).call("getPlanState", {});
        if (disposed || activePlanKnowledge !== knowledge) return;
        if (result.status !== "ready") throw new Error("plan-state-unavailable");
        activePlanKnowledge =
          result.state.lifecycle === "active"
            ? {
                kind: "active",
                name: PlanActiveProjectionDataSchema.parse(result.state.data).plan.name,
              }
            : { kind: "none" };
        planCreationActivateConfirmationOpen = true;
      } catch {
        if (disposed || activePlanKnowledge !== knowledge) return;
        planCreationError =
          "The current Plan could not be read. Refresh the Plan library before activating.";
      }
      planCreationBusy = false;
      render();
    },
    cancelPlanCreationActivate() {
      if (disposed || planCreationBusy || !planCreationActivateConfirmationOpen) return;
      planCreationActivateConfirmationOpen = false;
      planCreationError = null;
      requestPlanCreationFocus("activate");
      render();
    },
    async confirmPlanCreationActivate() {
      if (
        disposed ||
        planCreationBusy ||
        !planCreationActivateConfirmationOpen ||
        activePlanKnowledge.kind === "unknown" ||
        planCreation === null
      )
        return;
      const library = input.readPlanLibrary?.();
      if (library == null) {
        planCreationError = "Read the Plan library and confirm again.";
        render();
        return;
      }
      const incumbent =
        library.active === null
          ? null
          : { planId: library.active.planId, version: library.active.version };
      const target = planCreation;
      if (
        activationAttempt?.creationId !== target.creationId ||
        activationAttempt.expectedVersion !== target.version
      ) {
        activationAttempt = {
          commandId: globalThis.crypto.randomUUID(),
          creationId: target.creationId,
          expectedVersion: target.version,
          incumbent,
        };
      }
      planCreationBusy = true;
      planCreationError = null;
      render();
      try {
        await (await input.clients.getClient()).call("plan_creation.activate", activationAttempt);
        if (disposed) return;
        activationAttempt = null;
      } catch (error) {
        if (disposed) return;
        const rejection =
          error instanceof CoachRpcRemoteError &&
          error.data !== null &&
          typeof error.data === "object" &&
          "code" in error.data
            ? error.data.code
            : null;
        if (rejection === "commitments-pending" && error instanceof CoachRpcRemoteError) {
          activationAttempt = null;
          planCreationActivateConfirmationOpen = false;
          planCreationError = error.message;
          await loadPlanningRequestsBestEffort();
        } else if (
          rejection === "version-conflict" ||
          rejection === "not-ready" ||
          rejection === "command-conflict"
        ) {
          activationAttempt = null;
          planCreationError =
            rejection === "version-conflict"
              ? "The Plan changed. Read the Plan library and confirm again."
              : "Activation could not be saved locally. Your previous Plan is unchanged.";
        } else {
          planCreationError =
            "The activation result could not be confirmed. The Plan library will show the current state after refresh.";
        }
        if (disposed) return;
        await refreshPlanLibraryBestEffort();
        if (disposed) return;
        planCreationBusy = false;
        render();
        return;
      }
      planCreationActivateConfirmationOpen = false;
      installPlanCreation(null, "start");
      planCreationNotice = "Plan activated locally.";
      planCreationBusy = false;
      render();
      await input.refreshPlan?.();
    },
    stop() {
      if (disposed || state.status !== "streaming" || state.activeTurn === null) return;
      activeStopRequest?.request();
    },
    removeQueued(id) {
      if (disposed || resetBlocksWork()) return;
      queueMutationError = null;
      queueMutationCount += 1;
      render();
      void input.clients
        .getClient()
        .then(
          async (client) => {
            try {
              const acknowledged = await client.call("removeQueuedChatMessage", {
                chatId: DESKTOP_CHAT_ID,
                queuedMessageId: id,
              });
              if (!disposed) {
                queueMutationError = null;
                applyQueueSnapshot(acknowledged);
              }
            } catch {
              if (!disposed) {
                queueMutationError = CHAT_QUEUE_REMOVE_FAILURE_COPY;
                render();
              }
            }
          },
          () => {
            if (!disposed) {
              queueMutationError = CHAT_QUEUE_REMOVE_FAILURE_COPY;
              render();
            }
          },
        )
        .finally(() => {
          queueMutationCount -= 1;
          render();
        });
    },
    runQueuedCommand(id) {
      if (
        disposed ||
        !queueLoaded ||
        resetBlocksWork() ||
        decisionBlocksWork() ||
        planCreationBlocksWork() ||
        state.status !== "idle"
      ) {
        return activeTask ?? Promise.resolve();
      }
      const head = state.queued[0];
      if (head?.id !== id || !head.command) return Promise.resolve();
      return dispatchQueue(head.text, {
        method: "runQueuedCommand",
        queuedMessageId: id,
        queuedMessageIds: [id],
      });
    },
    retryQueuedTurn(claimId) {
      if (
        disposed ||
        !queueLoaded ||
        resetBlocksWork() ||
        decisionBlocksWork() ||
        planCreationBlocksWork() ||
        (state.status !== "idle" && state.status !== "interrupted")
      ) {
        return activeTask ?? Promise.resolve();
      }
      if (state.retryRequired?.claimId !== claimId) return Promise.resolve();
      const ids = new Set(state.retryRequired.queuedMessageIds);
      const text = state.queued
        .filter((item) => ids.has(item.id))
        .map((item) => item.text)
        .join("\n\n");
      return dispatchQueue(
        text,
        { method: "retryQueuedTurn", claimId, queuedMessageIds: [...ids] },
        false,
      );
    },
    retryInterrupted() {
      if (
        !canChat() ||
        !queueLoaded ||
        disposed ||
        state.status !== "interrupted" ||
        state.retryRequired != null ||
        state.activeTurn === null ||
        resetBlocksWork() ||
        planCreationBlocksWork()
      ) {
        return activeTask ?? Promise.resolve();
      }
      const { requestKey, userMessage } = state.activeTurn;
      const queueOrigin =
        interruptedQueueOrigin?.requestKey === requestKey ? interruptedQueueOrigin.call : undefined;
      if (queuedRetry?.requestKey === requestKey) return queuedRetry.promise;
      if (activeTask === undefined) {
        interruptedQueueOrigin = undefined;
        return dispatch(userMessage, false, retryReconnect, queueOrigin);
      }
      const currentTask = activeTask;
      const token = {};
      const pending = currentTask
        .then(() => {
          if (
            !canChat() ||
            disposed ||
            state.status !== "interrupted" ||
            state.activeTurn?.requestKey !== requestKey ||
            planCreationBlocksWork()
          ) {
            return;
          }
          interruptedQueueOrigin = undefined;
          return dispatch(userMessage, false, retryReconnect, queueOrigin);
        })
        .finally(() => {
          if (queuedRetry?.token === token) {
            queuedRetry = undefined;
            render();
          }
        });
      queuedRetry = { requestKey, promise: pending, token };
      reduce({ type: "retry-pending", requestKey });
      return pending;
    },
    retry() {
      const claim = state.retryRequired;
      if (claim != null) return controller.retryQueuedTurn(claim.claimId);
      return controller.retryInterrupted();
    },
    loadEarlier() {
      return hydrator.loadEarlier();
    },
    retryHydration() {
      return hydrator.retry();
    },
    async retryDecision() {
      if (disposed || decisionLoadTask !== undefined) return decisionLoadTask;
      stalledDrainHeadId = null;
      decisionLoaded = false;
      decisionLoadError = null;
      queueLoadError = null;
      render();
      const task = (async () => {
        try {
          const client = await input.clients.reconnect();
          const [loaded] = await Promise.all([refreshDecision(client), refreshQueue(client)]);
          const recoveryTasks: Promise<unknown>[] = [];
          if (hydration.status === "failed") recoveryTasks.push(hydrator.retry());
          if (bootProbes.session === "failed") recoveryTasks.push(runSessionProbe(client));
          if (bootProbes.attachments === "failed") {
            recoveryTasks.push(refreshAttachments(client, attachmentGeneration));
          }
          if (bootProbes.planningRequests === "failed") {
            recoveryTasks.push(runPlanningRecovery(client));
          }
          if (recoveryTasks.length > 0) await Promise.allSettled(recoveryTasks);
          if (
            loaded?.status === "answered" &&
            loaded.continuation.status === "pending" &&
            decisionActionTask === undefined
          ) {
            await continueDecision("resumeCoachDecision", loaded, undefined);
          }
        } catch {
          bootProbes.decision = "failed";
          decisionLoaded = false;
          if (!queueLoaded) {
            bootProbes.queue = "failed";
            queueLoadError = CHAT_QUEUE_LOAD_FAILURE_COPY;
          } else {
            decisionLoadError = CHAT_DECISION_LOAD_FAILURE_COPY;
          }
          decisionPhase = "idle";
          render();
        }
      })();
      decisionLoadTask = task;
      await task.finally(() => {
        if (decisionLoadTask === task) decisionLoadTask = undefined;
        render();
      });
    },
    openNewConversation() {
      if (!canChat()) return false;
      if (!canOpenNewConversation()) return false;
      epoch += 1;
      state = reduceChatState(state, {
        type: "open-new-conversation",
        hasHydratedHistory: hydration.turns.length > 0 || hydration.entries.length > 0,
        hasAttachmentDraft: attachmentSurface?.draft != null,
      });
      render();
      return true;
    },
    cancelNewConversation() {
      if (!canChat() || disposed || state.session.resetPhase !== "confirming") return;
      reduce({ type: "cancel-new-conversation" });
    },
    confirmNewConversation() {
      if (resetTask !== undefined) return resetTask;
      if (!canChat() || disposed || state.session.resetPhase !== "confirming") {
        return Promise.resolve();
      }
      resetEvidence = {
        turnIds: new Set([
          ...transcriptTurnIds(hydration),
          ...state.messages.flatMap((message) =>
            message.turnId === undefined ? [] : [message.turnId],
          ),
        ]),
        historyLoaded: hydration.status === "ready",
        queuedIds: new Set(state.queued.map((message) => message.id)),
        draftWrites: attachmentOperationSequence,
      };
      updateReset(() => hydrator.beginReset(), { type: "begin-reset" });
      const resetEpoch = ++epoch;
      const resetAttachmentGeneration = ++attachmentGeneration;
      claimAttachmentSurface();
      const task = (async () => {
        try {
          if (attachmentWriteTokens.size > 0) await waitForAttachmentWrites();
          if (
            disposed ||
            epoch !== resetEpoch ||
            !attachmentGenerationIsCurrent(resetAttachmentGeneration)
          ) {
            return;
          }
          const client = await input.clients.getClient();
          const result = await client.call("resetSession", { chatId: DESKTOP_CHAT_ID });
          if (
            disposed ||
            epoch !== resetEpoch ||
            !attachmentGenerationIsCurrent(resetAttachmentGeneration)
          ) {
            return;
          }
          await attachmentTextSaveTask;
          if (
            disposed ||
            epoch !== resetEpoch ||
            !attachmentGenerationIsCurrent(resetAttachmentGeneration)
          ) {
            return;
          }
          const clearedAttachmentSurface = await client.call("clearChatAttachmentDraft", {
            chatId: DESKTOP_CHAT_ID,
          });
          if (
            disposed ||
            epoch !== resetEpoch ||
            !attachmentGenerationIsCurrent(resetAttachmentGeneration)
          ) {
            return;
          }
          finishNewConversation(clearedAttachmentSurface, {
            type: "reset-succeeded",
            announcement: result.memoryFlushed
              ? NEW_CONVERSATION_SUCCESS_COPY
              : NEW_CONVERSATION_MEMORY_WARNING_COPY,
          });
        } catch {
          if (
            disposed ||
            epoch !== resetEpoch ||
            !attachmentGenerationIsCurrent(resetAttachmentGeneration)
          ) {
            return;
          }
          updateReset(() => hydrator.resetFailed(), {
            type: "reset-failed",
            announcement: NEW_CONVERSATION_UNCERTAIN_COPY,
          });
          await runNewConversationCheck("automatic");
        } finally {
          if (!disposed && epoch === resetEpoch) {
            void reportBestEffortAsync("desktop-chat-refresh-spend-failed", () =>
              input.refreshSpend(),
            );
          }
        }
      })();
      resetTask = task;
      void task.finally(() => {
        if (resetTask === task) {
          resetTask = undefined;
          render();
        }
      });
      return task;
    },
    checkNewConversation() {
      return newConversationCheckControl() === "ready"
        ? runNewConversationCheck("athlete")
        : (newConversationCheck?.task ?? Promise.resolve());
    },
    answerDecision(decisionId, answer) {
      if (
        disposed ||
        resetBlocksWork() ||
        state.status === "streaming" ||
        decisionActionTask !== undefined ||
        decision?.status !== "unanswered" ||
        decision.decisionId !== decisionId
      ) {
        return decisionActionTask ?? Promise.resolve();
      }
      return continueDecision("answerCoachDecision", decision, answer);
    },
    skipDecision(decisionId) {
      if (
        disposed ||
        resetBlocksWork() ||
        state.status === "streaming" ||
        decisionActionTask !== undefined ||
        decision?.status !== "unanswered" ||
        decision.decisionId !== decisionId
      ) {
        return decisionActionTask ?? Promise.resolve();
      }
      decisionError = null;
      render();
      const task = (async () => {
        try {
          const client = await input.clients.getClient();
          const result = await client.call("skipCoachDecision", {
            chatId: DESKTOP_CHAT_ID,
            decisionId,
          });
          if (disposed || decision?.decisionId !== decisionId) return;
          decision = result.decision;
          decisionPhase = "idle";
          decisionAnswerLabel = null;
        } catch {
          if (disposed || decision?.decisionId !== decisionId) return;
          decisionError = CHAT_DECISION_SKIP_FAILURE_COPY;
        }
      })();
      decisionActionTask = task;
      return task.finally(() => {
        if (decisionActionTask === task) decisionActionTask = undefined;
        render();
      });
    },
    dispose() {
      disposed = true;
      activeStopRequest = undefined;
      interruptedQueueOrigin = undefined;
      hydrator.dispose();
      decision = null;
      epoch += 1;
      attachmentGeneration += 1;
      claimAttachmentSurface();
      attachmentTextRevision += 1;
      clearDroppedAttachmentAdmissions();
      attachmentWriteTokens.clear();
      attachmentBusyTokens.clear();
      for (const resolve of attachmentWriteWaiters) resolve();
      attachmentWriteWaiters.clear();
      sequence += 1;
    },
  };
  return controller;
}
