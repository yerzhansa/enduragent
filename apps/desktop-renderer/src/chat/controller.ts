import type {
  CoachClient,
  CoachClientCallOptions,
  CoachClientTerminalEnvelope,
} from "@enduragent/coach-client";
import {
  CoachClientCallAbortedError,
  CoachClientCallTimeoutError,
  CoachClientDisconnectedError,
  CoachClientProtocolError,
} from "@enduragent/coach-client";
import type {
  AttachmentAdmissionReadModel,
  ChatAttachmentComposerReadModel,
  CoachDecisionAnswer,
  CoachDecisionReadModel,
  ChatQueueSnapshot,
  CoachTurnEventNotificationEnvelope,
  CreatePlanningRequestRpcParams,
  CreateWorkoutPlanningRequestRpcParams,
  PlanHandoffSuggestion,
  PlanCreationAnswerInput,
  PlanCreationCardModel,
  PlanningRequestDelivery,
  TranscriptPageEntry,
  TurnEvent,
} from "@enduragent/coach-contract";
import type { DesktopCoachClientProvider } from "../coach-client";
import {
  DESKTOP_CHAT_ID,
  EMPTY_CHAT_STATE,
  hasClearableConversation,
  nextDrainGroup,
  reduceChatState,
  type ChatSentAttachment,
  type ChatState,
} from "../turn-state";
import {
  createTranscriptHydrator,
  emptyTranscriptHydration,
  mergeHydratedMessages,
  type TranscriptHydrationChange,
  type TranscriptHydrationStatus,
  type TranscriptPage,
} from "./hydration";
import { COACH_RESPONSE_CODE_UNIT_LIMIT, COACH_TURN_EVENT_LIMIT } from "./limits";

export const CHAT_CONNECTION_INTERRUPTED_COPY =
  "Connection interrupted. Your partial response is preserved.";
export const CHAT_RESPONSE_STOPPED_COPY = "Response stopped. Your partial response is preserved.";
export const CHAT_PROTOCOL_FAILURE_COPY =
  "The coaching response could not be verified. Please try again.";
export const CHAT_FAILURE_COPY = "The coach couldn't respond. Please try again.";
export const CHAT_EMPTY_RESPONSE_COPY = "The coach returned an empty response. Please try again.";
export const CHAT_DECISION_FAILURE_COPY =
  "We couldn’t continue from your choice. Please try again.";
export const CHAT_DECISION_SKIP_FAILURE_COPY = "We couldn’t skip this question. Please try again.";
export const CHAT_DECISION_LOAD_FAILURE_COPY =
  "We couldn’t check for a saved Coach question. Reconnect and try again.";
export const CHAT_QUEUE_LOAD_FAILURE_COPY =
  "We couldn’t check your saved messages. Reconnect and try again.";
export const CHAT_QUEUE_REMOVE_FAILURE_COPY = "We couldn’t remove that saved message. Try again.";
export const CHAT_ATTACHMENT_FAILURE_COPY =
  "We couldn’t update that attachment. Your message draft is preserved.";
export const CHAT_PLANNING_REQUEST_LOAD_FAILURE_COPY =
  "We couldn’t check saved Plan requests. Reconnect and try again.";
export const CHAT_PLANNING_REQUEST_FAILURE_COPY =
  "Plan couldn’t receive this request. Your request is preserved and nothing changed in Plan.";
export const CHAT_PLAN_CREATION_FAILURE_COPY = "Plan Creation couldn’t save that. Try again.";
export const NEW_CONVERSATION_SUCCESS_COPY = "New conversation started.";
export const NEW_CONVERSATION_MEMORY_WARNING_COPY =
  "New conversation started. Some recent details may not have been saved to coach memory.";
export const NEW_CONVERSATION_UNCERTAIN_COPY =
  "We couldn’t confirm whether the new conversation started. Your visible conversation is preserved.";

export interface ChatAppendDelta {
  readonly messageId: string;
  readonly previousTextLength: number;
  readonly nextTextLength: number;
  readonly delta: string;
}

export interface ChatViewControls {
  readonly newConversationDisabled: boolean;
  readonly workBlocked: boolean;
  readonly decisionLoading?: boolean;
  readonly decisionLoadError?: string | null;
  readonly queueLoadError?: string | null;
  readonly queueMutationError?: string | null;
  readonly attachments?: {
    readonly value: ChatAttachmentComposerReadModel | null;
    readonly admissions: readonly AttachmentAdmissionReadModel[];
    readonly busy: boolean;
    readonly error: string | null;
  };
  readonly planningRequests?: {
    readonly value: readonly PlanningRequestDelivery[];
    readonly loaded: boolean;
    readonly busyId: string | null;
    readonly error: string | null;
    readonly focusId: string | null;
  };
  readonly planCreation?: {
    readonly value: PlanCreationCardModel | null;
    readonly loaded: boolean;
    readonly busy: boolean;
    readonly error: string | null;
  };
  readonly appendDelta?: ChatAppendDelta;
  readonly hydration?: {
    readonly status: TranscriptHydrationStatus;
    readonly hasEarlier: boolean;
    readonly revision: number;
    readonly change: TranscriptHydrationChange;
    readonly entries?: readonly TranscriptPageEntry[];
  };
  readonly decision?: {
    readonly value: CoachDecisionReadModel | null;
    readonly phase: "idle" | "continuing" | "recovering";
    readonly answerLabel: string | null;
    readonly error: string | null;
  };
}

export interface ChatView {
  render(state: ChatState, controls?: ChatViewControls): void;
}

export interface ChatController {
  start(): Promise<void>;
  resume(): Promise<void>;
  refreshAttachments(): Promise<void>;
  beginDroppedAttachmentAdmission(operationId: string): boolean;
  settleDroppedAttachmentAdmission(
    operationId: string,
    results: readonly AttachmentAdmissionReadModel[] | null,
  ): void;
  submit(message: string, attachmentIds?: readonly string[]): Promise<boolean>;
  chooseAttachments(): Promise<void>;
  pasteAttachment(): Promise<void>;
  receiveAttachmentAdmissions(results: readonly AttachmentAdmissionReadModel[]): void;
  saveAttachmentDraftText(text: string): void;
  removeAttachment(attachmentId: string): void;
  retryAttachment(attachmentId: string): void;
  selectAttachmentWorkout(attachmentId: string, workoutId: string): void;
  reviewAttachmentInPlan(attachmentId: string): void;
  continueMessageInPlan(messageId: string, suggestion: PlanHandoffSuggestion): void;
  openPlanningRequest(requestId: string): void;
  retryPlanningRequest(requestId: string): void;
  retryPlanningRequestLoad(): void;
  refreshPlanningRequests(): void;
  focusPlanningRequest(requestId: string): void;
  clearPlanningRequestFocus(): void;
  startPlanCreation(): Promise<void>;
  answerPlanCreation(answer: PlanCreationAnswerInput): Promise<void>;
  stop(): void;
  removeQueued(id: string): void;
  runQueuedCommand(id: string): Promise<void>;
  retryQueuedTurn(claimId: string): Promise<void>;
  retryInterrupted(): Promise<void>;
  loadEarlier(): Promise<void>;
  retryHydration(): Promise<void>;
  retryDecision(): Promise<void>;
  openNewConversation(): boolean;
  cancelNewConversation(): void;
  confirmNewConversation(): Promise<void>;
  answerDecision(decisionId: string, answer: CoachDecisionAnswer): Promise<void>;
  skipDecision(decisionId: string): Promise<void>;
  dispose(): void;
}

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
  shouldDrain(): boolean;
}

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
  readonly refreshTrainingContext: () => Promise<void>;
  readonly refreshSpend: () => Promise<void>;
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
  let retryClient: CoachClient | undefined;
  let probeTask: Promise<void> | undefined;
  let resetTask: Promise<void> | undefined;
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
    { readonly token: number; readonly generation: number }
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
  let planCreationError: string | null = null;
  let pendingPlanCreationCommand: { readonly key: string; readonly id: string } | null = null;
  let decisionContinuationTask: Promise<void> | undefined;
  let epoch = 0;
  const canChat = input.canChat ?? (() => true);

  const nextId = (prefix: "request" | "message"): string => `${prefix}-${++sequence}`;
  const resetBlocksWork = (): boolean =>
    state.session.resetPhase === "confirming" || state.session.resetPhase === "resetting";
  const decisionBlocksWork = (): boolean =>
    !decisionLoaded ||
    decision?.status === "unanswered" ||
    (decision?.status === "answered" && decision.continuation.status === "pending");
  const planCreationBlocksWork = (): boolean => planCreation?.openQuestion != null;
  const decisionBlocksReset = (): boolean =>
    !decisionLoaded ||
    (decision?.status === "answered" && decision.continuation.status === "pending");
  const canOpenNewConversation = (): boolean =>
    canChat() &&
    queueLoaded &&
    !disposed &&
    (hasClearableConversation(state) ||
      hydration.turns.length > 0 ||
      hydration.entries.length > 0 ||
      attachmentSurface?.draft != null) &&
    state.session.resetPhase === "idle" &&
    state.status !== "streaming" &&
    !decisionBlocksReset() &&
    activeTask === undefined &&
    outstandingChatTasks.size === 0 &&
    attachmentWriteTokens.size === 0 &&
    state.retryRequired == null &&
    queueMutationCount === 0 &&
    queuedRetry === undefined &&
    resetTask === undefined;
  const render = (appendDelta?: ChatAppendDelta): void => {
    if (disposed) return;
    try {
      input.view.render(
        hydration.turns.length === 0 && hydration.entries.length === 0
          ? state
          : {
              ...state,
              messages: mergeHydratedMessages(hydration.turns, state.messages, hydration.entries),
            },
        {
          newConversationDisabled: !canOpenNewConversation(),
          workBlocked: resetBlocksWork() || !queueLoaded,
          decisionLoading: !decisionLoaded,
          decisionLoadError,
          queueLoadError,
          queueMutationError,
          attachments: {
            value: attachmentSurface,
            admissions: attachmentAdmissions,
            busy: attachmentBusyTokens.size > 0,
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
    } catch {}
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
  const reduce = (
    action: Parameters<typeof reduceChatState>[1],
    appendDelta?: ChatAppendDelta,
  ): void => {
    state = reduceChatState(state, action);
    render(appendDelta);
  };
  const applyQueueSnapshot = (snapshot: ChatQueueSnapshot): void => {
    reduce({ type: "queue-snapshot", snapshot });
  };
  const hydrator = createTranscriptHydrator({
    readPage:
      input.readTranscriptPage ??
      (async () => ({
        schemaVersion: 1,
        status: "page",
        turns: [],
        nextCursor: null,
      })),
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
    let shouldDrain = false;
    reduce({
      type: "submit",
      requestKey,
      userMessage,
      userMessageId,
      assistantMessageId,
      includeUser,
      attachments,
    });
    let callStarted = false;
    const task = (async () => {
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
      let client: CoachClient | undefined;
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
        stopTask = client
          .call("stopChat", { chatId: DESKTOP_CHAT_ID, turnId: boundTurnId })
          .then(() => undefined)
          .catch(() => undefined);
      };
      activeStopRequest = { requestKey, request: requestStop };

      try {
        if (reconnect) {
          if (retryClient === undefined) {
            client = await input.clients.reconnect();
          } else {
            const currentClient = await input.clients.getClient();
            client =
              currentClient === retryClient ? await input.clients.reconnect() : currentClient;
          }
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
              shouldDrain = true;
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
          reduce({ type: "discard-submission", requestKey });
          shouldDrain =
            activeQueueCall?.method === "retryQueuedTurn" &&
            queuedResult.snapshot.retryRequired === undefined &&
            activeQueueCall.queuedMessageIds.every(
              (id) => !queuedResult.snapshot.items.some((item) => item.queuedMessageId === id),
            );
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
          shouldDrain = true;
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
        reduce({ type: "complete", requestKey });
        shouldDrain = state.status === "idle" && state.activeTurn?.requestKey === requestKey;
      } catch (error) {
        if (!current()) return;
        if (activeQueueCall !== undefined && client !== undefined) {
          try {
            applyQueueSnapshot(await client.call("getChatQueue", { chatId: DESKTOP_CHAT_ID }));
          } catch {}
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
          reduce({ type: "fail", requestKey, copy: CHAT_FAILURE_COPY });
        }
      } finally {
        if (activeStopRequest?.requestKey === requestKey) activeStopRequest = undefined;
        if (callStarted) {
          try {
            void input.refreshSpend().catch(() => {});
          } catch {}
          try {
            await input.refreshTrainingContext();
          } catch {}
        }
      }
    })();
    activeTask = task;
    outstandingChatTasks.add(task);
    render();
    void task.finally(() => {
      const released = outstandingChatTasks.delete(task);
      if (activeTask === task) {
        activeTask = undefined;
      }
      if (released) render();
    });
    return { task, shouldDrain: () => shouldDrain };
  };

  const dispatch = (
    userMessage: string,
    includeUser: boolean,
    reconnect: boolean,
    queueOrigin?: ChatQueueCall,
  ): Promise<void> => {
    const chatRun = run(userMessage, includeUser, reconnect, undefined, [], queueOrigin);
    return chatRun.task.then(() => (chatRun.shouldDrain() ? drain() : undefined));
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
    return chatRun.task.then(() => (chatRun.shouldDrain() ? drain() : undefined));
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

  const refreshDecision = async (client?: CoachClient): Promise<CoachDecisionReadModel | null> => {
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
    render();
    return decision;
  };

  const refreshQueue = async (client?: CoachClient): Promise<ChatQueueSnapshot> => {
    const activeClient = client ?? (await input.clients.getClient());
    const snapshot = await activeClient.call("getChatQueue", { chatId: DESKTOP_CHAT_ID });
    if (disposed) return snapshot;
    applyQueueSnapshot(snapshot);
    queueLoaded = true;
    queueLoadError = null;
    render();
    return snapshot;
  };

  const refreshAttachments = async (
    client?: CoachClient,
    generation = attachmentGeneration,
    reportError = true,
  ): Promise<void> => {
    const attemptRevision = attachmentSurfaceRevision;
    let activeClient: CoachClient;
    try {
      activeClient = client ?? (await input.clients.getClient());
    } catch {
      if (reportError && attachmentSurfaceIsCurrent(generation, attemptRevision)) {
        attachmentError = CHAT_ATTACHMENT_FAILURE_COPY;
        render();
      }
      return;
    }
    if (attachmentWriteTokens.size > 0) await waitForAttachmentWrites();
    if (!attachmentGenerationIsCurrent(generation)) return;
    const revision = claimAttachmentSurface();
    let surface: ChatAttachmentComposerReadModel;
    try {
      surface = await activeClient.call("getChatAttachmentComposer", {
        chatId: DESKTOP_CHAT_ID,
      });
    } catch {
      if (reportError && attachmentSurfaceIsCurrent(generation, revision)) {
        attachmentError = CHAT_ATTACHMENT_FAILURE_COPY;
        render();
      }
      return;
    }
    if (!attachmentSurfaceIsCurrent(generation, revision)) return;
    attachmentSurface = surface;
    attachmentError = null;
    render();
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

  const loadPlanningRequests = async (client?: CoachClient): Promise<void> => {
    const activeClient = client ?? (await input.clients.getClient());
    const result = await activeClient.call("listPlanningRequests", { chatId: DESKTOP_CHAT_ID });
    if (disposed) return;
    planningRequests = result.deliveries;
    installPlanCreation(result.planCreation);
    planCreationLoaded = true;
    planningRequestsLoaded = true;
    planningRequestError = null;
    render();
    if (!decisionBlocksWork() && !planCreationBlocksWork()) void drain();
  };

  const installPlanCreation = (next: PlanCreationCardModel | null): void => {
    if (next === null) {
      planCreation = null;
    } else if (
      planCreation === null ||
      next.creationId !== planCreation.creationId ||
      next.version >= planCreation.version
    ) {
      planCreation = next;
    }
  };
  const trackPlanningRequestLoad = (task: Promise<void>): Promise<void> => {
    planningRequestLoadTask = task;
    void task.then(
      () => {
        if (planningRequestLoadTask === task) planningRequestLoadTask = undefined;
      },
      () => {
        if (planningRequestLoadTask === task) planningRequestLoadTask = undefined;
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

  const recoverPlanningRequests = async (): Promise<void> => {
    const client = await input.clients.getClient();
    let recoveryFailed = false;
    try {
      await client.call("resumePlanningRequests", {});
    } catch {
      recoveryFailed = true;
    }
    await loadPlanningRequests(client);
    if (recoveryFailed) throw new Error("Planning request recovery failed.");
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
    operation: (client: CoachClient) => Promise<ChatAttachmentComposerReadModel>,
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
    if (decisionContinuationTask !== undefined) return decisionContinuationTask;
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
      userMessage: "",
      userMessageId,
      assistantMessageId,
      includeUser: false,
    });
    const task = (async () => {
      let client: CoachClient | undefined;
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
        stopTask = client
          .call("stopChat", { chatId: DESKTOP_CHAT_ID, turnId: boundTurnId })
          .then(() => undefined)
          .catch(() => undefined);
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
        try {
          void input.refreshSpend().catch(() => {});
        } catch {}
        try {
          await input.refreshTrainingContext();
        } catch {}
      }
    })();
    decisionContinuationTask = task;
    activeTask = task;
    render();
    void task.finally(() => {
      if (decisionContinuationTask === task) decisionContinuationTask = undefined;
      if (activeTask === task) activeTask = undefined;
      render();
      if (!decisionBlocksWork() && !planCreationBlocksWork()) void drain();
    });
    return task;
  };

  const drain = async (): Promise<void> => {
    await waitForPlanningRequestLoad();
    if (
      !canChat() ||
      !queueLoaded ||
      disposed ||
      resetBlocksWork() ||
      decisionBlocksWork() ||
      planCreationBlocksWork() ||
      state.status === "streaming"
    ) {
      return Promise.resolve();
    }
    const group = nextDrainGroup(state);
    if (group === null) return Promise.resolve();
    if (
      state.retryRequired != null ||
      (state.queued[0]?.command === true && state.queued[0]?.restored === true)
    )
      return Promise.resolve();
    return dispatchQueue(group.text, {
      method: "resumeChatQueue",
      queuedMessageIds: state.queued.slice(0, group.size).map((item) => item.id),
    });
  };

  const start = (): Promise<void> => {
    if (!canChat() || disposed) return Promise.resolve();
    if (probeTask !== undefined) return probeTask;
    const transcriptLoadTask = hydrator.start();
    decisionLoaded = false;
    decisionLoadError = null;
    render();
    const loadTask = (async () => {
      try {
        const loaded = await refreshDecision();
        decisionLoaded = true;
        render();
        if (
          loaded?.status === "answered" &&
          loaded.continuation.status === "pending" &&
          decisionContinuationTask === undefined
        ) {
          await continueDecision("resumeCoachDecision", loaded, undefined);
        }
      } catch {
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
      if (!decisionBlocksWork() && !planCreationBlocksWork()) void drain();
    });
    const probeEpoch = epoch;
    const sessionProbeTask = (async () => {
      try {
        const client = await input.clients.getClient();
        const result = await client.call("hasSession", { chatId: DESKTOP_CHAT_ID });
        if (disposed || epoch !== probeEpoch) return;
        reduce({ type: "session-probe", hasSession: result.hasSession });
      } catch {}
    })();
    const queueLoadTask = (async () => {
      try {
        await refreshQueue();
      } catch {
        queueLoaded = false;
        queueLoadError = CHAT_QUEUE_LOAD_FAILURE_COPY;
        render();
      }
    })();
    const attachmentLoadGeneration = attachmentGeneration;
    const attachmentLoadTask = refreshAttachments(undefined, attachmentLoadGeneration);
    const planningLoadTask = trackPlanningRequestLoad(
      recoverPlanningRequests().catch(() => {
        if (!disposed) {
          planningRequestsLoaded = false;
          planningRequestError = CHAT_PLANNING_REQUEST_LOAD_FAILURE_COPY;
          render();
        }
      }),
    );
    const task = Promise.all([
      transcriptLoadTask,
      sessionProbeTask,
      loadTask,
      queueLoadTask,
      attachmentLoadTask,
      planningLoadTask,
    ]).then(async () => {
      if (!decisionBlocksWork() && !planCreationBlocksWork()) await drain();
    });
    probeTask = task;
    return task;
  };

  render();
  return {
    start() {
      return start();
    },
    resume() {
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
      droppedAttachmentAdmissions.set(operationId, ownership);
      return true;
    },
    settleDroppedAttachmentAdmission(operationId, results) {
      const ownership = droppedAttachmentAdmissions.get(operationId);
      if (ownership === undefined) return;
      droppedAttachmentAdmissions.delete(operationId);
      if (results !== null && attachmentGenerationIsCurrent(ownership.generation)) {
        receiveAdmissions(results, ownership.generation);
      }
      finishAttachmentWrite(ownership.token);
    },
    async submit(message, attachmentIds = []) {
      await waitForPlanningRequestLoad();
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
            applyQueueSnapshot(acknowledged);
            void drain();
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
      if (disposed || resetBlocksWork() || attachmentBusyTokens.size > 0) return;
      receiveAdmissions(results);
    },
    saveAttachmentDraftText(text) {
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
            attachmentError = null;
            render();
          } catch {
            if (
              !attachmentSurfaceIsCurrent(ownership.generation, surfaceRevision) ||
              textRevision !== attachmentTextRevision
            ) {
              return;
            }
            attachmentError = CHAT_ATTACHMENT_FAILURE_COPY;
            render();
          }
        })
        .finally(() => {
          finishAttachmentWrite(ownership.token);
        });
      attachmentTextSaveTask = task;
    },
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
      render();
      try {
        const result = await (
          await input.clients.getClient()
        ).call("plan_creation.start", {
          commandId: planCommandId("start"),
        });
        pendingPlanCreationCommand = null;
        if (result.status === "started") installPlanCreation(result.planCreation);
        else planCreationError = CHAT_PLAN_CREATION_FAILURE_COPY;
      } catch {
        planCreationError = CHAT_PLAN_CREATION_FAILURE_COPY;
      } finally {
        planCreationBusy = false;
        render();
      }
    },
    async answerPlanCreation(answer) {
      if (disposed || planCreationBusy || planCreation?.openQuestion == null) return;
      const key = JSON.stringify({
        creationId: planCreation.creationId,
        expectedVersion: planCreation.version,
        answer,
      });
      planCreationBusy = true;
      planCreationError = null;
      render();
      try {
        const result = await (
          await input.clients.getClient()
        ).call("plan_creation.answer", {
          commandId: planCommandId(key),
          creationId: planCreation.creationId,
          expectedVersion: planCreation.version,
          answer,
        });
        pendingPlanCreationCommand = null;
        installPlanCreation(result.planCreation);
        if (result.status === "rejected") planCreationError = CHAT_PLAN_CREATION_FAILURE_COPY;
      } catch {
        planCreationError = CHAT_PLAN_CREATION_FAILURE_COPY;
      } finally {
        planCreationBusy = false;
        render();
        if (!planCreationBlocksWork() && !decisionBlocksWork()) void drain();
      }
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
    loadEarlier() {
      return hydrator.loadEarlier();
    },
    retryHydration() {
      return hydrator.retry();
    },
    async retryDecision() {
      if (disposed || decisionLoadTask !== undefined) return decisionLoadTask;
      decisionLoaded = false;
      decisionLoadError = null;
      queueLoadError = null;
      render();
      const task = (async () => {
        try {
          const client = await input.clients.reconnect();
          const [loaded] = await Promise.all([refreshDecision(client), refreshQueue(client)]);
          if (
            loaded?.status === "answered" &&
            loaded.continuation.status === "pending" &&
            decisionContinuationTask === undefined
          ) {
            await continueDecision("resumeCoachDecision", loaded, undefined);
          }
        } catch {
          decisionLoaded = false;
          if (!queueLoaded) queueLoadError = CHAT_QUEUE_LOAD_FAILURE_COPY;
          else decisionLoadError = CHAT_DECISION_LOAD_FAILURE_COPY;
          decisionPhase = "idle";
          render();
        }
      })();
      decisionLoadTask = task;
      await task.finally(() => {
        if (decisionLoadTask === task) decisionLoadTask = undefined;
        render();
        if (!decisionBlocksWork() && !planCreationBlocksWork()) void drain();
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
          attachmentSurface = clearedAttachmentSurface;
          attachmentAdmissions = [];
          attachmentError = null;
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
          updateReset(() => hydrator.resetSucceeded(), {
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
        } finally {
          if (!disposed && epoch === resetEpoch) {
            try {
              void input.refreshSpend().catch(() => {});
            } catch {}
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
    answerDecision(decisionId, answer) {
      if (
        disposed ||
        resetBlocksWork() ||
        decisionContinuationTask !== undefined ||
        decision?.status !== "unanswered" ||
        decision.decisionId !== decisionId
      ) {
        return decisionContinuationTask ?? Promise.resolve();
      }
      return continueDecision("answerCoachDecision", decision, answer);
    },
    async skipDecision(decisionId) {
      if (
        disposed ||
        resetBlocksWork() ||
        decisionContinuationTask !== undefined ||
        decision?.status !== "unanswered" ||
        decision.decisionId !== decisionId
      ) {
        return;
      }
      decisionError = null;
      render();
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
      render();
      if (!decisionBlocksWork() && !planCreationBlocksWork()) void drain();
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
      attachmentWriteTokens.clear();
      attachmentBusyTokens.clear();
      droppedAttachmentAdmissions.clear();
      for (const resolve of attachmentWriteWaiters) resolve();
      attachmentWriteWaiters.clear();
      sequence += 1;
    },
  };
}
