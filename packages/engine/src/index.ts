import type {
  ChatQueueRunResult,
  ChatQueueSnapshot,
  CoachEngine,
  PlanIntakePatch,
  QueuedChatMessage,
  TurnEvent,
} from "@enduragent/coach-contract";
import { CoachAgent, type DeferredPlanTurn } from "./agent/coach-agent.js";
import { describeLanguage } from "@enduragent/i18n";
import { extractAccountId } from "./agent/codex/jwt.js";
import type { ChatAttachmentActivitySummary, EngineHostPorts } from "./host-ports.js";
import type { Sport } from "./sport.js";
import type { ResolvedCs } from "@enduragent/kernel/reference/cs-resolution";
import type { SourceProvenance } from "./provenance.js";
import type { IntentTranslationPort } from "./intent-translation.js";

export type { IntentTranslationPort } from "./intent-translation.js";

export type { CoachEngine } from "@enduragent/coach-contract";
export type { ChatStreamTimeouts } from "./host-ports.js";
export {
  createAttachmentCapabilityResolver,
  transportForProvider,
  type ActiveAttachmentModel,
  type AttachmentCapabilityResolver,
  type AttachmentCapabilityResolverOptions,
  type NativeMediaTransport,
} from "./attachment-capabilities.js";
export {
  parseOpenRouterModelMetadataSnapshot,
  type OpenRouterModelMetadataCache,
  type OpenRouterModelMetadataSnapshot,
  type ResolveOpenRouterModelMetadataInput,
} from "./openrouter-model-metadata.js";
export * from "./planning/proposal.js";
export * from "./planning/history.js";
export * from "./planning/auto-apply.js";
export * from "./planning/replacement.js";
export * from "./planning/season.js";
export * from "./planning/readiness.js";
export * from "./planning/intake-readiness.js";
export * from "./planning/weekly-review.js";
export * from "./planning/race-outcome.js";
export type {
  AthleteDataReaderPort,
  AthleteReadResult,
  AthleteStateReaderPort,
  CalendarEventForDelete,
  CalendarEventUpdate,
  CallerRole,
  ChatLineage,
  ChatStorePort,
  ChatAttachmentActivitySummary,
  ChatAttachmentTurnPort,
  ChatAttachmentTurnPreparation,
  ChatNativeMediaInput,
  AttachmentCapabilitiesPort,
  CoachDecisionStorePort,
  ConversationResetInput,
  EngineConfig,
  EngineDataSource,
  EngineHostPorts,
  EngineLlmProvider,
  EnvSecretRef,
  ExecSecretRef,
  FailureReason,
  LoggerFields,
  LoggerPort,
  MemorySnapshot,
  MemoryStorePort,
  MemoryWriteSource,
  ModelTransport,
  ModelTransportDecorator,
  ModelTransportRequest,
  PlatformCalendarMutationsPort,
  PlatformClientPort,
  PlanningReadPort,
  ReferenceStateSnapshot,
  SecretRef,
  SecretsPort,
  StoredDataFreshness,
  ToolConfirmationPort,
  TranscriptCompletedTurnInput,
  TranscriptConversationBoundaryReason,
  TranscriptInterruptedTurnInput,
  TranscriptWriterPort,
  UsageCost,
  UsageCostBasis,
  UsageLedgerLine,
  UsagePort,
} from "./host-ports.js";

export interface CreateCoachEngineInput {
  readonly sport: Sport;
  readonly ports: EngineHostPorts;
}

interface QueueRetryRun {
  readonly claimId: string;
  readonly task: Promise<ChatQueueRunResult>;
  readonly events: TurnEvent[];
  readonly subscribers: Set<(event: TurnEvent) => void>;
}

export function createCoachEngine(
  input: CreateCoachEngineInput,
): CoachEngine & IntentTranslationPort {
  const agent = new CoachAgent(input.sport, input.ports);
  const queueRuns = new Map<string, Promise<ChatQueueRunResult>>();
  const queueRetryRuns = new Map<string, QueueRetryRun>();
  const deferredPlanTurns = new Map<string, DeferredPlanTurn>();
  const deferredKey = (chatId: string, turnId: string): string => `${chatId}:${turnId}`;
  const queueAuthorities = new Map<string, Promise<void>>();
  const withQueueAuthority = async <T>(chatId: string, work: () => Promise<T>): Promise<T> => {
    const previous = queueAuthorities.get(chatId) ?? Promise.resolve();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => {}).then(() => gate);
    queueAuthorities.set(chatId, tail);
    await previous.catch(() => {});
    try {
      return await work();
    } finally {
      release();
      if (queueAuthorities.get(chatId) === tail) queueAuthorities.delete(chatId);
    }
  };
  const queuePort = <K extends keyof EngineHostPorts["chatStore"]>(
    name: K,
  ): NonNullable<EngineHostPorts["chatStore"][K]> => {
    const operation = input.ports.chatStore[name];
    if (typeof operation !== "function")
      throw new Error("Durable chat queue storage is unavailable.");
    return operation as NonNullable<EngineHostPorts["chatStore"][K]>;
  };
  const snapshot = async (chatId: string): Promise<ChatQueueSnapshot> => {
    const completedClaim = input.ports.chatStore.getCompletedChatQueueClaim?.(chatId);
    if (completedClaim !== undefined && completedClaim !== null) {
      await input.ports.chatAttachments?.completeQueuedTurn({
        chatId,
        messageIds: completedClaim.messageIds,
      });
    }
    return queuePort("getChatQueue").call(input.ports.chatStore, chatId);
  };
  const queueText = (items: readonly QueuedChatMessage[]): string =>
    items.map((item) => item.text).join("\n\n");
  const activityContext = (
    activities: readonly ChatAttachmentActivitySummary[],
  ): string | undefined =>
    activities.length === 0
      ? undefined
      : [
          "Canonical Training activities imported for this athlete turn.",
          "Use only these normalized local fields; raw attachment bytes were not provided.",
          JSON.stringify(activities),
        ].join("\n");
  const subscribeQueueRetry = (
    run: QueueRetryRun,
    onEvent: ((event: TurnEvent) => void) | undefined,
  ): void => {
    if (onEvent === undefined) return;
    if (run.subscribers.has(onEvent)) return;
    for (const event of run.events) {
      try {
        onEvent(event);
      } catch {}
    }
    run.subscribers.add(onEvent);
  };
  const publishQueueRetry = (run: QueueRetryRun, event: TurnEvent): void => {
    run.events.push(event);
    const subscribers = Array.from(run.subscribers);
    for (const subscriber of subscribers) {
      try {
        subscriber(event);
      } catch {}
    }
  };
  const runQueue = (
    chatId: string,
    mode: "resume" | "command" | "retry",
    exactId: string | undefined,
    onEvent: ((event: TurnEvent) => void) | undefined,
    retryRunOverride?: QueueRetryRun,
  ): Promise<ChatQueueRunResult> => {
    const active = queueRuns.get(chatId);
    if (active !== undefined) {
      if (mode !== "retry" || exactId === undefined) return active;
      const existing = queueRetryRuns.get(chatId);
      if (existing?.claimId === exactId) {
        subscribeQueueRetry(existing, onEvent);
        return existing.task;
      }
      if (existing !== undefined) return snapshot(chatId).then((value) => ({ snapshot: value }));
      const events: TurnEvent[] = [];
      const subscribers = new Set<(event: TurnEvent) => void>();
      if (onEvent !== undefined) subscribers.add(onEvent);
      let retryRun!: QueueRetryRun;
      const task = (async (): Promise<ChatQueueRunResult> => {
        const before = await snapshot(chatId);
        const recovery = before.retryRequired;
        if (recovery === undefined || recovery.claimId !== exactId) return { snapshot: before };
        agent.stopChat(chatId, recovery.turnId);
        await active.catch(() => undefined);
        if (queueRuns.get(chatId) === active) queueRuns.delete(chatId);
        if (queueRetryRuns.get(chatId) === retryRun) queueRetryRuns.delete(chatId);
        return runQueue(chatId, "retry", exactId, undefined, retryRun);
      })();
      retryRun = { claimId: exactId, task, events, subscribers };
      queueRetryRuns.set(chatId, retryRun);
      const release = (): void => {
        if (queueRetryRuns.get(chatId)?.task === task) queueRetryRuns.delete(chatId);
      };
      void task.then(release, release);
      return task;
    }
    const retryEvents = retryRunOverride?.events ?? [];
    const retrySubscribers = retryRunOverride?.subscribers ?? new Set<(event: TurnEvent) => void>();
    if (mode === "retry" && onEvent !== undefined && retryRunOverride === undefined) {
      retrySubscribers.add(onEvent);
    }
    let retryRun = retryRunOverride;
    const task = withQueueAuthority(chatId, async (): Promise<ChatQueueRunResult> => {
      const before = await snapshot(chatId);
      const pendingDecision = input.ports.coachDecisions?.getDecision(chatId);
      if (
        pendingDecision?.status === "unanswered" ||
        (pendingDecision?.status === "answered" &&
          pendingDecision.continuation.status === "pending")
      ) {
        return { snapshot: before };
      }
      let claimId: string;
      let turnId: string;
      let selected: readonly QueuedChatMessage[];
      if (mode === "retry") {
        const recovery = before.retryRequired;
        if (recovery === undefined || recovery.claimId !== exactId) return { snapshot: before };
        claimId = recovery.claimId;
        turnId = recovery.turnId;
        selected = before.items.slice(0, recovery.queuedMessageIds.length);
        queuePort("retryChatQueueClaim").call(input.ports.chatStore, chatId, claimId, turnId);
      } else {
        const head = before.items[0];
        if (head === undefined || before.retryRequired !== undefined) return { snapshot: before };
        if (mode === "command") {
          if (head.kind !== "slash-command" || head.queuedMessageId !== exactId)
            return { snapshot: before };
          selected = [head];
        } else {
          if (head.kind === "slash-command") {
            if (head.restored) return { snapshot: before };
            selected = [head];
          } else {
            let size = 1;
            while (before.items[size]?.kind === "ordinary") size += 1;
            selected = before.items.slice(0, size);
          }
        }
        claimId = input.ports.randomId();
        turnId = input.ports.randomId();
        queuePort("claimChatQueue").call(
          input.ports.chatStore,
          chatId,
          claimId,
          turnId,
          selected.map((item) => item.queuedMessageId),
        );
      }
      let interrupted = false;
      try {
        const capabilities = selected.some((item) => item.attachmentIds.length > 0)
          ? await input.ports.attachmentCapabilities?.resolve()
          : undefined;
        const attachmentPreparation = await input.ports.chatAttachments?.prepareQueuedTurn({
          chatId,
          messages: selected.map((item) => ({
            messageId: item.messageId,
            attachmentIds: item.attachmentIds,
          })),
          ...(capabilities === undefined ? {} : { capabilities }),
        });
        const normalizedAttachmentContext = [
          attachmentPreparation === undefined
            ? undefined
            : activityContext(attachmentPreparation.activities),
          attachmentPreparation?.attachmentContext,
        ]
          .filter((value): value is string => value !== undefined && value.length > 0)
          .join("\n\n");
        let decision;
        let planIntakePatch: PlanIntakePatch | undefined;
        const languageDetectionText = selected.at(-1)?.text ?? "";
        const text = await agent.chat(
          chatId,
          queueText(selected),
          {
            languageDetectionText,
            ...(normalizedAttachmentContext.length === 0
              ? {}
              : { attachmentContext: normalizedAttachmentContext }),
            ...(attachmentPreparation?.nativeMedia === undefined
              ? {}
              : { nativeMedia: attachmentPreparation.nativeMedia }),
            ...(attachmentPreparation?.untrustedAttachmentText === undefined
              ? {}
              : { untrustedAttachmentText: attachmentPreparation.untrustedAttachmentText }),
            ...(attachmentPreparation?.attachments === undefined ||
            attachmentPreparation.attachments.length === 0
              ? {}
              : { attachments: attachmentPreparation.attachments }),
          },
          (event) => {
            if (event.type === "interrupted") interrupted = true;
            if (retryRun === undefined) onEvent?.(event);
            else publishQueueRetry(retryRun, event);
          },
          (requested) => {
            decision = requested;
          },
          turnId,
          (patch) => {
            planIntakePatch = patch;
          },
          (turn) => {
            deferredPlanTurns.set(deferredKey(turn.chatId, turn.turnId), turn);
          },
        );
        if (interrupted) {
          return {
            snapshot: queuePort("requireChatQueueRetry").call(
              input.ports.chatStore,
              chatId,
              claimId,
            ),
            response:
              decision === undefined
                ? { text, ...(planIntakePatch === undefined ? {} : { planIntakePatch }) }
                : {
                    text,
                    decision,
                    ...(planIntakePatch === undefined ? {} : { planIntakePatch }),
                  },
          };
        }
        await input.ports.chatAttachments?.completeQueuedTurn({
          chatId,
          messageIds: selected.map((item) => item.messageId),
        });
        return {
          snapshot: queuePort("completeChatQueueClaim").call(
            input.ports.chatStore,
            chatId,
            claimId,
          ),
          response:
            decision === undefined
              ? { text, ...(planIntakePatch === undefined ? {} : { planIntakePatch }) }
              : {
                  text,
                  decision,
                  ...(planIntakePatch === undefined ? {} : { planIntakePatch }),
                },
        };
      } catch (error) {
        queuePort("requireChatQueueRetry").call(input.ports.chatStore, chatId, claimId);
        throw error;
      }
    });
    queueRuns.set(chatId, task);
    const release = (): void => {
      if (queueRuns.get(chatId) === task) queueRuns.delete(chatId);
    };
    void task.then(release, release);
    if (mode === "retry" && exactId !== undefined && queueRetryRuns.get(chatId) === undefined) {
      retryRun ??= { claimId: exactId, task, events: retryEvents, subscribers: retrySubscribers };
      queueRetryRuns.set(chatId, retryRun);
      const releaseRetry = (): void => {
        if (queueRetryRuns.get(chatId) === retryRun) queueRetryRuns.delete(chatId);
      };
      void task.then(releaseRetry, releaseRetry);
    }
    return task;
  };
  return {
    translateIntent: agent.translateIntent,
    chat: async (request, onEvent) => {
      let decision;
      let planIntakePatch: PlanIntakePatch | undefined;
      const text = await agent.chat(
        request.chatId,
        request.message,
        {
          ...(request.turn as
            | { resolvedCs?: ResolvedCs | null; referenceProvenance?: SourceProvenance }
            | undefined),
          language:
            request.turn?.language === undefined
              ? undefined
              : {
                  language: request.turn.language,
                  source: request.turn.languageSource ?? "default",
                  locale: describeLanguage(request.turn.language).defaultLocale,
                },
        },
        onEvent,
        (requested) => {
          decision = requested;
        },
        undefined,
        (patch) => {
          planIntakePatch = patch;
        },
        request.chatId.startsWith("plan:")
          ? (turn) => {
              deferredPlanTurns.set(deferredKey(turn.chatId, turn.turnId), turn);
            }
          : undefined,
      );
      return decision === undefined
        ? { text, ...(planIntakePatch === undefined ? {} : { planIntakePatch }) }
        : { text, decision, ...(planIntakePatch === undefined ? {} : { planIntakePatch }) };
    },
    stopChat: async (request) => ({ stopped: agent.stopChat(request.chatId, request.turnId) }),
    enqueueChatMessage: async (request) => {
      const queued = queuePort("enqueueChatMessage").call(
        input.ports.chatStore,
        request.chatId,
        request.submissionId,
        request.text,
        input.ports.randomId(),
        input.ports.randomId(),
        request.attachmentIds,
      );
      const item = queued.items.find(
        (candidate) => candidate.submissionId === request.submissionId,
      );
      if (item === undefined || item.attachmentIds.length === 0) return queued;
      try {
        await input.ports.chatAttachments?.acceptQueuedMessage?.({
          chatId: request.chatId,
          messageId: item.messageId,
          attachmentIds: item.attachmentIds,
        });
      } catch (error) {
        queuePort("removeQueuedChatMessage").call(
          input.ports.chatStore,
          request.chatId,
          item.queuedMessageId,
        );
        throw error;
      }
      return queued;
    },
    getChatQueue: async (request) => snapshot(request.chatId),
    removeQueuedChatMessage: async (request) =>
      queuePort("removeQueuedChatMessage").call(
        input.ports.chatStore,
        request.chatId,
        request.queuedMessageId,
      ),
    resumeChatQueue: (request, onEvent) => runQueue(request.chatId, "resume", undefined, onEvent),
    runQueuedCommand: (request, onEvent) =>
      runQueue(request.chatId, "command", request.queuedMessageId, onEvent),
    retryQueuedTurn: (request, onEvent) =>
      runQueue(request.chatId, "retry", request.claimId, onEvent),
    getCoachDecision: (request) => agent.getCoachDecision(request),
    answerCoachDecision: (request, onEvent) => agent.answerCoachDecision(request, onEvent),
    skipCoachDecision: (request) => agent.skipCoachDecision(request),
    resumeCoachDecision: (request, onEvent) => agent.resumeCoachDecision(request, onEvent),
    resetSession: (request) =>
      withQueueAuthority(request.chatId, () => agent.resetSession(request.chatId)),
    settle: (request) => agent.settle(request?.chatId),
    hasSession: async (request) => ({ hasSession: agent.hasSession(request.chatId) }),
    getAthleteState: () => agent.getAthleteState(),
    replacePlanChatHistory: async (request) => {
      for (const [key, turn] of deferredPlanTurns) {
        if (turn.chatId === request.chatId) deferredPlanTurns.delete(key);
      }
      agent.replacePlanConversationHistory(request.chatId, request.turns);
    },
    commitPlanChatTurn: async (request) => {
      const key = deferredKey(request.chatId, request.turnId);
      const turn = deferredPlanTurns.get(key);
      if (turn === undefined) return;
      agent.commitDeferredPlanTurn(turn);
      deferredPlanTurns.delete(key);
    },
    getPlanDecisionIntakePatch: async (request) =>
      input.ports.coachDecisions?.getDecisionPlanIntakePatch?.(
        request.chatId,
        request.decisionId,
      ) ?? undefined,
  };
}

export { extractAccountId };
export {
  PLAN_MIRROR_DAYS,
  PLAN_MIRROR_EXTERNAL_ID_PREFIX,
  cleanupPlanMirror,
  planMirrorExternalId,
  planMirrorExternalIdPrefix,
  projectPlanReconciliation,
  reconcileActivePlanWindow,
  verifyPlanMirror,
  verifyPlanCleanup,
  type PlanMirrorCalendarPort,
  type PlanMirrorCreateInput,
  type PlanMirrorEvent,
  type PlanMirrorUpdateInput,
  type PlanReconciliationDomainState,
  type PlanReconciliationProjection,
  type PlanReconcilerDeps,
  type PlanReconcilerIdentity,
} from "./planning/reconciler.js";
export {
  PlanWorkoutDriftError,
  adoptProviderWorkoutEdit,
  planWorkoutDriftSnapshot,
  providerWorkoutDriftSnapshot,
  refreshPlanWorkoutDrifts,
  restorePlanWorkout,
  type PlanWorkoutDriftDeps,
  type PlanWorkoutDriftIdentity,
  type PlanWorkoutDriftSnapshot,
} from "./planning/workout-drift.js";
export {
  activatePlanDraft,
  type ActivatePlanDraftInput,
  type PlanActivationIdentity,
} from "./planning/activation.js";
export {
  RaceCourseLifecycleError,
  acceptParsedRaceCourse,
  beginRaceCourseParsing,
  beginRaceCourseRemoval,
  completeRaceCourseRecalculation,
  failRaceCourseRecalculation,
  openRaceCoursePicker,
  rejectRaceCourseFile,
  retryRaceCourseRecalculation,
  useRouteWithoutElevation,
  type RaceCourseInvalidState,
  type RaceCourseLifecycleKind,
  type RaceCourseLifecycleState,
  type RaceCourseMissingElevationState,
  type RaceCourseParsingState,
  type RaceCoursePickerState,
  type RaceCourseReadyState,
  type RaceCourseRecalculatingState,
  type RaceCourseRecalculationFailedState,
} from "./planning/race-course.js";
export {
  executePlanFtpTransition,
  type PlanFtpAdapter,
  type PlanFtpSnapshot,
  type PlanFtpSource,
  type PlanFtpSourceValue,
  type PlanFtpTransitionInput,
} from "./planning/ftp.js";
export {
  PlanStartDateError,
  applyPlanStartDatePreview,
  previewPlanStartDate,
  type PlanStartDatePreview,
} from "./planning/start-date.js";
export {
  WORKOUT_MATCH_AS_PLANNED_MAX_SECONDS,
  WORKOUT_MATCH_AS_PLANNED_MIN_SECONDS,
  WORKOUT_MATCH_AS_PLANNED_RATIO,
  WORKOUT_MATCH_DURATION_MAX_SECONDS,
  WORKOUT_MATCH_DURATION_MIN_SECONDS,
  WORKOUT_MATCH_DURATION_RATIO,
  isRacePlanWorkout,
  projectWorkoutMatches,
  refreshPlanWorkoutMatches,
  type ProjectedWorkoutMatch,
  type WorkoutMatchDisplayStatus,
  type WorkoutMatchIdentity,
} from "./planning/workout-match.js";
export { makeSummaryMessage, splitHistoryByBudget, SUMMARY_PREFIX } from "./agent/history-limit.js";
export { truncateUtf16Safe } from "./text-truncate.js";
export { warnOrphanSections, _resetOrphanWarnCacheForTesting } from "./sport/orphan-sections.js";
export { capToolResult, TOOL_RESULT_MAX_TOKENS } from "./agent/tool-result-cap.js";
export {
  COMPACTION_SUMMARY_END_MARKER,
  COMPACTION_SUMMARY_MARKER,
  demoteSummaryHeadings,
  formatCompactionNote,
  persistCompactionSummary,
} from "./agent/compaction-note.js";
export {
  bindToolResult,
  boundToolResultProvenance,
  carryBoundToolResultProvenance,
  unwrapBoundToolResult,
} from "./sport/bound-tool-result.js";
export {
  DATE_KEY_RE,
  INTERVALS_LIST_MAX_RANGE_DAYS,
  dateKeySchema,
  validateListRange,
  validateWorkoutCreationDate,
} from "./sport/date-schema.js";
export { GARMIN_DATA_ATTRIBUTION, renderGarminAttribution } from "./agent/garmin-attribution.js";
export {
  ATHLETE_CONTEXT_FENCE_CLOSE,
  ATHLETE_CONTEXT_FENCE_OPEN,
  ATHLETE_CONTEXT_TRUNCATION_NOTICE,
  FENCE_TOKEN_REPLACEMENT,
  isUntrustedEnvelope,
  markUntrustedResult,
  sanitizeUntrustedText,
  wrapAthleteContextFence,
} from "./agent/prompt-fence.js";
export {
  EMPTY_PROVENANCE,
  UNKNOWN_PROVENANCE,
  classifyActivities,
  classifyActivity,
  classifyTrustedSource,
  contentDigest,
  getMessageProvenance,
  isNonEmptyData,
  isSourceProvenance,
  provenanceForSourceBearingData,
  provenanceOfMessages,
  setMessageProvenance,
  unionProvenance,
  type SourceProvenance,
} from "./provenance.js";
export {
  isProviderAuthFailure,
  markProviderAuthFailure,
  type ProviderAuthFailure,
} from "./provider-auth-failure.js";
export {
  cacheReadSavingsUsd,
  classifySpendCaching,
  priceInclusiveUsage,
  type UsageTokenCounts,
} from "./usage-cost.js";
export {
  CLAUDE_CLI_PRICE_TABLE,
  claudeCliCacheReadSavingsUsd,
  priceClaudeCliInclusiveUsage,
  resolveClaudeCliPriceId,
} from "./agent/claude-cli/cost.js";
export {
  ClaudeCliConfigError,
  ClaudeWorkingAreaError,
  type ClaudeCliConfigErrorKind,
  type ClaudeWorkingAreaFailureCategory,
  type ClaudeWorkingAreaStage,
} from "./agent/claude-cli/errors.js";
export {
  createClaudeWorkingArea,
  type ClaudeLaunchPurpose,
  type ClaudeWorkingAreaBinding,
  type ClaudeWorkingAreaPort,
  type CreateClaudeWorkingAreaInput,
} from "./agent/claude-cli/working-area.js";
export {
  CODEX_AGENT_PRICE_TABLE,
  codexAgentCacheReadSavingsUsd,
  priceCodexAgentInclusiveUsage,
  resolveCodexAgentPriceId,
} from "./agent/codex-agent/cost.js";
export {
  CodexAgentConfigError,
  type CodexAgentConfigErrorKind,
} from "./agent/codex-agent/errors.js";
export {
  codexIdentityLine,
  ensureCodexAgentReady,
  invalidateCodexAgentProbeCache,
  type CodexAgentReadinessRefusal,
  type CodexAgentReadinessReport,
  type CodexAgentReadinessResult,
  type EnsureCodexAgentReadyDeps,
  type EnsureCodexAgentReadyInput,
} from "./agent/codex-agent/probe.js";
export {
  API_KEY_BILLING_IDENTITY_LINE,
  claudeIdentityLine,
  ensureClaudeCliReady,
  invalidateClaudeAccountProbeCache,
  probeClaudeAccountCached,
  recheckClaudeAccount,
  type CachedProbeDeps,
  type ClaudeAccountClass,
  type ClaudeAccountProbeFailure,
  type ClaudeAccountProbeResult,
  type ClaudeCliReadiness,
  type EnsureClaudeCliReadyDeps,
  type EnsureClaudeCliReadyInput,
  type ProbeClaudeAccountDeps,
  type ProbeClaudeAccountInput,
} from "./agent/claude-cli/probe.js";
