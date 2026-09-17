import type { CoachDecisionReadModel, TranscriptPageEntry } from "@enduragent/coach-contract";
import {
  CHAT_SEND_CONNECTING_COPY,
  type ChatView,
  type ChatViewControls,
  type PlanCreationDiscardEvent,
} from "../../chat/controller";
import type { ChatState, WireMessage } from "../../chat/message-state";
import {
  EMPTY_CHAT_SURFACE,
  sameChatMessages,
  sameChatTimeline,
  sameChatQueued,
  sameChatSurface,
  type ChatMessageView,
  type ChatChoiceView,
  type ChatTranscriptItemView,
  type ChatQueuedView,
  type ChatSurfaceState,
} from "../chat-slice";
import {
  chatScrollAnchor,
  chatStreamBuffer,
  type ChatScrollAnchor,
  type ChatStreamBuffer,
} from "../chat-stream";
import { CHAT_RESPONSE_STOPPED_COPY } from "../../turn-state";

type StreamAction =
  | { readonly kind: "append"; readonly messageId: string; readonly delta: string }
  | { readonly kind: "set"; readonly messageId: string; readonly text: string };

export interface ChatViewAdapter {
  readonly view: ChatView;
}

function isStreamingCoach(message: { readonly role: string; readonly delivery: string }): boolean {
  return message.role === "coach" && message.delivery === "streaming";
}

function hasVisibleText(text: string): boolean {
  return /\S/u.test(text);
}

function historyAthleteId(turnId: string): string {
  return `history:athlete:${turnId}`;
}

function recoveredTurnId(state: ChatState): string | null {
  return state.retryRequired?.turnId ?? state.activeTurn?.turnId ?? null;
}

function claimedQueuedText(state: ChatState): ReadonlySet<string> {
  const claimed = new Set(state.retryRequired?.queuedMessageIds ?? []);
  return new Set(state.queued.filter((item) => claimed.has(item.id)).map((item) => item.text));
}

function athleteIdForRecovery(
  state: ChatState,
  entries: readonly TranscriptPageEntry[],
): string | null {
  if (state.activeTurn?.userMessageId != null) return state.activeTurn.userMessageId;
  const turnId = recoveredTurnId(state);
  const claimedText = claimedQueuedText(state);
  let claimedMatch: string | null = null;
  let turnMatch: string | null = null;
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    const message = state.messages[index];
    if (message === undefined || message.role !== "athlete") continue;
    if (turnId !== null && (message.turnId === turnId || message.id === historyAthleteId(turnId))) {
      turnMatch ??= message.id;
    }
    if (claimedText.has(message.text)) claimedMatch ??= message.id;
  }
  if (turnMatch !== null) return turnMatch;
  if (claimedMatch !== null) return claimedMatch;
  if (turnId === null) return null;
  const entry = [...entries]
    .reverse()
    .find(
      (item): item is Extract<TranscriptPageEntry, { readonly kind: "turn" }> =>
        item.kind === "turn" && item.turnId === turnId,
    );
  if (
    entry !== undefined &&
    (hasVisibleText(entry.athleteText) || (entry.attachments?.length ?? 0) > 0)
  ) {
    return historyAthleteId(turnId);
  }
  return null;
}

function coachHasVisibleText(state: ChatState, entries: readonly TranscriptPageEntry[]): boolean {
  const assistantId = state.activeTurn?.assistantMessageId;
  if (assistantId !== undefined) {
    const assistant = state.messages.find((message) => message.id === assistantId);
    if (assistant !== undefined) return hasVisibleText(assistant.text);
  }
  const turnId = recoveredTurnId(state);
  if (
    state.messages.some(
      (message) =>
        message.role === "coach" &&
        hasVisibleText(message.text) &&
        (turnId === null ||
          message.turnId === turnId ||
          message.id.startsWith(`history:coach:${turnId}`)),
    )
  ) {
    return true;
  }
  return (
    turnId !== null &&
    entries.some(
      (entry) =>
        entry.kind === "turn" && entry.turnId === turnId && hasVisibleText(entry.coachText),
    )
  );
}

type TurnRecovery = {
  readonly messageId: string | null;
  readonly messageError: string | null;
  readonly messageErrorMessage: WireMessage | undefined;
  readonly notice: string | null;
  readonly noticeTone: "danger" | "neutral";
  readonly noticeMessage: WireMessage | undefined;
  readonly noticeRetry: boolean;
};

function stampRecoveredMessage(message: ChatMessageView, recovery: TurnRecovery): ChatMessageView {
  if (recovery.messageId !== message.id) return message;
  return {
    ...message,
    retry: true,
    ...(recovery.messageError == null ? {} : { error: recovery.messageError }),
    ...(recovery.messageErrorMessage === undefined
      ? {}
      : { errorMessage: recovery.messageErrorMessage }),
  };
}

function stampRecoveredTimeline(
  timeline: readonly ChatTranscriptItemView[],
  recovery: TurnRecovery,
): readonly ChatTranscriptItemView[] {
  if (recovery.messageId == null) return timeline;
  return timeline.map((item) =>
    item.kind === "message"
      ? { kind: "message", message: stampRecoveredMessage(item.message, recovery) }
      : item,
  );
}

function projectTurnRecovery(
  state: ChatState,
  input: {
    readonly decisionBlocksWork: boolean;
    readonly planActivated: boolean;
    readonly planNotice: string | null | undefined;
    readonly planError: string | null | undefined;
    readonly planValueMissing: boolean;
    readonly entries: readonly TranscriptPageEntry[];
  },
): TurnRecovery {
  const empty: TurnRecovery = {
    messageId: null,
    messageError: null,
    messageErrorMessage: undefined,
    notice: null,
    noticeTone: "neutral",
    noticeMessage: undefined,
    noticeRetry: false,
  };
  const planDanger = input.planNotice == null && input.planValueMissing && input.planError != null;
  const planNotice = input.planActivated
    ? null
    : (input.planNotice ?? (input.planValueMissing ? (input.planError ?? null) : null));
  if (input.decisionBlocksWork) return empty;
  const turnError = state.activeTurn?.error ?? null;
  const errorNotice: Pick<TurnRecovery, "notice" | "noticeTone" | "noticeMessage"> = {
    notice: turnError?.athleteMessage ?? planNotice ?? null,
    noticeTone: turnError != null || planDanger ? "danger" : "neutral",
    noticeMessage: turnError?.message,
  };
  if (state.status === "streaming") {
    return { ...empty, ...errorNotice };
  }
  const offered = state.retryRequired != null || state.status === "interrupted";
  const athleteId = athleteIdForRecovery(state, input.entries);
  if (offered && athleteId != null && !coachHasVisibleText(state, input.entries)) {
    return {
      messageId: athleteId,
      messageError: turnError?.athleteMessage ?? null,
      messageErrorMessage: turnError?.message,
      notice: planNotice,
      noticeTone: planDanger ? "danger" : "neutral",
      noticeMessage: undefined,
      noticeRetry: false,
    };
  }
  return {
    ...empty,
    ...errorNotice,
    notice:
      turnError?.athleteMessage ??
      planNotice ??
      state.progress ??
      (offered ? CHAT_RESPONSE_STOPPED_COPY : null),
    noticeRetry: offered,
  };
}

function choiceFromDecision(
  decision: CoachDecisionReadModel,
  historical: boolean,
): ChatChoiceView | null {
  if (decision.status === "skipped") {
    return {
      id: decision.decisionId,
      label: "Question skipped",
      consequence: "No coaching choice was applied.",
      skipped: true,
      historical,
    };
  }
  if (decision.status !== "answered" || decision.continuation.status !== "completed") return null;
  const answer = decision.answer;
  const label =
    answer.kind === "custom"
      ? answer.text
      : (decision.options.find((option) => option.id === answer.optionId)?.label ?? "Saved choice");
  return {
    id: decision.decisionId,
    label,
    consequence: answer.kind === "custom" ? null : decision.consequence,
    skipped: false,
    historical,
  };
}

function historicalTimeline(
  entries: readonly TranscriptPageEntry[],
  liveDecisionIds: ReadonlySet<string>,
): readonly ChatTranscriptItemView[] {
  const requested = new Map<string, CoachDecisionReadModel>();
  const answered = new Map<
    string,
    Extract<TranscriptPageEntry, { readonly kind: "decision-answered" }>
  >();
  const turnAttempts = new Map<string, number>();
  const timeline: ChatTranscriptItemView[] = [];
  for (const entry of entries) {
    if (entry.kind === "turn") {
      const attempt = (turnAttempts.get(entry.turnId) ?? 0) + 1;
      turnAttempts.set(entry.turnId, attempt);
      if (
        attempt === 1 &&
        (hasVisibleText(entry.athleteText) || (entry.attachments?.length ?? 0) > 0)
      ) {
        timeline.push({
          kind: "message",
          message: {
            id: historyAthleteId(entry.turnId),
            occurredAtMs: Date.parse(entry.completedAt),
            turnId: entry.turnId,
            role: "athlete",
            delivery: "complete",
            historical: true,
            text: entry.athleteText,
            ...(entry.attachments === undefined ? {} : { attachments: entry.attachments }),
          },
        });
      }
      timeline.push({
        kind: "message",
        message: {
          id:
            attempt === 1
              ? `history:coach:${entry.turnId}`
              : `history:coach:${entry.turnId}:attempt:${attempt}`,
          occurredAtMs: Date.parse(entry.completedAt),
          turnId: entry.turnId,
          role: "coach",
          delivery: entry.delivery ?? "complete",
          historical: true,
          text: entry.coachText,
          ...(entry.planReference === undefined ? {} : { planReference: entry.planReference }),
          ...(entry.planHandoff === undefined ? {} : { planHandoff: entry.planHandoff }),
        },
      });
      continue;
    }
    const decisionId =
      entry.kind === "decision-requested" ? entry.decision.decisionId : entry.decisionId;
    if (liveDecisionIds.has(decisionId)) continue;
    if (entry.kind === "decision-requested") {
      requested.set(entry.decision.decisionId, entry.decision);
      if (/\S/u.test(entry.athleteText)) {
        timeline.push({
          kind: "message",
          message: {
            id: `history:decision-athlete:${entry.decision.decisionId}`,
            occurredAtMs: Date.parse(entry.recordedAt),
            role: "athlete",
            delivery: "complete",
            historical: true,
            text: entry.athleteText,
          },
        });
      }
      continue;
    }
    if (entry.kind === "decision-answered") {
      answered.set(JSON.stringify([entry.decisionId, entry.continuationId]), entry);
      continue;
    }
    if (entry.kind === "decision-skipped") {
      timeline.push({
        kind: "choice",
        choice: {
          id: entry.decisionId,
          occurredAtMs: Date.parse(entry.recordedAt),
          label: "Question skipped",
          consequence: "No coaching choice was applied.",
          skipped: true,
          historical: true,
        },
      });
      continue;
    }
    if (entry.kind === "decision-continuation-completed") {
      const savedAnswer = answered.get(JSON.stringify([entry.decisionId, entry.continuationId]));
      if (savedAnswer !== undefined) {
        const source = requested.get(entry.decisionId);
        const answer = savedAnswer.answer;
        const label =
          answer.kind === "custom"
            ? answer.text
            : (source?.options.find((option) => option.id === answer.optionId)?.label ??
              "Saved choice");
        timeline.push({
          kind: "choice",
          choice: {
            id: entry.decisionId,
            occurredAtMs: Date.parse(savedAnswer.recordedAt),
            label,
            consequence: answer.kind === "custom" ? null : savedAnswer.consequence,
            skipped: false,
            historical: true,
          },
        });
      }
      if (!/\S/u.test(entry.coachText)) continue;
      timeline.push({
        kind: "message",
        message: {
          id: `history:decision-coach:${entry.continuationId}`,
          occurredAtMs: Date.parse(entry.completedAt),
          turnId: entry.turnId,
          role: "coach",
          delivery: "complete",
          historical: true,
          text: entry.coachText,
        },
      });
    }
  }
  return timeline;
}

function conversationTimelineWithDiscardEvents(
  historicalItems: readonly ChatTranscriptItemView[],
  liveItems: readonly ChatTranscriptItemView[],
  events: readonly PlanCreationDiscardEvent[],
  planCreationItems: readonly ChatTranscriptItemView[],
): readonly ChatTranscriptItemView[] {
  const appended = new Set<string>();
  const timeline: ChatTranscriptItemView[] = [];
  const appendEvents = (afterMessageId: string | null): void => {
    for (const event of events) {
      if (event.afterMessageId !== afterMessageId || appended.has(event.eventId)) continue;
      timeline.push({ kind: "plan-creation-discard", eventId: event.eventId });
      appended.add(event.eventId);
    }
  };
  const appendItems = (items: readonly ChatTranscriptItemView[]): void => {
    for (const item of items) {
      timeline.push(item);
      if (item.kind === "message") appendEvents(item.message.id);
    }
  };
  appendItems(historicalItems);
  appendEvents(null);
  timeline.push(...planCreationItems);
  appendItems(liveItems);
  for (const event of events) {
    if (appended.has(event.eventId)) continue;
    timeline.push({ kind: "plan-creation-discard", eventId: event.eventId });
  }
  return timeline;
}

export function createChatViewAdapter(input: {
  readonly publish: (next: ChatSurfaceState) => void;
  readonly buffer?: ChatStreamBuffer;
  readonly anchor?: ChatScrollAnchor;
  readonly bufferStreaming?: boolean;
}): ChatViewAdapter {
  const buffer = input.buffer ?? chatStreamBuffer;
  const anchor = input.anchor ?? chatScrollAnchor;
  let published = EMPTY_CHAT_SURFACE;

  const project = (state: ChatState, controls: ChatViewControls | undefined): ChatSurfaceState => {
    const hydration = controls?.hydration;
    const decision = controls?.decision;
    const planCreation = controls?.planCreation;
    const planActivated = planCreation?.notice === "Plan activated locally.";
    const decisionBlocksWork =
      decision?.value?.status === "unanswered" ||
      (decision?.value?.status === "answered" && decision.value.continuation.status === "pending");
    const recovery = projectTurnRecovery(state, {
      decisionBlocksWork,
      planActivated,
      planNotice: planCreation?.notice,
      planError: planCreation?.error,
      planValueMissing: planCreation?.value == null,
      entries: hydration?.entries ?? [],
    });
    const visible = state.messages.filter(
      (message) => message.role === "athlete" || message.text.length > 0,
    );
    const messages: readonly ChatMessageView[] = visible.map((message) =>
      stampRecoveredMessage(
        {
          id: message.id,
          ...(message.occurredAtMs === undefined ? {} : { occurredAtMs: message.occurredAtMs }),
          ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
          ...(message.decisionId === undefined ? {} : { decisionId: message.decisionId }),
          role: message.role,
          delivery: message.delivery,
          historical: message.historical === true,
          text:
            input.bufferStreaming !== false &&
            isStreamingCoach(message) &&
            message.message === undefined
              ? ""
              : message.text,
          ...(message.message === undefined ? {} : { message: message.message }),
          ...(message.attachments === undefined ? {} : { attachments: message.attachments }),
          ...(message.planReference === undefined ? {} : { planReference: message.planReference }),
          ...(message.planHandoff === undefined ? {} : { planHandoff: message.planHandoff }),
        },
        recovery,
      ),
    );
    const workBlocked =
      controls?.workBlocked ??
      (state.session.resetPhase === "confirming" || state.session.resetPhase === "resetting");
    const newConversationUnavailable =
      controls?.newConversationDisabled ??
      (state.session.presence !== "present" ||
        state.session.resetPhase !== "idle" ||
        state.status === "streaming");
    const claimed = new Set(state.retryRequired?.queuedMessageIds ?? []);
    const queued: readonly ChatQueuedView[] = state.queued
      .filter((message) => !claimed.has(message.id))
      .map((message) => ({
        id: message.id,
        text: message.text,
        command: message.command,
        restored: message.restored === true,
      }));
    const liveDecisionIds = new Set(
      messages.flatMap((message) => (message.decisionId === undefined ? [] : [message.decisionId])),
    );
    const historicalItems = historicalTimeline(hydration?.entries ?? [], liveDecisionIds);
    const historicalMessageIds = new Set(
      historicalItems.flatMap((item) => (item.kind === "message" ? [item.message.id] : [])),
    );
    const liveItems: ChatTranscriptItemView[] = messages
      .filter((message) => !historicalMessageIds.has(message.id))
      .map((message) => ({ kind: "message", message }));
    const liveChoice =
      decision?.value === null || decision === undefined
        ? null
        : choiceFromDecision(decision.value, false);
    if (liveChoice !== null) {
      const duplicate = historicalItems.findIndex(
        (item) => item.kind === "choice" && item.choice.id === liveChoice.id,
      );
      if (duplicate === -1) {
        const continuationTurnId =
          decision?.value?.status === "answered" &&
          decision.value.continuation.status === "completed"
            ? decision.value.continuation.turnId
            : null;
        const continuationIndex = liveItems.findIndex(
          (item) =>
            item.kind === "message" &&
            item.message.role === "coach" &&
            item.message.turnId === continuationTurnId,
        );
        const choiceItem: ChatTranscriptItemView = { kind: "choice", choice: liveChoice };
        if (continuationIndex === -1) liveItems.push(choiceItem);
        else liveItems.splice(continuationIndex, 0, choiceItem);
      }
    }
    const planningRequests =
      controls?.planningRequests?.value ?? EMPTY_CHAT_SURFACE.planningRequests;
    const planningItems: ChatTranscriptItemView[] = planningRequests
      .filter((delivery) => delivery.state !== "cancelled")
      .map((delivery) => ({ kind: "planning-request", delivery }));
    const planCreationItems: readonly ChatTranscriptItemView[] =
      planCreation?.loaded === true && (planCreation.value !== null || planActivated)
        ? [{ kind: "plan-creation", model: planCreation.value }]
        : [];
    const conversationItems = conversationTimelineWithDiscardEvents(
      historicalItems,
      liveItems,
      planCreation?.discardEvents ?? [],
      planCreationItems,
    );
    const timeline = stampRecoveredTimeline([...conversationItems, ...planningItems], recovery);
    const planCreationPaused = planCreation?.paused ?? false;
    const planCreationEditingKey = planCreation?.editingKey ?? null;
    const planCreationBlocksWork =
      planCreation?.discardConfirmationOpen === true ||
      planCreation?.activateConfirmationOpen === true ||
      (!planCreationPaused &&
        planCreation?.value !== null &&
        planCreation?.value !== undefined &&
        planCreation.value.pendingCommitment === null &&
        planCreationEditingKey !== "commitments" &&
        !(
          planCreationEditingKey === null &&
          planCreation.value.openQuestion?.kind === "commitments-question"
        ) &&
        (planCreationEditingKey !== null || planCreation.value.openQuestion !== null));
    const pendingCheckDocked =
      !planCreationPaused &&
      (planCreation?.value?.pendingCommitment != null ||
        planCreation?.value?.pendingCheck != null) &&
      planCreationEditingKey === null;
    const decisionLoading = controls?.decisionLoading === true;
    const decisionLoadError = controls?.queueLoadError ?? controls?.decisionLoadError ?? null;
    const decisionUnavailable = decisionLoading || decisionLoadError !== null;
    const attachments = controls?.attachments;
    const attachmentDraft = attachments?.value?.draft;
    const attachmentUnavailable =
      attachments?.busy === true ||
      (attachments?.admissions.length ?? 0) > 0 ||
      (attachmentDraft?.attachments.some(
        (attachment) =>
          attachment.status !== "ready" ||
          (attachment.preview.kind === "workout" && attachment.preview.selectedWorkoutId === null),
      ) ??
        false) ||
      ((attachmentDraft?.attachments.length ?? 0) > 0 &&
        /^\s*\//u.test(attachmentDraft?.text ?? ""));
    return {
      messages: sameChatMessages(published.messages, messages) ? published.messages : messages,
      queued: sameChatQueued(published.queued, queued) ? published.queued : queued,
      retryRequired: state.retryRequired ?? null,
      decision: decision?.value ?? null,
      decisionPhase: decision?.phase ?? "idle",
      decisionAnswerLabel: decision?.answerLabel ?? null,
      decisionError: decision?.error ?? null,
      decisionLoadError,
      queueMutationError: controls?.queueMutationError ?? null,
      attachments: attachments?.value ?? null,
      attachmentAdmissions: attachments?.admissions ?? EMPTY_CHAT_SURFACE.attachmentAdmissions,
      attachmentBusy: attachments?.busy ?? false,
      draftError: attachments?.draftError ?? null,
      attachmentError: attachments?.error ?? null,
      planningRequests,
      planningRequestsLoaded: controls?.planningRequests?.loaded ?? false,
      planningRequestBusyId: controls?.planningRequests?.busyId ?? null,
      planningRequestError: controls?.planningRequests?.error ?? null,
      planningRequestFocusId: controls?.planningRequests?.focusId ?? null,
      planCreation: planCreation?.value ?? null,
      planCreationLoaded: planCreation?.loaded ?? false,
      planCreationBusy: planCreation?.busy ?? false,
      planCreationError: planCreation?.error ?? null,
      planCreationPaused,
      planCreationEditingKey,
      planCreationFocusRevision: planCreation?.focusRevision ?? 0,
      planCreationDiscardConfirmationOpen: planCreation?.discardConfirmationOpen ?? false,
      planCreationActivateConfirmationOpen: planCreation?.activateConfirmationOpen ?? false,
      planCreationActivePlanKnowledge:
        planCreation?.activePlanKnowledge ?? EMPTY_CHAT_SURFACE.planCreationActivePlanKnowledge,
      planCreationFocusRequest: planCreation?.focusRequest ?? null,
      timeline: sameChatTimeline(published.timeline, timeline) ? published.timeline : timeline,
      status: state.status,
      noticeMessage: recovery.noticeMessage,
      notice: recovery.notice,
      noticeTone: recovery.noticeTone,
      noticeRetry: recovery.noticeRetry,
      coachProgress:
        state.status === "streaming" && state.activeTurn?.error === null ? state.progress : null,
      interrupted: state.status === "interrupted" && !decisionBlocksWork && !planCreationBlocksWork,
      workBlocked,
      sendDisabled:
        workBlocked ||
        decisionBlocksWork ||
        decisionUnavailable ||
        attachmentUnavailable ||
        planCreationBlocksWork ||
        pendingCheckDocked,
      inputDisabled: workBlocked || planCreationBlocksWork || pendingCheckDocked,
      composerPlaceholder: pendingCheckDocked
        ? "Finish the correction above"
        : planCreationBlocksWork
          ? "Finish the Plan question above"
          : "Message your coach",
      composerStatus:
        decisionLoading &&
        decisionLoadError === null &&
        !workBlocked &&
        !decisionBlocksWork &&
        !attachmentUnavailable &&
        !planCreationBlocksWork &&
        !pendingCheckDocked
          ? CHAT_SEND_CONNECTING_COPY
          : null,
      newConversationUnavailable: newConversationUnavailable || decisionUnavailable,
      resetPhase: state.session.resetPhase,
      resetCount: state.session.resetCount,
      announcement: state.session.announcement,
      hasHydratedHistory: messages.some((message) => message.historical),
      hydrationStatus: hydration?.status ?? "idle",
      hydrationHasEarlier: hydration?.hasEarlier ?? false,
      hydrationRevision: hydration?.revision ?? 0,
      hydrationChange: hydration?.change ?? "none",
    };
  };

  const planStream = (
    state: ChatState,
    controls: ChatViewControls | undefined,
  ): { readonly action: StreamAction | null; readonly streaming: ReadonlySet<string> } => {
    const streaming = new Set<string>();
    let action: StreamAction | null = null;
    for (const message of state.messages) {
      if (!isStreamingCoach(message) || message.text.length === 0) continue;
      streaming.add(message.id);
      const buffered = buffer.read(message.id);
      const appendDelta = controls?.appendDelta;
      if (
        appendDelta !== undefined &&
        appendDelta.messageId === message.id &&
        appendDelta.previousTextLength === buffered.length &&
        appendDelta.nextTextLength === message.text.length &&
        appendDelta.nextTextLength === appendDelta.previousTextLength + appendDelta.delta.length
      ) {
        action = { kind: "append", messageId: message.id, delta: appendDelta.delta };
      } else if (buffered !== message.text) {
        action = { kind: "set", messageId: message.id, text: message.text };
      }
    }
    return { action, streaming };
  };

  return {
    view: {
      render(state, controls) {
        const identifiers = new Set(state.messages.map((message) => message.id));
        if (identifiers.size !== state.messages.length) {
          throw new TypeError("duplicate chat message id");
        }
        const next = project(state, controls);
        const { action, streaming } = planStream(state, controls);
        const changed = !sameChatSurface(published, next);
        if (!changed && action === null) return;
        anchor.capture();
        if (action?.kind === "append") buffer.append(action.messageId, action.delta);
        else if (action?.kind === "set") buffer.set(action.messageId, action.text);
        buffer.retain(streaming);
        if (!changed) {
          anchor.apply({ hydrationChanged: false, hydrationChange: "none" });
          return;
        }
        published = next;
        input.publish(next);
      },
    },
  };
}
