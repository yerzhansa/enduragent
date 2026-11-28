import {
  PLAN_CREATION_ANSWER_KEYS,
  type AttachmentAdmissionReadModel,
  type ChatAttachmentComposerReadModel,
  type CoachDecisionAnswer,
  type CoachDecisionReadModel,
  type CreatePlanningRequestRpcParams,
  type CreateWorkoutPlanningRequestRpcParams,
  type PlanChangeIntent,
  type PlanChangeRequest,
  type PlanCreationAnswerInput,
  type PlanCreationAnswerSummary,
  type PlanCreationCardModel,
  type PlanCreationOpenQuestion,
  type PlanHandoffSuggestion,
  type PlanningRequestDelivery,
  type TranscriptPageEntry,
} from "@enduragent/coach-contract";
import type { NewConversationCheck } from "../turn-state";
import type { TranscriptHydrationChange, TranscriptHydrationStatus } from "./hydration";
import type { ChatState } from "./message-state";

export type ActivePlanKnowledge =
  | { readonly kind: "unknown" }
  | { readonly kind: "none" }
  | { readonly kind: "active"; readonly name: string };

export const DROPPED_ATTACHMENT_ADMISSION_TIMEOUT_MS = 30_000;
export const PLAN_CHANGE_TEXT_LENGTH_COPY = "Keep your change request to 2000 characters or fewer.";

export const CHAT_PLAN_CREATION_CONTINUE_MISSING_COPY =
  "This creation is no longer unfinished. Open the Plan library for its current result.";
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
export const CHAT_DRAFT_SAVE_FAILURE_COPY =
  "Couldn’t reach the coach, so your message is still in the box.";
export const CHAT_SEND_CONNECTING_COPY = "Chat is still connecting, so Send isn’t ready yet.";
export const CHAT_PLANNING_REQUEST_LOAD_FAILURE_COPY =
  "We couldn’t check saved Plan requests. Reconnect and try again.";
export const CHAT_PLANNING_REQUEST_FAILURE_COPY =
  "Plan couldn’t receive this request. Your request is preserved and nothing changed in Plan.";
export const CHAT_PLAN_CREATION_FAILURE_COPY = "Plan Creation couldn’t save that. Try again.";
export const CHAT_PLAN_CREATION_DISCARD_STALE_COPY =
  "Plan Creation changed before it could be discarded. The latest version is shown.";
export const CHAT_PLAN_CREATION_DISCARD_CONFLICT_COPY =
  "Plan Creation wasn’t discarded. Try again.";
export const CHAT_PLAN_CREATION_DISCARD_MISSING_COPY =
  "There is no unfinished Plan Creation to discard.";
export const NEW_CONVERSATION_SUCCESS_COPY = "New conversation started.";
export const NEW_CONVERSATION_MEMORY_WARNING_COPY =
  "New conversation started. Some recent details may not have been saved to coach memory.";
export const NEW_CONVERSATION_UNCERTAIN_COPY =
  "We couldn’t confirm whether the new conversation started. Your visible conversation is preserved.";
export const NEW_CONVERSATION_NOT_STARTED_COPY =
  "The new conversation didn’t start. Your conversation is unchanged.";
export const FEEDBACK_USAGE_COPY = "Send /feedback followed by your note.";
export const FEEDBACK_TOO_LONG_COPY =
  "Keep your note to 4000 characters or fewer. Nothing was sent.";
export const FEEDBACK_SENT_COPY = "Thanks — we received your note.";
export const FEEDBACK_FAILED_COPY = "Couldn't send that note. It's still in the box — try again.";

export interface QueuedRetry {
  readonly requestKey: number;
  readonly promise: Promise<void>;
  readonly token: object;
}

export type ChatQueueCall =
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

export interface InterruptedQueueOrigin {
  readonly requestKey: number;
  readonly call: ChatQueueCall;
}

export interface ChatRun {
  readonly task: Promise<void>;
  allowInterruptedDrain(): boolean;
}

export type BootProbeStatus = "idle" | "succeeded" | "failed";

export interface ActiveStopRequest {
  readonly requestKey: number;
  request(): void;
}

export type PendingPlanningRequestCreate =
  | {
      readonly kind: "generic";
      readonly request: CreatePlanningRequestRpcParams;
    }
  | {
      readonly kind: "workout";
      readonly request: CreateWorkoutPlanningRequestRpcParams;
    };

export interface ChatAppendDelta {
  readonly messageId: string;
  readonly previousTextLength: number;
  readonly nextTextLength: number;
  readonly delta: string;
}

export interface PlanCreationDiscardEvent {
  readonly eventId: string;
  readonly afterMessageId: string | null;
}

export interface ChatViewControls {
  readonly newConversationDisabled: boolean;
  readonly newConversationCheck?: NewConversationCheck;
  readonly workBlocked: boolean;
  readonly decisionLoading?: boolean;
  readonly decisionLoadError?: string | null;
  readonly queueLoadError?: string | null;
  readonly queueMutationError?: string | null;
  readonly attachments?: {
    readonly value: ChatAttachmentComposerReadModel | null;
    readonly admissions: readonly AttachmentAdmissionReadModel[];
    readonly busy: boolean;
    readonly draftError: string | null;
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
    readonly paused: boolean;
    readonly editingKey: PlanCreationAnswerSummary["answerKey"] | null;
    readonly focusRevision: number;
    readonly discardConfirmationOpen: boolean;
    readonly activateConfirmationOpen: boolean;
    readonly activePlanKnowledge: ActivePlanKnowledge;
    readonly discardEvents: readonly PlanCreationDiscardEvent[];
    readonly notice: string | null;
    readonly focusRequest: {
      readonly target:
        | "discard"
        | "activate"
        | "edit"
        | "start"
        | "continue"
        | "change"
        | "composer";
      readonly libraryTarget?: "continue" | "change";
      readonly revision: number;
    } | null;
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
  openPlanChangeEditor(): void;
  backFromPlanChangeEditor(): void;
  previewPlanChange(
    intent: PlanChangeIntent | Extract<PlanChangeRequest, { kind: "text" | "check-action" }>,
  ): Promise<void>;
  applyPlanChange(decision: "apply" | "cancel"): Promise<void>;
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
  requestPlanLibraryFocus(target: "continue" | "change"): void;
  resumeCreation(model: PlanCreationCardModel | null): void;
  continueCreationFromLibrary(creationId: string): Promise<void>;
  startPlanCreation(): Promise<void>;
  answerPlanCreation(answer: PlanCreationAnswerInput): Promise<void>;
  buildPlanCreationDraft(): Promise<void>;
  pausePlanCreation(): void;
  continuePlanCreation(): void;
  editPlanCreation(answerKey: PlanCreationAnswerSummary["answerKey"]): void;
  cancelPlanCreationEdit(returnFocus?: "edit"): void;
  openPlanCreationDiscard(): void;
  cancelPlanCreationDiscard(): void;
  confirmPlanCreationDiscard(): Promise<void>;
  openPlanCreationActivate(): Promise<void>;
  cancelPlanCreationActivate(): void;
  confirmPlanCreationActivate(): Promise<void>;
  stop(): void;
  removeQueued(id: string): void;
  runQueuedCommand(id: string): Promise<void>;
  retryQueuedTurn(claimId: string): Promise<void>;
  retryInterrupted(): Promise<void>;
  retry(): Promise<void>;
  discardRetry(): Promise<void>;
  loadEarlier(): Promise<void>;
  retryHydration(): Promise<void>;
  retryDecision(): Promise<void>;
  openNewConversation(): boolean;
  cancelNewConversation(): void;
  confirmNewConversation(): Promise<void>;
  checkNewConversation(): Promise<void>;
  answerDecision(decisionId: string, answer: CoachDecisionAnswer): Promise<void>;
  skipDecision(decisionId: string): Promise<void>;
  dispose(): void;
}

const PLAN_CREATION_PAUSE_STORAGE_KEY = "enduragent.plan-creation.pause";

export interface PlanCreationPauseIdentity {
  readonly creationId: string;
  readonly answerKey: PlanCreationAnswerSummary["answerKey"];
}

export function reportBestEffortSync(event: string, operation: () => void): void {
  try {
    operation();
  } catch {
    console.error(event);
  }
}

export async function reportBestEffortAsync(
  event: string,
  operation: () => Promise<unknown> | undefined,
): Promise<void> {
  try {
    const task = operation();
    if (task === undefined) return;
    await task;
  } catch {
    console.error(event);
  }
}

function pauseStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function readPlanCreationPause(): PlanCreationPauseIdentity | null {
  try {
    const value = pauseStorage()?.getItem(PLAN_CREATION_PAUSE_STORAGE_KEY);
    if (value === undefined || value === null) return null;
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      typeof parsed.creationId !== "string" ||
      typeof parsed.answerKey !== "string" ||
      !(PLAN_CREATION_ANSWER_KEYS as readonly string[]).includes(parsed.answerKey)
    ) {
      return null;
    }
    return {
      creationId: parsed.creationId,
      answerKey: parsed.answerKey as PlanCreationAnswerSummary["answerKey"],
    };
  } catch {
    return null;
  }
}

export function writePlanCreationPause(identity: PlanCreationPauseIdentity): void {
  reportBestEffortSync("desktop-chat-pause-storage-write-failed", () => {
    pauseStorage()?.setItem(PLAN_CREATION_PAUSE_STORAGE_KEY, JSON.stringify(identity));
  });
}

export function clearPlanCreationPause(): void {
  reportBestEffortSync("desktop-chat-pause-storage-clear-failed", () => {
    pauseStorage()?.removeItem(PLAN_CREATION_PAUSE_STORAGE_KEY);
  });
}

export function planCreationQuestionKey(
  question: PlanCreationOpenQuestion,
): PlanCreationAnswerSummary["answerKey"] {
  return question.kind.replace(/-question$/u, "") as PlanCreationAnswerSummary["answerKey"];
}

export function planChangeParameterCopy(
  intent: PlanChangeIntent | Extract<PlanChangeRequest, { kind: "text" | "check-action" }>,
): string {
  if (intent.kind === "text") return PLAN_CHANGE_TEXT_LENGTH_COPY;
  if (intent.kind === "choose-workout") return "This Workout is no longer eligible.";
  if (intent.kind === "ftp") return "Enter FTP above zero.";
  if (intent.kind === "supporting-event") {
    return "eventId" in intent && !intent.eventId.trim()
      ? "Choose a Supporting Event already accepted in this Plan."
      : "Enter the event name and exact date.";
  }
  if (intent.kind === "weekly-duration") {
    return Number.isFinite(intent.hours) && intent.hours > 0 && !Number.isInteger(intent.hours * 4)
      ? "Enter weekly hours in quarter-hour steps, like 2.25."
      : "Enter a weekly duration above zero.";
  }
  if ("day" in intent && (!Number.isInteger(intent.day) || intent.day < 1 || intent.day > 7)) {
    return "Choose the weekday to change.";
  }
  if (intent.kind === "weekday-unavailable" || intent.kind === "hard-weekday") {
    return "Choose the weekday to change.";
  }
  return "Enter a duration above zero.";
}

export function planChangeApplyRejectionCopy(reason: string): string {
  if (reason === "day-changed") {
    return "The day changed while this choice was open. Request a fresh choice for today; no date was assigned.";
  }
  if (reason === "not-eligible") return "This Workout is no longer eligible.";
  if (reason === "event-source-changed") {
    return "The synchronized event changed. Request a fresh preview before applying.";
  }
  if (reason === "race-window") {
    return "Only training reductions are allowed in the current race window. This Change was not applied.";
  }
  if (reason === "ftp-sources-changed") {
    return "The FTP sources changed. Request a fresh preview before applying this correction.";
  }
  if (reason === "stale-version") {
    return "This preview is stale because the Plan or its sources changed. Request a fresh preview; no training changed.";
  }
  if (reason === "not-pending") {
    return "This preview is no longer pending. Training is unchanged.";
  }
  return "This Change could not be applied. Training and the pending preview are unchanged.";
}

export function planCreationBuildRejectionCopy(reason: string): string {
  if (reason === "no-workouts") {
    return "No Workouts fit anywhere in this Plan under your confirmed limits. Edit those limits to continue.";
  }
  if (reason === "not-ready") return "Answer the remaining question before building.";
  if (reason === "stale-version") return "The answers changed. Start a fresh build.";
  return "Build failed. Your answers and last complete Draft are preserved.";
}

export function planCreationDiscardNoticeCopy(
  reason: "stale-version" | "command-conflict" | "no-unfinished-creation",
): string {
  if (reason === "stale-version") return CHAT_PLAN_CREATION_DISCARD_STALE_COPY;
  if (reason === "command-conflict") return CHAT_PLAN_CREATION_DISCARD_CONFLICT_COPY;
  return CHAT_PLAN_CREATION_DISCARD_MISSING_COPY;
}
