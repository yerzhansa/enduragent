import { randomBytes } from "node:crypto";
import type { ModelMessage } from "ai";
import type {
  ChatLineage,
  ChatStorePort,
  ConversationResetInput,
  TranscriptCompletedTurnInput,
  TranscriptInterruptedTurnInput,
  TranscriptWriterPort,
} from "@enduragent/engine";
import { archiveAndResetDurably, ChatStore, type UnflushedResetArchive } from "./chat-store.js";
import {
  ArchivedConversationDeletionConflictError,
  TranscriptBoundaryTargetUnchangedError,
  TranscriptStore,
  type ArchivedConversationDeletionManifest,
  type ArchivedConversationList,
  type ResetIntentRecord,
  type TranscriptTurnRecord,
  type TranscriptDecisionAnsweredInput,
  type TranscriptDecisionContinuationCompletedInput,
  type TranscriptDecisionRequestedInput,
  type TranscriptDecisionSkippedInput,
  type TranscriptPageRequest,
  type TranscriptPageResult,
} from "./transcript-store.js";
import type { CoachDecisionReadModel, PlanIntakePatch } from "@enduragent/coach-contract";
import type { ChatQueueSnapshot } from "@enduragent/coach-contract";
import { WindowsPrivatePathPolicyError } from "../io/windows-private-path-policy.js";
import { ChatQueueStore, type ChatQueueStoreHooks } from "./chat-queue-store.js";

export interface ConversationStorePort extends ChatStorePort, TranscriptWriterPort {
  getChatQueue(chatId: string): ChatQueueSnapshot;
  enqueueChatMessage(
    chatId: string,
    submissionId: string,
    text: string,
    queuedMessageId: string,
    messageId?: string,
    attachmentIds?: readonly string[],
  ): ChatQueueSnapshot;
  removeQueuedChatMessage(chatId: string, queuedMessageId: string): ChatQueueSnapshot;
  claimChatQueue(
    chatId: string,
    claimId: string,
    turnId: string,
    queuedMessageIds: readonly string[],
  ): ChatQueueSnapshot;
  completeChatQueueClaim(chatId: string, claimId: string): ChatQueueSnapshot;
  requireChatQueueRetry(chatId: string, claimId: string): ChatQueueSnapshot;
  retryChatQueueClaim(chatId: string, claimId: string, turnId: string): ChatQueueSnapshot;
  clearChatQueue(chatId: string): ChatQueueSnapshot;
  getCompletedChatQueueClaim(chatId: string): {
    readonly turnId: string;
    readonly messageIds: readonly string[];
  } | null;
  appendDecisionRequested(input: TranscriptDecisionRequestedInput): CoachDecisionReadModel;
  answerDecision(input: TranscriptDecisionAnsweredInput): CoachDecisionReadModel;
  skipDecision(input: TranscriptDecisionSkippedInput): CoachDecisionReadModel;
  completeDecisionContinuation(
    input: TranscriptDecisionContinuationCompletedInput,
  ): CoachDecisionReadModel;
  getDecision(chatId: string, decisionId?: string): CoachDecisionReadModel | null;
  getDecisionAthleteText(chatId: string, decisionId: string): string | null;
  getDecisionPlanIntakePatch(chatId: string, decisionId: string): PlanIntakePatch | null;
  readCurrentConversation(chatId: string): TranscriptTurnRecord[];
  readCurrentConversationPage(chatId: string, request: TranscriptPageRequest): TranscriptPageResult;
  listArchivedConversations(chatId: string): ArchivedConversationList;
  readArchivedConversationPage(
    chatId: string,
    boundaryRef: string,
    request: TranscriptPageRequest,
  ): TranscriptPageResult;
  inspectArchivedConversation(
    chatId: string,
    boundaryRef: string,
  ): ArchivedConversationDeletionManifest | null;
  finalizeArchivedConversationDeletion(
    chatId: string,
    manifest: ArchivedConversationDeletionManifest,
  ): boolean;
  reconcileChatQueue(chatId: string): ChatQueueSnapshot;
}

export interface ConversationStoreOptions {
  readonly platform?: NodeJS.Platform;
  readonly chatQueueHooks?: ChatQueueStoreHooks;
}

export function createConversationStore(
  dataDir: string,
  resetArchiveRetentionDays = 0,
  options: ConversationStoreOptions = {},
): ConversationStorePort {
  return ConversationStore.create(dataDir, resetArchiveRetentionDays, options);
}

export class ConversationRecoveryError extends Error {
  readonly code = "CONVERSATION_RECOVERY_REQUIRED";

  constructor(options: { readonly cause: unknown }) {
    super("Conversation storage recovery could not be completed.", options);
    this.name = "ConversationRecoveryError";
  }
}

export class ConversationStore implements ConversationStorePort {
  private readonly blockedChats = new Map<string, unknown>();

  static create(
    dataDir: string,
    resetArchiveRetentionDays = 0,
    options: ConversationStoreOptions = {},
  ): ConversationStore {
    return new ConversationStore(
      new ChatStore(dataDir, resetArchiveRetentionDays, options),
      new TranscriptStore(dataDir, { platform: options.platform }),
      undefined,
      new ChatQueueStore(dataDir, options.platform, options.chatQueueHooks),
    );
  }

  constructor(
    private readonly chatStore: ChatStore,
    private readonly transcriptStore: TranscriptStore,
    private readonly createResetId: () => string = () => randomBytes(32).toString("hex"),
    private readonly chatQueueStore?: ChatQueueStore,
  ) {
    for (const intent of this.transcriptStore.listResetIntents()) {
      try {
        this.recoverIntent(intent);
      } catch (error) {
        this.blockedChats.set(intent.chatId, error);
      }
    }
  }

  hasSession(chatId: string): boolean {
    this.recoverBeforeAccess(chatId);
    return this.chatStore.hasSession(chatId);
  }

  load(chatId: string): { messages: ModelMessage[]; lastMessageTime: string | null } {
    this.recoverBeforeAccess(chatId);
    return this.chatStore.load(chatId);
  }

  appendTurn(
    chatId: string,
    userContent: string,
    assistantContent: string,
    lineage: ChatLineage,
  ): void {
    this.recoverBeforeAccess(chatId);
    this.chatStore.appendTurn(chatId, userContent, assistantContent, lineage);
  }

  overwriteHistory(chatId: string, messages: ModelMessage[]): void {
    this.recoverBeforeAccess(chatId);
    this.chatStore.overwriteHistory(chatId, messages);
  }

  archivePreCompact(chatId: string, options?: { readonly flushPending?: boolean }): void {
    this.recoverBeforeAccess(chatId);
    this.chatStore.archivePreCompact(chatId, options);
  }

  appendCompletedTurn(input: TranscriptCompletedTurnInput): void {
    this.recoverBeforeAccess(input.chatId);
    this.transcriptStore.appendCompletedTurn(input);
  }

  appendInterruptedTurn(input: TranscriptInterruptedTurnInput): void {
    this.recoverBeforeAccess(input.chatId);
    this.transcriptStore.appendInterruptedTurn(input);
  }

  persistDecisionContext(input: Parameters<ChatStorePort["persistDecisionContext"]>[0]): void {
    this.recoverBeforeAccess(input.chatId);
    this.chatStore.persistDecisionContext(input);
  }

  appendDecisionRequested(input: TranscriptDecisionRequestedInput): CoachDecisionReadModel {
    this.recoverBeforeAccess(input.decision.chatId);
    return this.transcriptStore.appendDecisionRequested(input);
  }

  answerDecision(input: TranscriptDecisionAnsweredInput): CoachDecisionReadModel {
    this.recoverBeforeAccess(input.chatId);
    return this.transcriptStore.answerDecision(input);
  }

  skipDecision(input: TranscriptDecisionSkippedInput): CoachDecisionReadModel {
    this.recoverBeforeAccess(input.chatId);
    return this.transcriptStore.skipDecision(input);
  }

  completeDecisionContinuation(
    input: TranscriptDecisionContinuationCompletedInput,
  ): CoachDecisionReadModel {
    this.recoverBeforeAccess(input.chatId);
    return this.transcriptStore.completeDecisionContinuation(input);
  }

  getDecision(chatId: string, decisionId?: string): CoachDecisionReadModel | null {
    this.recoverBeforeAccess(chatId);
    return this.transcriptStore.getDecision(chatId, decisionId);
  }

  getDecisionAthleteText(chatId: string, decisionId: string): string | null {
    this.recoverBeforeAccess(chatId);
    return this.transcriptStore.getDecisionAthleteText(chatId, decisionId);
  }

  getDecisionPlanIntakePatch(chatId: string, decisionId: string): PlanIntakePatch | null {
    this.recoverBeforeAccess(chatId);
    return this.transcriptStore.getDecisionPlanIntakePatch(chatId, decisionId);
  }

  readCurrentConversation(chatId: string) {
    this.recoverBeforeAccess(chatId);
    return this.transcriptStore.readCurrentConversation(chatId);
  }

  readCurrentConversationPage(chatId: string, request: TranscriptPageRequest) {
    return this.transcriptStore.readCurrentConversationPage(chatId, request);
  }

  listArchivedConversations(chatId: string) {
    return this.transcriptStore.listArchivedConversations(chatId);
  }

  readArchivedConversationPage(
    chatId: string,
    boundaryRef: string,
    request: TranscriptPageRequest,
  ) {
    return this.transcriptStore.readArchivedConversationPage(chatId, boundaryRef, request);
  }

  inspectArchivedConversation(chatId: string, boundaryRef: string) {
    return this.transcriptStore.inspectArchivedConversation(chatId, boundaryRef);
  }

  finalizeArchivedConversationDeletion(
    chatId: string,
    manifest: ArchivedConversationDeletionManifest,
  ): boolean {
    this.recoverBeforeAccess(chatId);
    const current = this.transcriptStore.inspectArchivedConversation(chatId, manifest.boundaryRef);
    if (current === null) return false;
    if (JSON.stringify(current) !== JSON.stringify(manifest)) {
      throw new ArchivedConversationDeletionConflictError();
    }
    this.chatStore.deleteResetArchive(chatId, manifest.boundaryRef, manifest.boundaryAt);
    return this.transcriptStore.finalizeArchivedConversationDeletion(chatId, manifest);
  }

  getChatQueue(chatId: string): ChatQueueSnapshot {
    this.recoverBeforeAccess(chatId);
    return this.reconcileChatQueue(chatId);
  }

  enqueueChatMessage(
    chatId: string,
    submissionId: string,
    text: string,
    queuedMessageId: string,
    messageId = queuedMessageId,
    attachmentIds: readonly string[] = [],
  ): ChatQueueSnapshot {
    this.recoverBeforeAccess(chatId);
    return this.queueStore().enqueue(
      chatId,
      submissionId,
      text,
      queuedMessageId,
      messageId,
      attachmentIds,
    );
  }

  removeQueuedChatMessage(chatId: string, queuedMessageId: string): ChatQueueSnapshot {
    this.recoverBeforeAccess(chatId);
    return this.queueStore().remove(chatId, queuedMessageId);
  }

  claimChatQueue(
    chatId: string,
    claimId: string,
    turnId: string,
    queuedMessageIds: readonly string[],
  ): ChatQueueSnapshot {
    this.recoverBeforeAccess(chatId);
    return this.queueStore().claim(chatId, {
      claimId,
      turnId,
      queuedMessageIds: [...queuedMessageIds],
    });
  }

  completeChatQueueClaim(chatId: string, claimId: string): ChatQueueSnapshot {
    this.recoverBeforeAccess(chatId);
    return this.queueStore().complete(chatId, claimId);
  }

  requireChatQueueRetry(chatId: string, claimId: string): ChatQueueSnapshot {
    this.recoverBeforeAccess(chatId);
    return this.queueStore().requireRetry(chatId, claimId);
  }

  retryChatQueueClaim(chatId: string, claimId: string, turnId: string): ChatQueueSnapshot {
    this.recoverBeforeAccess(chatId);
    return this.queueStore().retry(chatId, claimId, turnId);
  }

  clearChatQueue(chatId: string): ChatQueueSnapshot {
    this.recoverBeforeAccess(chatId);
    return this.queueStore().clear(chatId);
  }

  reconcileChatQueue(chatId: string): ChatQueueSnapshot {
    return this.queueStore().reconcile(chatId, this.transcriptStore.getTerminalTurnIds(chatId));
  }

  getCompletedChatQueueClaim(chatId: string) {
    this.recoverBeforeAccess(chatId);
    return this.queueStore().getCompletedClaim(
      chatId,
      this.transcriptStore.getTerminalTurnIds(chatId),
    );
  }

  private queueStore(): ChatQueueStore {
    if (this.chatQueueStore === undefined) throw new Error("Chat queue storage is unavailable.");
    return this.chatQueueStore;
  }

  resetConversation(input: ConversationResetInput): void {
    this.recoverBeforeAccess(input.chatId);
    const intent: ResetIntentRecord = {
      version: 1,
      kind: "conversation-reset-intent",
      resetId: this.createResetId(),
      chatId: input.chatId,
      boundaryAt: input.boundaryAt,
      reason: input.reason,
    };

    try {
      this.transcriptStore.createResetIntent(intent);
    } catch (error) {
      this.cleanupBeforeBoundary(intent, error);
    }

    let abandonedDecisions = 0;
    try {
      abandonedDecisions = this.transcriptStore.abandonUnansweredDecisions(
        intent.chatId,
        intent.boundaryAt,
      ).length;
    } catch (error) {
      this.blockedChats.set(intent.chatId, error);
      throw error;
    }

    try {
      this.transcriptStore.ensureConversationBoundary(intent);
    } catch (error) {
      if (error instanceof TranscriptBoundaryTargetUnchangedError && abandonedDecisions === 0) {
        this.cleanupBeforeBoundary(intent, error.originalError);
      }
      this.blockedChats.set(intent.chatId, error);
      throw error;
    }

    try {
      this.archiveDurably(intent);
      this.chatQueueStore?.clear(intent.chatId);
      this.transcriptStore.removeResetIntent(intent);
      this.blockedChats.delete(intent.chatId);
    } catch (error) {
      this.blockedChats.set(intent.chatId, error);
      throw error;
    }
  }

  private archiveDurably(intent: ResetIntentRecord): void {
    archiveAndResetDurably(this.chatStore, intent.chatId, {
      resetId: intent.resetId,
      boundaryAt: intent.boundaryAt,
      flushPending: intent.reason === "stale-reset",
    });
  }

  loadUnflushedResetArchive(chatId: string): UnflushedResetArchive | null {
    this.recoverBeforeAccess(chatId);
    return this.chatStore.loadUnflushedResetArchive(chatId);
  }

  markResetArchiveFlushed(chatId: string, archiveRef: string): void {
    this.recoverBeforeAccess(chatId);
    this.chatStore.markResetArchiveFlushed(chatId, archiveRef);
  }

  private cleanupBeforeBoundary(intent: ResetIntentRecord, originalError: unknown): never {
    try {
      const stored = this.transcriptStore.readResetIntent(intent.chatId);
      if (stored !== null) {
        if (JSON.stringify(stored) !== JSON.stringify(intent)) {
          throw new Error("A different conversation reset intent is already pending.");
        }
        this.transcriptStore.removeResetIntent(stored);
      }
      this.blockedChats.delete(intent.chatId);
    } catch (cleanupError) {
      this.blockedChats.set(intent.chatId, cleanupError);
      throw new ConversationRecoveryError({ cause: cleanupError });
    }
    throw originalError;
  }

  private recoverBeforeAccess(chatId: string): void {
    try {
      const intent = this.transcriptStore.readResetIntent(chatId);
      if (intent !== null) this.recoverIntent(intent);
      this.blockedChats.delete(chatId);
    } catch (error) {
      this.blockedChats.set(chatId, error);
      throw new ConversationRecoveryError({ cause: error });
    }
  }

  private recoverIntent(intent: ResetIntentRecord): void {
    try {
      this.transcriptStore.abandonUnansweredDecisions(intent.chatId, intent.boundaryAt);
    } catch (error) {
      if (!(error instanceof WindowsPrivatePathPolicyError)) throw error;
      this.transcriptStore.ensureConversationBoundary(intent);
      this.archiveDurably(intent);
      this.chatQueueStore?.clear(intent.chatId);
      this.transcriptStore.removeResetIntent(intent);
      return;
    }
    this.transcriptStore.ensureConversationBoundary(intent);
    this.archiveDurably(intent);
    this.chatQueueStore?.clear(intent.chatId);
    this.transcriptStore.removeResetIntent(intent);
  }
}

ConversationStore.prototype satisfies ChatStorePort;
ConversationStore.prototype satisfies TranscriptWriterPort;
