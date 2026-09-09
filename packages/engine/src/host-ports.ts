import type {
  AttachmentCapabilitiesReadModel,
  AthleteState,
  ChatAttachmentReference,
  PlanningReadModel,
  PlanReferenceSelection,
  ChatQueueSnapshot,
  CoachDecisionAnswer,
  CoachDecisionContinuationLineage,
  CoachDecisionReadModel,
  PlanIntakePatch,
  PlanHandoffSuggestion,
  RequestUserDecisionInput,
  RequestUserDecisionResult,
} from "@enduragent/coach-contract";
import type { LanguageResolution } from "@enduragent/i18n";
import type { ModelMessage } from "ai";
import type { EventInput, IntervalsClient } from "intervals-icu-api";
import type { GenerateOptions, GenerateResult } from "./sport.js";
import type { LedgerEventInput } from "./sport/ledger-event.js";
import type { SourceProvenance } from "./provenance.js";
import type { ClaudeWorkingAreaPort } from "./agent/claude-cli/working-area.js";

export type EngineDataSource = "platform" | "store";

export type EngineLlmProvider =
  | "anthropic"
  | "openai"
  | "google"
  | "openai-codex"
  | "claude-cli"
  | "codex-agent"
  | "deepseek"
  | "qwen"
  | "minimax"
  | "kimi"
  | "zai"
  | "openrouter";

export interface EngineConfig {
  readonly dataSource: EngineDataSource;
  readonly llm: {
    readonly provider: EngineLlmProvider;
    readonly model: string;
    readonly apiKey: string;
    readonly authProfile?: string;
    readonly flushModel?: string;
    readonly compactModel?: string;
    readonly baseUrl?: string;
    readonly claudeCli?: {
      readonly enabled: boolean;
      readonly binaryPath?: string;
      readonly configDir?: string;
      readonly billing: "subscription" | "api-key";
      readonly cursorStorePath: string;
    };
    readonly codexAgent?: {
      readonly enabled: boolean;
      readonly binaryPath?: string;
      readonly reasoningEffort?: "low" | "medium" | "high" | "ultra";
    };
  };
  readonly session: {
    readonly historyTokenBudgetRatio: number;
    readonly idleMinutes: number;
    readonly dailyResetHour: number;
    readonly resetArchiveRetentionDays: number;
    readonly timezone: string;
  };
  readonly contextWindowTokens: number;
  readonly compactContextWindowTokens: number;
}

export type MemoryWriteSource = "chat-tool" | "flush" | "sport-tool" | "migration" | "unattributed";

export interface MemoryStorePort {
  readMemory(): string;
  writeSection(
    section: string,
    content: string,
    source?: MemoryWriteSource,
    provenance?: SourceProvenance,
  ): void;
  readSection(section: string): string | null;
  /** Source labels for the current contents of one durable memory section. */
  provenanceForSection?(section: string, content?: string): SourceProvenance;
  renameSection(
    from: string,
    to: string,
    source?: MemoryWriteSource,
  ): "renamed" | "noop" | "merged";
  renameSections(
    renames: ReadonlyArray<readonly [string, string]>,
    source?: MemoryWriteSource,
  ): Array<"renamed" | "noop" | "merged">;
  readDailyNotes(date?: string): string;
  appendDailyNote(note: string, date?: string, provenance?: SourceProvenance): void;
  readDailyNotesInRange(from: string, to: string): Array<{ date: string; text: string }>;
  readEventsRaw(): string;
  readJournalRaw(): string;
  appendEvent(event: LedgerEventInput, provenance?: SourceProvenance): boolean;
  savePlan(
    plan: unknown,
    source?: MemoryWriteSource,
    provenance?: SourceProvenance,
  ): void | Promise<void>;
  refreshPlanReadGate?(): Promise<string | null>;
  loadPlan(): unknown | null;
  /** Source labels bound to the exact visible result of a synchronous tool read. */
  provenanceForToolRead?(
    name: string,
    input: unknown,
    visibleResult?: unknown,
    opts?: { truncated?: boolean },
  ): SourceProvenance;
  reload(): void;
  getContext(opts?: { excludeSections?: readonly string[] }): string;
  /** The rendered Athlete Context together with the source labels its contents carry. */
  getContextWithProvenance?(opts?: { excludeSections?: readonly string[]; maxChars?: number }): {
    text: string;
    provenance: SourceProvenance;
  };
  /** Run `fn` with every memory write it performs attributed to `provenance`. */
  runWithWriteProvenance?<T>(provenance: SourceProvenance, fn: () => T): T;
}

export interface MemorySnapshot {
  read(sectionName: string): string | null;
  has(sectionName: string): boolean;
  listSections(): readonly string[];
  /** Source labels attached to the frozen section contents. */
  provenanceOf(sectionName: string): SourceProvenance;
}

export interface ChatLineage {
  readonly templateHash: string;
  readonly assembledHash: string;
  readonly provider: string;
  readonly model: string;
  readonly lineageVersion: string;
  readonly provenance?: SourceProvenance;
}

export interface ChatStorePort {
  hasSession(chatId: string): boolean;
  load(chatId: string): { messages: ModelMessage[]; lastMessageTime: string | null };
  appendTurn(
    chatId: string,
    userContent: string,
    assistantContent: string,
    lineage: ChatLineage,
  ): void;
  persistDecisionContext(input: {
    readonly chatId: string;
    readonly decisionId: string;
    readonly athleteText: string;
    readonly request: RequestUserDecisionInput;
    readonly result?: RequestUserDecisionResult;
    readonly coachText?: string;
    readonly continuationId?: string;
    readonly lineage?: ChatLineage;
  }): void;
  overwriteHistory(chatId: string, messages: ModelMessage[]): void;
  resetConversation(input: ConversationResetInput): void;
  loadUnflushedResetArchive(
    chatId: string,
  ): { readonly archiveRef: string; readonly messages: ModelMessage[] } | null;
  markResetArchiveFlushed(chatId: string, archiveRef: string): void;
  archivePreCompact(chatId: string, options?: { readonly flushPending?: boolean }): void;
  getChatQueue?(chatId: string): ChatQueueSnapshot;
  enqueueChatMessage?(
    chatId: string,
    submissionId: string,
    text: string,
    queuedMessageId: string,
    messageId?: string,
    attachmentIds?: readonly string[],
  ): ChatQueueSnapshot;
  removeQueuedChatMessage?(chatId: string, queuedMessageId: string): ChatQueueSnapshot;
  claimChatQueue?(
    chatId: string,
    claimId: string,
    turnId: string,
    queuedMessageIds: readonly string[],
  ): ChatQueueSnapshot;
  completeChatQueueClaim?(chatId: string, claimId: string): ChatQueueSnapshot;
  requireChatQueueRetry?(chatId: string, claimId: string): ChatQueueSnapshot;
  retryChatQueueClaim?(chatId: string, claimId: string, turnId: string): ChatQueueSnapshot;
  clearChatQueue?(chatId: string): ChatQueueSnapshot;
  getCompletedChatQueueClaim?(chatId: string): {
    readonly turnId: string;
    readonly messageIds: readonly string[];
  } | null;
}

export interface ChatAttachmentActivitySummary {
  readonly attachmentId: string;
  readonly messageId: string;
  readonly activityIds: readonly string[];
  readonly sessions: readonly {
    readonly activityId: string;
    readonly sport: string;
    readonly startUtc: number;
    readonly elapsedSeconds: number | null;
    readonly distanceMeters: number | null;
  }[];
}

export interface ChatNativeMediaInput {
  readonly attachmentId: string;
  readonly mediaType: "image/png" | "image/jpeg" | "image/webp";
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly pageNumber?: number;
}

export interface ChatAttachmentTurnPreparation {
  readonly activities: readonly ChatAttachmentActivitySummary[];
  readonly attachments?: readonly ChatAttachmentReference[];
  readonly attachmentContext?: string;
  readonly untrustedAttachmentText?: string;
  readonly nativeMedia?: readonly ChatNativeMediaInput[];
}

export interface ChatAttachmentTurnPort {
  acceptQueuedMessage?(input: {
    readonly chatId: string;
    readonly messageId: string;
    readonly attachmentIds: readonly string[];
  }): Promise<void>;
  prepareQueuedTurn(input: {
    readonly chatId: string;
    readonly messages: readonly {
      readonly messageId: string;
      readonly attachmentIds: readonly string[];
    }[];
    readonly capabilities?: AttachmentCapabilitiesReadModel;
  }): Promise<ChatAttachmentTurnPreparation>;
  completeQueuedTurn(input: {
    readonly chatId: string;
    readonly messageIds: readonly string[];
  }): Promise<void>;
}

export interface AttachmentCapabilitiesPort {
  resolve(signal?: AbortSignal): Promise<AttachmentCapabilitiesReadModel>;
}

export type TranscriptConversationBoundaryReason = "explicit-reset" | "stale-reset";

export interface ConversationResetInput {
  readonly chatId: string;
  readonly boundaryAt: string;
  readonly reason: TranscriptConversationBoundaryReason;
}

export interface TranscriptCompletedTurnInput {
  readonly chatId: string;
  readonly turnId: string;
  readonly completedAt: string;
  readonly athleteText: string;
  readonly coachText: string;
  readonly attachments?: readonly ChatAttachmentReference[];
  readonly planReference?: PlanReferenceSelection;
  readonly planHandoff?: PlanHandoffSuggestion;
}

export type TranscriptInterruptedTurnInput = TranscriptCompletedTurnInput;

export interface TranscriptWriterPort {
  appendCompletedTurn(input: TranscriptCompletedTurnInput): void;
  appendInterruptedTurn?(input: TranscriptInterruptedTurnInput): void;
}

export interface CoachDecisionStorePort {
  appendDecisionRequested(input: {
    readonly decision: CoachDecisionReadModel;
    readonly turnId: string;
    readonly toolCallId: string;
    readonly athleteText: string;
    readonly requestedAt: string;
    readonly planIntakePatch?: PlanIntakePatch;
  }): CoachDecisionReadModel;
  answerDecision(input: {
    readonly chatId: string;
    readonly decisionId: string;
    readonly answer: CoachDecisionAnswer;
    readonly consequence: string;
    readonly continuationId: string;
    readonly answeredAt: string;
  }): CoachDecisionReadModel;
  skipDecision(input: {
    readonly chatId: string;
    readonly decisionId: string;
    readonly skippedAt: string;
  }): CoachDecisionReadModel;
  completeDecisionContinuation(input: {
    readonly chatId: string;
    readonly decisionId: string;
    readonly continuationId: string;
    readonly turnId: string;
    readonly coachText: string;
    readonly lineage: CoachDecisionContinuationLineage;
    readonly completedAt: string;
  }): CoachDecisionReadModel;
  getDecision(chatId: string, decisionId?: string): CoachDecisionReadModel | null;
  getDecisionAthleteText(chatId: string, decisionId: string): string | null;
  getDecisionPlanIntakePatch?(chatId: string, decisionId: string): PlanIntakePatch | null;
}

export type ExecSecretRef = {
  readonly source: "exec";
  readonly command: string;
  readonly args?: string[];
};

export type EnvSecretRef = {
  readonly source: "env";
  readonly var: string;
};

export type SecretRef = ExecSecretRef | EnvSecretRef;

export interface SecretsPort {
  resolve(ref: SecretRef): Promise<string>;
}

export interface StoredDataFreshness {
  readonly capturedAt: string;
  readonly ageMs: number;
  readonly label: string;
}

export type AthleteReadResult<T> =
  | { readonly ok: true; readonly value: T; readonly freshness?: StoredDataFreshness }
  | {
      readonly ok: false;
      readonly error: "not_found" | "store_read_unavailable" | "invalid_snapshot" | "invalid_input";
      readonly message: string;
    };

export interface AthleteDataReaderPort {
  getAthlete(): Promise<AthleteReadResult<unknown>>;
  listWellness(input: { start: string; end?: string }): Promise<AthleteReadResult<unknown[]>>;
  listActivities(input: { start: string; end?: string }): Promise<AthleteReadResult<unknown[]>>;
  getActivity(input: { id: string }): Promise<AthleteReadResult<unknown>>;
  getStreams(input: { id: string; keys: readonly string[] }): Promise<AthleteReadResult<unknown>>;
  listCalendar(input: { start: string; end?: string }): Promise<AthleteReadResult<unknown[]>>;
  freshness(): StoredDataFreshness | undefined;
}

export interface CalendarEventForDelete {
  readonly id: number;
  readonly startDateLocal: string;
  readonly name?: string | null;
  readonly category?: string | null;
  readonly tags?: string[] | null;
  readonly externalId?: string | null;
}

export interface CalendarEventUpdate {
  readonly startDateLocal?: string;
  readonly name?: string;
  readonly description?: string;
  readonly movingTime?: number;
  readonly icuTrainingLoad?: number;
  readonly workoutDoc?: unknown;
}

export interface PlatformCalendarMutationsPort {
  createEvent(input: EventInput): Promise<unknown>;
  readEventForDelete(input: { eventId: number }): Promise<CalendarEventForDelete>;
  updateEvent(input: { eventId: number; patch: CalendarEventUpdate }): Promise<unknown>;
  deleteEvent(input: { eventId: number }): Promise<unknown>;
}

export interface ToolConfirmationPort {
  /** Tools this host gates. The engine registers the confirmation prompt block iff this set is non-empty. */
  readonly gatedToolNames: ReadonlySet<string>;
  requiresConfirmation(input: { readonly chatId: string; readonly toolName: string }): boolean;
  /**
   * Record a proposal and return the value the model sees. MUST NOT invoke `run`;
   * `run` executes only when the host's own confirm surface resolves the proposal.
   */
  propose(input: {
    readonly chatId: string;
    readonly toolName: string;
    readonly toolInput: unknown;
    readonly run: () => Promise<unknown>;
  }): Promise<unknown>;
}

export interface PlatformClientPort {
  readonly legacyClient: IntervalsClient | null;
  readonly athleteData: AthleteDataReaderPort | undefined;
  readonly calendarMutations: PlatformCalendarMutationsPort;
}

export type LoggerFields = Record<string, unknown>;

export interface LoggerPort {
  debug(event: string, fields?: LoggerFields): void;
  info(event: string, fields?: LoggerFields): void;
  warn(event: string, error?: unknown, fields?: LoggerFields): void;
  error(event: string, error?: unknown, fields?: LoggerFields): void;
}

export type CallerRole =
  | "chat"
  | "flush"
  | "compact"
  | "sync-triage"
  | "dream"
  | "intent-translation";

export interface UsageCost {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly total: number;
}

export type UsageCostBasis = "notional" | "actual";

export interface UsageLedgerLine {
  readonly ts: number;
  readonly kind: "generate" | "turn" | "boot";
  readonly provider: string;
  readonly model: string;
  readonly durationMs: number;
  readonly caller?: CallerRole;
  readonly templateHash?: string;
  readonly steps?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly providerReportedCostUsd?: number;
  readonly costBasis?: UsageCostBasis;
  readonly cost?: UsageCost;
  readonly stopReason?: string;
}

export interface UsagePort {
  append(line: UsageLedgerLine): void;
}

export type FailureReason =
  | "overflow"
  | "timeout"
  | "rate_limit"
  | "server_error"
  | "network"
  | "auth"
  | "reauth"
  | "invalid_request"
  | "unknown";

export interface ModelTransportRequest {
  readonly provider: EngineLlmProvider;
  readonly model: string;
  readonly options: GenerateOptions;
}

export interface ModelTransport {
  generate(request: ModelTransportRequest): Promise<GenerateResult>;
}

export type ModelTransportDecorator = (next: ModelTransport) => ModelTransport;

export interface ChatStreamTimeouts {
  readonly ttftMs: number;
  readonly interChunkMs: number;
}

export interface AthleteStateReaderPort {
  getAthleteState(): Promise<AthleteState>;
}

export interface PlanningReadPort {
  getPlanningReadModel(): Promise<PlanningReadModel>;
}

export interface ReferenceStateSnapshot {
  readonly errorState: {
    readonly mitigation?: string;
    readonly ts: string;
  } | null;
  readonly latest: {
    readonly metadata?: { readonly last_updated?: string };
    readonly derived_metrics?: { readonly eftp?: number | null };
  } | null;
}

export interface LanguageResolverPort {
  resolveFor(input: {
    readonly chatId: string;
    readonly athleteText: string;
  }): Promise<LanguageResolution>;
}

export interface EngineHostPorts {
  readonly config: EngineConfig;
  readonly language: LanguageResolverPort;
  readonly memory: MemoryStorePort;
  readonly chatStore: ChatStorePort;
  readonly chatAttachments?: ChatAttachmentTurnPort;
  readonly attachmentCapabilities?: AttachmentCapabilitiesPort;
  readonly planningRead?: PlanningReadPort;
  readonly transcriptWriter: TranscriptWriterPort;
  readonly coachDecisions?: CoachDecisionStorePort;
  readonly secrets: SecretsPort;
  readonly platform: PlatformClientPort;
  readonly logger: LoggerPort;
  readonly usage: UsagePort;
  readonly stateReader: AthleteStateReaderPort;
  readonly readReferenceState: () => ReferenceStateSnapshot;
  readonly getAccessToken: (
    profileName: string,
    signal?: AbortSignal,
    rejectedAccessToken?: string,
  ) => Promise<string>;
  readonly classifyFailure: (error: unknown) => FailureReason;
  readonly extractRetryAfterMs: (error: unknown) => number | null;
  readonly now: () => number;
  readonly randomId: () => string;
  readonly chatStreamTimeouts?: ChatStreamTimeouts;
  readonly claudeWorkingArea?: ClaudeWorkingAreaPort;
  readonly modelTransportDecorator?: ModelTransportDecorator;
  readonly onToolsAssembled?: (names: readonly string[]) => void;
  readonly toolConfirmations?: ToolConfirmationPort;
}
