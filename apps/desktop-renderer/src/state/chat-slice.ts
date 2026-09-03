import type {
  AttachmentAdmissionReadModel,
  ChatAttachmentComposerReadModel,
  ChatQueueRecoveryClaim,
  CoachDecisionAnswer,
  CoachDecisionReadModel,
  PlanningRequestDelivery,
  PlanCreationAnswerInput,
  PlanCreationCardModel,
  PlanHandoffSuggestion,
} from "@enduragent/coach-contract";
import type { StateCreator } from "zustand";
import type { TranscriptHydrationChange, TranscriptHydrationStatus } from "../chat/hydration";
import type { FirstSyncState } from "../first-sync";
import type { ChatStatus, ChatTranscriptMessage, SessionResetPhase } from "../turn-state";
import type { EnduragentState } from "./store";

export interface ChatMessageView {
  readonly id: string;
  readonly turnId?: string;
  readonly decisionId?: string;
  readonly role: ChatTranscriptMessage["role"];
  readonly delivery: ChatTranscriptMessage["delivery"];
  readonly historical: boolean;
  readonly text: string;
  readonly attachments?: ChatTranscriptMessage["attachments"];
  readonly planReference?: ChatTranscriptMessage["planReference"];
  readonly planHandoff?: ChatTranscriptMessage["planHandoff"];
}

export interface ChatQueuedView {
  readonly id: string;
  readonly text: string;
  readonly command: boolean;
  readonly restored: boolean;
}

export interface ChatChoiceView {
  readonly id: string;
  readonly label: string;
  readonly consequence: string | null;
  readonly skipped: boolean;
  readonly historical: boolean;
}

export type ChatTranscriptItemView =
  | { readonly kind: "message"; readonly message: ChatMessageView }
  | { readonly kind: "choice"; readonly choice: ChatChoiceView }
  | { readonly kind: "planning-request"; readonly delivery: PlanningRequestDelivery }
  | { readonly kind: "plan-creation"; readonly model: PlanCreationCardModel | null };

export type ChatDecisionPhase = "idle" | "continuing" | "recovering";

export interface ChatSurfaceState {
  readonly messages: readonly ChatMessageView[];
  readonly queued: readonly ChatQueuedView[];
  readonly retryRequired: ChatQueueRecoveryClaim | null;
  readonly decision: CoachDecisionReadModel | null;
  readonly decisionPhase: ChatDecisionPhase;
  readonly decisionAnswerLabel: string | null;
  readonly decisionError: string | null;
  readonly decisionLoadError: string | null;
  readonly queueMutationError?: string | null;
  readonly attachments: ChatAttachmentComposerReadModel | null;
  readonly attachmentAdmissions: readonly AttachmentAdmissionReadModel[];
  readonly attachmentBusy: boolean;
  readonly attachmentError: string | null;
  readonly planningRequests: readonly PlanningRequestDelivery[];
  readonly planningRequestsLoaded: boolean;
  readonly planningRequestBusyId: string | null;
  readonly planningRequestError: string | null;
  readonly planningRequestFocusId: string | null;
  readonly planCreation: PlanCreationCardModel | null;
  readonly planCreationLoaded: boolean;
  readonly planCreationBusy: boolean;
  readonly planCreationError: string | null;
  readonly timeline: readonly ChatTranscriptItemView[];
  readonly status: ChatStatus;
  readonly notice: string | null;
  readonly coachProgress: string | null;
  readonly interrupted: boolean;
  readonly workBlocked: boolean;
  readonly sendDisabled: boolean;
  readonly inputDisabled: boolean;
  readonly newConversationUnavailable: boolean;
  readonly resetPhase: SessionResetPhase;
  readonly resetCount: number;
  readonly announcement: string | null;
  readonly hasHydratedHistory: boolean;
  readonly hydrationStatus: TranscriptHydrationStatus;
  readonly hydrationHasEarlier: boolean;
  readonly hydrationRevision: number;
  readonly hydrationChange: TranscriptHydrationChange;
}

export interface ChatActions {
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
  clearPlanningRequestFocus(): void;
  startPlanCreation(): void;
  answerPlanCreation(answer: PlanCreationAnswerInput): void;
  stop(): void;
  removeQueued(id: string): void;
  runQueuedCommand(id: string): void;
  retryQueuedTurn(claimId: string): void;
  retry(): void;
  loadEarlier(): void;
  retryHydration(): void;
  retryDecision(): void;
  openNewConversation(): void;
  cancelNewConversation(): void;
  confirmNewConversation(): void;
  retryFirstSync(): void;
  answerDecision(decisionId: string, answer: CoachDecisionAnswer): void;
  skipDecision(decisionId: string): void;
}

export const EMPTY_CHAT_SURFACE: ChatSurfaceState = Object.freeze({
  messages: Object.freeze([]),
  queued: Object.freeze([]),
  retryRequired: null,
  decision: null,
  decisionPhase: "idle",
  decisionAnswerLabel: null,
  decisionError: null,
  decisionLoadError: null,
  queueMutationError: null,
  attachments: null,
  attachmentAdmissions: Object.freeze([]),
  attachmentBusy: false,
  attachmentError: null,
  planningRequests: Object.freeze([]),
  planningRequestsLoaded: false,
  planningRequestBusyId: null,
  planningRequestError: null,
  planningRequestFocusId: null,
  planCreation: null,
  planCreationLoaded: false,
  planCreationBusy: false,
  planCreationError: null,
  timeline: Object.freeze([]),
  status: "idle",
  notice: null,
  coachProgress: null,
  interrupted: false,
  workBlocked: false,
  sendDisabled: false,
  inputDisabled: false,
  newConversationUnavailable: true,
  resetPhase: "idle",
  resetCount: 0,
  announcement: null,
  hasHydratedHistory: false,
  hydrationStatus: "idle",
  hydrationHasEarlier: false,
  hydrationRevision: 0,
  hydrationChange: "none",
});

export const IDLE_FIRST_SYNC: FirstSyncState = Object.freeze({ status: "idle" });

export interface ChatSlice {
  readonly chat: ChatSurfaceState;
  readonly chatActions: ChatActions | null;
  readonly firstSync: FirstSyncState;
  setChatSurface: (next: ChatSurfaceState) => void;
  setFirstSync: (next: FirstSyncState) => void;
  bindChatActions: (actions: ChatActions | null) => void;
}

export function sameChatMessages(
  left: readonly ChatMessageView[],
  right: readonly ChatMessageView[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((message, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      message.id === other.id &&
      message.turnId === other.turnId &&
      message.decisionId === other.decisionId &&
      message.role === other.role &&
      message.delivery === other.delivery &&
      message.historical === other.historical &&
      message.text === other.text &&
      JSON.stringify(message.planReference) === JSON.stringify(other.planReference) &&
      JSON.stringify(message.planHandoff) === JSON.stringify(other.planHandoff) &&
      sameAttachments(message.attachments, other.attachments)
    );
  });
}

function sameAttachments(
  left: ChatTranscriptMessage["attachments"],
  right: ChatTranscriptMessage["attachments"],
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined || left.length !== right.length) return false;
  return left.every((attachment, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      attachment.attachmentId === other.attachmentId &&
      attachment.displayName === other.displayName &&
      attachment.kind === other.kind &&
      attachment.extension === other.extension
    );
  });
}

export function sameChatQueued(
  left: readonly ChatQueuedView[],
  right: readonly ChatQueuedView[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((message, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      message.id === other.id &&
      message.text === other.text &&
      message.command === other.command &&
      message.restored === other.restored
    );
  });
}

export function sameChatTimeline(
  left: readonly ChatTranscriptItemView[],
  right: readonly ChatTranscriptItemView[],
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((item, index) => {
    const other = right[index];
    if (other === undefined || item.kind !== other.kind) return false;
    if (item.kind === "message" && other.kind === "message") {
      return sameChatMessages([item.message], [other.message]);
    }
    if (item.kind === "choice" && other.kind === "choice") {
      return (
        item.choice.id === other.choice.id &&
        item.choice.label === other.choice.label &&
        item.choice.consequence === other.choice.consequence &&
        item.choice.skipped === other.choice.skipped &&
        item.choice.historical === other.choice.historical
      );
    }
    if (item.kind === "planning-request" && other.kind === "planning-request") {
      return JSON.stringify(item.delivery) === JSON.stringify(other.delivery);
    }
    if (item.kind === "plan-creation" && other.kind === "plan-creation") {
      return JSON.stringify(item.model) === JSON.stringify(other.model);
    }
    return false;
  });
}

export function sameChatSurface(left: ChatSurfaceState, right: ChatSurfaceState): boolean {
  return (
    left.status === right.status &&
    left.notice === right.notice &&
    left.coachProgress === right.coachProgress &&
    left.interrupted === right.interrupted &&
    left.retryRequired === right.retryRequired &&
    left.decision === right.decision &&
    left.decisionPhase === right.decisionPhase &&
    left.decisionAnswerLabel === right.decisionAnswerLabel &&
    left.decisionError === right.decisionError &&
    left.decisionLoadError === right.decisionLoadError &&
    left.queueMutationError === right.queueMutationError &&
    left.attachments === right.attachments &&
    left.attachmentAdmissions === right.attachmentAdmissions &&
    left.attachmentBusy === right.attachmentBusy &&
    left.attachmentError === right.attachmentError &&
    left.planningRequestsLoaded === right.planningRequestsLoaded &&
    left.planningRequestBusyId === right.planningRequestBusyId &&
    left.planningRequestError === right.planningRequestError &&
    left.planningRequestFocusId === right.planningRequestFocusId &&
    JSON.stringify(left.planningRequests) === JSON.stringify(right.planningRequests) &&
    JSON.stringify(left.planCreation) === JSON.stringify(right.planCreation) &&
    left.planCreationLoaded === right.planCreationLoaded &&
    left.planCreationBusy === right.planCreationBusy &&
    left.planCreationError === right.planCreationError &&
    left.workBlocked === right.workBlocked &&
    left.sendDisabled === right.sendDisabled &&
    left.inputDisabled === right.inputDisabled &&
    left.newConversationUnavailable === right.newConversationUnavailable &&
    left.resetPhase === right.resetPhase &&
    left.resetCount === right.resetCount &&
    left.announcement === right.announcement &&
    left.hasHydratedHistory === right.hasHydratedHistory &&
    left.hydrationStatus === right.hydrationStatus &&
    left.hydrationHasEarlier === right.hydrationHasEarlier &&
    left.hydrationRevision === right.hydrationRevision &&
    left.hydrationChange === right.hydrationChange &&
    sameChatQueued(left.queued, right.queued) &&
    sameChatTimeline(left.timeline, right.timeline) &&
    sameChatMessages(left.messages, right.messages)
  );
}

export const createChatSlice: StateCreator<EnduragentState, [], [], ChatSlice> = (set) => ({
  chat: EMPTY_CHAT_SURFACE,
  chatActions: null,
  firstSync: IDLE_FIRST_SYNC,
  setChatSurface(next) {
    set({ chat: next });
  },
  setFirstSync(next) {
    set({ firstSync: next });
  },
  bindChatActions(actions) {
    set({ chatActions: actions });
  },
});
