import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import {
  Memory,
  ConfirmationGate,
  RefreshTokenReusedError,
  appendUsageLine,
  bootstrapReference,
  classifyFailure,
  compareAndSaveStoredProfile,
  createConversationStore,
  createProposalSummarizers,
  createToolConfirmationPort,
  createMissingPlatformCalendarMutations,
  createPlatformCalendarMutations,
  createSubsystemLogger,
  deleteStoredProfile,
  engineConfigFromConfig,
  extractRetryAfterMs,
  isKeylessProvider,
  loadStoredProfileSnapshot,
  makeChatClient,
  refreshCodexToken,
  resolveRuntimeConfig,
  resolveSecretRef,
  sessionConfigEnvironmentOwnership,
  type ClaudeCliRuntimeConfigPatch,
  type CodexAgentRuntimeConfigPatch,
  type Config,
  type OAuthCredentialOwner,
  type ConversationStorePort,
  type ReferenceRuntime,
  type RuntimeConfigPatch,
  type StoredProfile,
  type StoredProfileSnapshot,
} from "@enduragent/core";
import {
  createAttachmentCapabilityResolver,
  createCoachEngine,
  transportForProvider,
  type CreateCoachEngineInput,
  type EngineConfig,
  type EngineHostPorts,
  type ChatAttachmentTurnPort,
  type ModelTransportDecorator,
  type PlanFtpSourceValue,
  type ReferenceStateSnapshot,
} from "@enduragent/engine";
import { resolveUserTimezone, todayInTZ } from "@enduragent/engine/sport";
import {
  createCyclingFtpAnchorResolver,
  type CyclingFtpAnchorResolver,
} from "@enduragent/kernel/anchors";
import {
  createAnchorRepository,
  createChatPlanOutboxRepository,
  createChatAttachmentRepository,
  createAnalyticsCurveStateReader,
  createCanonicalActivityReader,
  createIntervalsSourceRepository,
  createTrainingCoverageReader,
  createTrainingHistoryReader,
  createTrustedActivitySourceResolver,
  H,
  type AnchorRepository,
} from "@enduragent/kernel/store";
import { createReferenceCapturePlan } from "@enduragent/kernel/reference/capture";
import { ErrorStateSchema, LatestJsonSchema } from "@enduragent/kernel/reference/schemas";
import { createAuthoredIdentity, type AthleteHome } from "@enduragent/kernel-node/home";
import {
  createManagedActivityReader,
  createManagedChatAttachmentStore,
  createManagedDocumentReader,
  createManagedMediaReader,
} from "@enduragent/kernel-node/chat-attachments";
import { createVerifiedSnapshotReader } from "@enduragent/kernel-node/archive";
import { nodeFileSystem } from "@enduragent/kernel-node/filesystem";
import { createNodeCrypto, createNodeImportRuntime } from "@enduragent/kernel-node/ingest";
import {
  createLegacyPlanRepository,
  createLegacyPlanRowWriter,
  importLegacyCurrentPlan,
} from "@enduragent/kernel-node/planning";
import {
  createPlanDraftBuildRepository,
  createPlanIntakeRepository,
} from "@enduragent/kernel/planning";
import type { CoachStoreWriterContext } from "./runtime.js";
import {
  CHAT_ATTACHMENT_LIMITS,
  type ChatAttachmentReference,
  type CoachEngine,
  type CoachOperations,
  type ConfigureRuntimeRpcParams,
  type ConfigureRuntimeRpcRefusalReason,
  type GetArchivedTranscriptPageRpcParams,
  type GetArchivedTranscriptPageRpcResult,
  type GetTranscriptPageRpcParams,
  type GetTranscriptPageRpcResult,
  type ListArchivedConversationsRpcParams,
  type ListArchivedConversationsRpcResult,
  type GetRuntimeConfigRpcResult,
  type PlanningReadOperations,
  type CreatePlanningRequestPayload,
  type PlanningRequestOperations,
  type PlanningOperations,
  type VerifyIntervalsCredentialRpcParams,
  type VerifyIntervalsCredentialRpcResult,
} from "@enduragent/coach-contract";
import {
  createCyclingPlanFtpAdapter,
  cyclingSport,
  projectCyclingEstimatedCp,
  projectCyclingReadinessInput,
} from "@enduragent/sport-cycling";
import { projectAnalyticsCurveEvidence } from "@enduragent/sync-intervals-icu";
import { createPersistedAthleteStateSource } from "./athlete-state-reader.js";
import { createPowerProgressStateSource } from "./power-progress.js";
import { createTrainingHistorySource } from "./training-history.js";
import {
  assertRuntimeAthleteOwner,
  RuntimeAthleteOwnerRefusal,
  type RuntimeAthleteOwnerClaim,
} from "./backfill.js";
import {
  assertRuntimeAthleteOwnerFromEvidence,
  readIntervalsStoreOwnerState,
  type IntervalsCredentialVerificationEvidence,
  verifyIntervalsCredentialAtPathWithEvidence,
} from "./account-identity.js";
import {
  createIntervalsCredentialApprovalStore,
  digestIntervalsCredential,
  normalizeIntervalsAthleteSelector,
} from "./intervals-credential-approval.js";
import { createCoachEngineAdapter } from "./coach-engine-adapter.js";
import {
  createStoreRuntime,
  type StoreRuntime,
  type StoreRuntimeDependencies,
  type StoreRuntimeOptions,
} from "./store-runtime.js";
import { createCoachOperations } from "./operations.js";
import type { CoachOperationsDependencies } from "./operations.js";
import { createSpendMeterService, type SpendMeterService } from "./spend-meter.js";
import { createStoredActivityAnalysisService } from "./activity-analysis-service.js";
import { createAerobicDriftAnalyzer } from "./aerobic-drift.js";
import {
  createProviderActivityAnalysisClientAccess,
  createProviderActivityStreamReader,
} from "./activity-analysis-provider.js";
import {
  createProviderActivityBestEffortsArchive,
  createProviderActivityHistogramArchive,
  createProviderActivityIntervalsArchive,
  createProviderActivityPowerHeartRateArchive,
  createProviderActivityStreamArchive,
} from "./activity-analysis-archive.js";
import {
  createIntervalReviewAnalyzer,
  createProviderActivityIntervalReader,
} from "./activity-interval-review.js";
import {
  createBestEffortAnalyzer,
  createProviderActivityBestEffortReader,
} from "./activity-best-efforts.js";
import {
  createHeartRateDistributionAnalyzer,
  createPowerDistributionAnalyzer,
  createProviderActivityHistogramReader,
} from "./activity-distribution.js";
import {
  createPowerHeartRateAnalyzer,
  createProviderActivityPowerHeartRateReader,
} from "./activity-power-heart-rate.js";
import { createTrainingExportService } from "./training-export.js";
import { createPlanningOperations } from "./planning-operations.js";
import { createCyclingPlanDraftBuilder } from "./cycling-plan-draft-builder.js";
import { createPlanMirrorCalendarAdapter } from "./planning-calendar.js";
import { createNodePlanRaceCourseAdapter } from "./planning-race-course.js";
import { serializeBoundaryError } from "./daemon/error-boundary.js";
import { createManagedChatAttachmentOperations } from "./attachment-operations.js";
import { observeChatAttachment, type AttachmentObservation } from "./attachment-observability.js";
import { createActivityAttachmentOperations } from "./activity-attachment-operations.js";
import { createWorkoutAttachmentOperations } from "./workout-attachment-operations.js";
import { createManagedWorkoutReader } from "@enduragent/sport-cycling/workout-import";
import { createPersistentOpenRouterModelMetadataCache } from "./openrouter-model-metadata-cache.js";
import { createDocumentMediaAttachmentOperations } from "./document-media-attachment-operations.js";
import { createAttachmentComposerOperations } from "./attachment-composer-operations.js";
import { createPlanningReadService } from "./planning-read-service.js";
import { createPlanningRequestDeliveryService } from "./planning-request-delivery.js";
import { createPlanningRequestSourceCleanup } from "./planning-request-source-cleanup.js";
import {
  createPlanConversationRepository,
  createPlanningRequestIntakeRepository,
  createPlanningRequestRepository,
  createPlanRepository,
} from "@enduragent/kernel/planning";
import {
  createPlanningRequestIntakeService,
  createPlanningRequestPremiseReader,
} from "./planning-request-intake.js";

interface OAuthCredential extends StoredProfile {
  readonly type: "oauth";
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
  readonly accountId?: string;
  readonly email?: string;
}

export interface LocalCoachComposition {
  readonly engine: CoachEngine;
  readonly operations: CoachOperations &
    PlanningReadOperations &
    PlanningRequestOperations &
    PlanningOperations;
  readonly spendMeter: SpendMeterService;
  readonly confirmations: Pick<ConfirmationGate, "peek" | "confirm" | "cancel">;
  startInitialRefresh(): Promise<void>;
  close(): Promise<void>;
}

export interface LocalCoachCompositionInput {
  readonly env: Record<string, string | undefined>;
  readonly home: AthleteHome;
  readonly context: CoachStoreWriterContext;
  readonly config: Config;
  readonly engineConfig: EngineConfig;
  readonly deferInitialRefresh?: boolean;
  readonly oauthOwner?: OAuthCredentialOwner;
}

export interface LocalCoachCompositionDependencies {
  readonly bootstrap?: (
    options: Parameters<typeof bootstrapReference>[0],
  ) => Promise<LocalReferenceRuntime>;
  readonly createRuntime?: (options: LocalStoreRuntimeOptions) => LocalStoreRuntime;
  readonly runtimeDependencies?: StoreRuntimeDependencies;
  readonly createBackend?: typeof createCoachEngine;
  readonly createRepository?: (store: CoachStoreWriterContext["store"]) => AnchorRepository;
  readonly createResolver?: (repository: AnchorRepository) => CyclingFtpAnchorResolver;
  readonly now?: () => number;
  readonly platform?: NodeJS.Platform;
  readonly randomId?: () => string;
  readonly modelTransportDecorator?: ModelTransportDecorator;
  readonly onToolsAssembled?: (names: readonly string[]) => void;
  readonly closeHostAdapters?: () => void | Promise<void>;
  readonly operationsDependencies?: CoachOperationsDependencies;
  readonly persistRuntimeConfig?: typeof persistRuntimeConfig;
  readonly assertRuntimeAthleteOwner?: (
    ...args: Parameters<typeof assertRuntimeAthleteOwner>
  ) => Promise<RuntimeAthleteOwnerClaim | void>;
}

export interface LocalReferenceRuntime {
  readonly scheduler: { stop(): void };
  runScheduledOnce(signal?: AbortSignal): ReturnType<ReferenceRuntime["runScheduledOnce"]>;
}

export interface LocalStoreRuntime {
  readonly athleteData: StoreRuntime["athleteData"];
  currentDroppedActivities(): ReturnType<StoreRuntime["currentDroppedActivities"]>;
  attemptLedgerForRun(): ReturnType<StoreRuntime["attemptLedgerForRun"]>;
  runWindow(): ReturnType<StoreRuntime["runWindow"]>;
  runWindowAfter(
    work: (signal: AbortSignal) => Promise<void>,
  ): ReturnType<StoreRuntime["runWindow"]>;
  runExclusive: StoreRuntime["runExclusive"];
  runActivityWrite: StoreRuntime["runActivityWrite"];
  startScheduler(): void;
  close(): Promise<void>;
}

export type LocalStoreRuntimeOptions = Omit<StoreRuntimeOptions, "reference"> & {
  readonly reference: LocalReferenceRuntime;
};

export const INITIAL_REFRESH_RETRY_BASE_DELAY_MS = 1_000;
export const INITIAL_REFRESH_RETRY_MAX_DELAY_MS = 300_000;

function copyConfig(config: Config): Config {
  return {
    ...config,
    llm: { ...config.llm },
    intervals: { ...config.intervals },
    telegram: { ...config.telegram },
    session: { ...config.session },
  };
}

function approvedRuntimeConfig(config: Config, intervalsOwnerReady: boolean): Config {
  if (intervalsOwnerReady || config.intervals.apiKey.length === 0) return config;
  return {
    ...config,
    intervals: { ...config.intervals, apiKey: "" },
  };
}

function claudeCliPatch(
  block: NonNullable<NonNullable<ConfigureRuntimeRpcParams["llm"]>["claude_cli"]>,
): ClaudeCliRuntimeConfigPatch {
  return {
    ...(block.enabled === undefined ? {} : { enabled: block.enabled }),
    ...(block.binary_path === undefined ? {} : { binaryPath: block.binary_path }),
    ...(block.config_dir === undefined ? {} : { configDir: block.config_dir }),
    ...(block.billing === undefined ? {} : { billing: block.billing }),
  };
}

function codexAgentPatch(
  block: NonNullable<NonNullable<ConfigureRuntimeRpcParams["llm"]>["codex_agent"]>,
): CodexAgentRuntimeConfigPatch {
  return {
    ...(block.enabled === undefined ? {} : { enabled: block.enabled }),
    ...(block.binary_path === undefined ? {} : { binaryPath: block.binary_path }),
    ...(block.reasoning_effort === undefined ? {} : { reasoningEffort: block.reasoning_effort }),
  };
}

function runtimePatch(request: ConfigureRuntimeRpcParams, config: Config): RuntimeConfigPatch {
  return {
    ...(request.llm === undefined
      ? {}
      : {
          llm: {
            provider: request.llm.provider,
            model: request.llm.model,
            apiKey:
              request.llm.clear_credential === true && config.llm.provider !== "openai-codex"
                ? ""
                : request.llm.api_key,
            baseUrl: request.llm.base_url,
            flushModel: request.llm.flush_model,
            compactModel: request.llm.compact_model,
            ...(request.llm.claude_cli === undefined
              ? {}
              : { claudeCli: claudeCliPatch(request.llm.claude_cli) }),
            ...(request.llm.codex_agent === undefined
              ? {}
              : { codexAgent: codexAgentPatch(request.llm.codex_agent) }),
          },
        }),
    ...(request.intervals === undefined
      ? {}
      : {
          intervals: {
            apiKey: request.intervals.clear_credential === true ? "" : request.intervals.api_key,
            athleteId: request.intervals.athlete_id,
          },
        }),
    ...(request.session === undefined ? {} : { session: { ...request.session } }),
  };
}

function mergedRuntimeConfig(config: Config, request: ConfigureRuntimeRpcParams): Config {
  return {
    ...config,
    ...resolveRuntimeConfig(
      runtimePatch(request, config),
      config,
      request.llm?.clear_credential === true && config.llm.provider === "openai-codex"
        ? { authProfile: config.llm.authProfile ?? "openai-codex" }
        : undefined,
    ),
  };
}

const LLM_CREDENTIAL_ENVIRONMENT_KEYS = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  "openai-codex": undefined,
  "claude-cli": undefined,
  "codex-agent": undefined,
  deepseek: "DEEPSEEK_API_KEY",
  qwen: "ALIBABA_API_KEY",
  minimax: "MINIMAX_API_KEY",
  kimi: "MOONSHOT_API_KEY",
  zai: "ZAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
} as const;

function nonemptyEnvironmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  key: string | undefined,
): boolean {
  return key !== undefined && environment[key] !== undefined && environment[key] !== "";
}

function llmCredentialManagedByEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  provider: Config["llm"]["provider"],
): boolean {
  return (
    nonemptyEnvironmentValue(environment, LLM_CREDENTIAL_ENVIRONMENT_KEYS[provider]) ||
    (!isKeylessProvider(provider) && nonemptyEnvironmentValue(environment, "LLM_API_KEY"))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assignOptionalField(
  target: Record<string, unknown>,
  field: string,
  value: string | undefined,
): void {
  if (value === undefined) delete target[field];
  else target[field] = value;
}

function replacePrivateFile(path: string, content: string | Uint8Array): void {
  const temporaryPath = `${path}.tmp.${randomBytes(4).toString("hex")}`;
  try {
    writeFileSync(temporaryPath, content, { mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {}
    throw error;
  }
}

interface RuntimeConfigFileSnapshot {
  readonly content?: Buffer;
}

function captureRuntimeConfigFile(configDir: string): RuntimeConfigFileSnapshot {
  const path = join(configDir, "config.yaml");
  return existsSync(path) ? { content: readFileSync(path) } : {};
}

function restoreRuntimeConfigFile(configDir: string, snapshot: RuntimeConfigFileSnapshot): void {
  const path = join(configDir, "config.yaml");
  if (snapshot.content !== undefined) {
    replacePrivateFile(path, snapshot.content);
    return;
  }
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function persistRuntimeConfig(
  configDir: string,
  candidate: Config,
  request: ConfigureRuntimeRpcParams,
  previous: Config,
): void {
  const path = join(configDir, "config.yaml");
  const parsed = existsSync(path) ? (parseYaml(readFileSync(path, "utf8")) as unknown) : {};
  if (!isRecord(parsed)) throw new TypeError("Runtime config must be a map.");
  const next = { ...parsed };
  if (request.llm !== undefined) {
    const existing =
      candidate.llm.provider === previous.llm.provider &&
      isRecord(parsed.llm) &&
      (parsed.llm.provider === undefined || parsed.llm.provider === candidate.llm.provider)
        ? parsed.llm
        : {};
    const llm: Record<string, unknown> = {
      ...existing,
      provider: candidate.llm.provider,
      model: candidate.llm.model,
    };
    if (candidate.llm.provider === "openai-codex") {
      llm.auth_profile = candidate.llm.authProfile ?? "openai-codex";
    } else delete llm.auth_profile;
    assignOptionalField(llm, "base_url", candidate.llm.baseUrl);
    assignOptionalField(llm, "flush_model", candidate.llm.flushModel);
    assignOptionalField(llm, "compact_model", candidate.llm.compactModel);
    if (request.llm.claude_cli !== undefined) {
      const block: Record<string, unknown> = isRecord(llm.claude_cli) ? { ...llm.claude_cli } : {};
      for (const [field, value] of Object.entries(request.llm.claude_cli)) {
        if (value === null) delete block[field];
        else block[field] = value;
      }
      llm.claude_cli = block;
    }
    if (request.llm.codex_agent !== undefined) {
      const block: Record<string, unknown> = isRecord(llm.codex_agent)
        ? { ...llm.codex_agent }
        : {};
      for (const [field, value] of Object.entries(request.llm.codex_agent)) {
        if (value === null) delete block[field];
        else block[field] = value;
      }
      llm.codex_agent = block;
    }
    next.llm = llm;
  }
  if (request.intervals !== undefined) {
    next.intervals = {
      ...(isRecord(parsed.intervals) ? parsed.intervals : {}),
      athlete_id: candidate.intervals.athleteId,
    };
  }
  if (request.session !== undefined) {
    const session: Record<string, unknown> = {
      ...(isRecord(parsed.session) ? parsed.session : {}),
    };
    for (const field of [
      "historyTokenBudgetRatio",
      "idleMinutes",
      "dailyResetHour",
      "resetArchiveRetentionDays",
      "timezone",
    ] as const) {
      if (request.session[field] !== undefined) {
        session[field] = candidate.session[field];
      }
    }
    if (request.session.timezone !== undefined) session.timezonePinned = true;
    next.session = session;
  }
  replacePrivateFile(path, toYaml(next));
}

async function runtimeCredentialConfigured(
  configDir: string,
  config: Config,
  oauthOwner?: OAuthCredentialOwner,
): Promise<boolean> {
  if (config.llm.provider === "openai-codex") {
    if (oauthOwner !== undefined)
      return oauthOwner.hasProfile(config.llm.authProfile ?? "openai-codex");
    try {
      const snapshot = loadStoredProfileSnapshot(
        join(configDir, "auth-profiles.json"),
        config.llm.authProfile ?? "openai-codex",
      );
      if (snapshot === null) return false;
      credential(snapshot.profile);
      return true;
    } catch {
      return false;
    }
  }
  if (isKeylessProvider(config.llm.provider)) return true;
  return config.llm.apiKey.length > 0;
}

async function runtimeConfigSnapshot(
  configDir: string,
  config: Config,
  environment: Readonly<Record<string, string | undefined>>,
  timezone: string,
  intervalsVerificationPending: boolean,
  oauthOwner?: OAuthCredentialOwner,
): Promise<GetRuntimeConfigRpcResult> {
  return {
    schemaVersion: 3,
    llm: {
      provider: config.llm.provider,
      model: config.llm.model,
      credential_configured: await runtimeCredentialConfigured(configDir, config, oauthOwner),
    },
    intervals: {
      athlete_id: config.intervals.athleteId,
      credential_configured: config.intervals.apiKey.length > 0,
      credential_verification_pending: intervalsVerificationPending,
      managedByEnvironment: {
        athleteId: environment.INTERVALS_ATHLETE_ID !== undefined,
      },
    },
    session: {
      ...config.session,
      timezone,
      managedByEnvironment: sessionConfigEnvironmentOwnership(environment),
    },
  };
}

interface RuntimeBundle {
  readonly engine: CoachEngine;
  readonly memory: Memory;
  readonly chatStore: ConversationStorePort;
  readonly spendMeter: SpendMeterService;
  readonly timezone: string;
  readonly confirmations: ConfirmationGate;
}

function createReconfigurableRuntimeBundle(initial: RuntimeBundle): {
  readonly engine: CoachEngine;
  readonly spendMeter: SpendMeterService;
  readonly confirmations: Pick<ConfirmationGate, "peek" | "confirm" | "cancel">;
  readonly getTranscriptPage: (
    request: GetTranscriptPageRpcParams,
  ) => Promise<GetTranscriptPageRpcResult>;
  readonly listArchivedConversations: (
    request: ListArchivedConversationsRpcParams,
  ) => Promise<ListArchivedConversationsRpcResult>;
  readonly getArchivedTranscriptPage: (
    request: GetArchivedTranscriptPageRpcParams,
  ) => Promise<GetArchivedTranscriptPageRpcResult>;
  readonly withChatStore: <T>(
    operation: (store: ConversationStorePort) => Promise<T>,
  ) => Promise<T>;
  replace<T>(
    prepare: () => T | Promise<T>,
    commit: (prepared: T) => RuntimeBundle | Promise<RuntimeBundle>,
  ): Promise<void>;
} {
  let active = initial;
  let admission = Promise.resolve();
  let activeCalls = 0;
  let pendingReplacements = 0;
  const drainWaiters = new Set<() => void>();

  const run = async <T>(operation: (bundle: RuntimeBundle) => Promise<T>): Promise<T> => {
    await admission;
    activeCalls += 1;
    const selected = active;
    try {
      return await operation(selected);
    } finally {
      activeCalls -= 1;
      if (activeCalls === 0) {
        for (const resolve of drainWaiters) resolve();
        drainWaiters.clear();
      }
    }
  };

  return {
    engine: {
      chat: (request, onEvent) => run((bundle) => bundle.engine.chat(request, onEvent)),
      stopChat: (request) =>
        run(async (bundle) => bundle.engine.stopChat?.(request) ?? { stopped: false }),
      enqueueChatMessage: (request) => run((bundle) => bundle.engine.enqueueChatMessage!(request)),
      getChatQueue: (request) => run((bundle) => bundle.engine.getChatQueue!(request)),
      removeQueuedChatMessage: (request) =>
        run((bundle) => bundle.engine.removeQueuedChatMessage!(request)),
      resumeChatQueue: (request, onEvent) =>
        run((bundle) => bundle.engine.resumeChatQueue!(request, onEvent)),
      runQueuedCommand: (request, onEvent) =>
        run((bundle) => bundle.engine.runQueuedCommand!(request, onEvent)),
      retryQueuedTurn: (request, onEvent) =>
        run((bundle) => bundle.engine.retryQueuedTurn!(request, onEvent)),
      getCoachDecision: (request) => run((bundle) => bundle.engine.getCoachDecision(request)),
      answerCoachDecision: (request, onEvent) =>
        run((bundle) => bundle.engine.answerCoachDecision(request, onEvent)),
      skipCoachDecision: (request) => run((bundle) => bundle.engine.skipCoachDecision(request)),
      resumeCoachDecision: (request, onEvent) =>
        run((bundle) => bundle.engine.resumeCoachDecision(request, onEvent)),
      resetSession: (request) => run((bundle) => bundle.engine.resetSession(request)),
      hasSession: (request) => run((bundle) => bundle.engine.hasSession(request)),
      getAthleteState: () => run((bundle) => bundle.engine.getAthleteState()),
    },
    spendMeter: {
      getSpendSummary: () => run((bundle) => bundle.spendMeter.getSpendSummary()),
      setDailySpendCap: (dailyCapUsd) =>
        run((bundle) => bundle.spendMeter.setDailySpendCap(dailyCapUsd)),
    },
    confirmations: {
      peek: (chatId) => (pendingReplacements === 0 ? active.confirmations.peek(chatId) : undefined),
      confirm: (chatId, nonce) => run((bundle) => bundle.confirmations.confirm(chatId, nonce)),
      cancel: (chatId, nonce) =>
        pendingReplacements === 0 ? active.confirmations.cancel(chatId, nonce) : "none",
    },
    getTranscriptPage: (request) =>
      run(async (bundle) => bundle.chatStore.readCurrentConversationPage("desktop", request)),
    listArchivedConversations: () =>
      run(async (bundle) => bundle.chatStore.listArchivedConversations("desktop")),
    getArchivedTranscriptPage: ({ boundaryRef, ...request }) =>
      run(async (bundle) =>
        bundle.chatStore.readArchivedConversationPage("desktop", boundaryRef, request),
      ),
    withChatStore: (operation) => run((bundle) => operation(bundle.chatStore)),
    async replace(prepare, commit) {
      pendingReplacements += 1;
      const previousAdmission = admission;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      admission = previousAdmission.then(() => barrier);
      await previousAdmission;
      try {
        const prepared = await prepare();
        if (activeCalls > 0) {
          await new Promise<void>((resolve) => drainWaiters.add(resolve));
        }
        active = await commit(prepared);
      } finally {
        pendingReplacements -= 1;
        release();
      }
    },
  };
}

function readReferenceState(dataDir: string): ReferenceStateSnapshot {
  const referenceDir = join(dataDir, "data");
  const read = <T>(
    path: string,
    parse: (value: unknown) => { success: boolean; data?: T },
  ): T | null => {
    try {
      const result = parse(JSON.parse(readFileSync(path, "utf8")) as unknown);
      return result.success ? (result.data ?? null) : null;
    } catch {
      return null;
    }
  };
  return {
    errorState: read(join(referenceDir, "error_state.json"), (value) =>
      ErrorStateSchema.safeParse(value),
    ),
    latest: read(join(referenceDir, "latest.json"), (value) => LatestJsonSchema.safeParse(value)),
  };
}

function readLatestReference(dataDir: string) {
  try {
    const value = JSON.parse(readFileSync(join(dataDir, "data", "latest.json"), "utf8")) as unknown;
    const result = LatestJsonSchema.safeParse(value);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function credential(value: unknown): OAuthCredential {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("OAuth profile is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.type !== "oauth" ||
    typeof candidate.access !== "string" ||
    candidate.access.length === 0 ||
    typeof candidate.refresh !== "string" ||
    candidate.refresh.length === 0 ||
    typeof candidate.expires !== "number" ||
    !Number.isFinite(candidate.expires) ||
    (candidate.accountId !== undefined && typeof candidate.accountId !== "string") ||
    (candidate.email !== undefined && typeof candidate.email !== "string")
  ) {
    throw new TypeError("OAuth profile is invalid.");
  }
  return candidate as unknown as OAuthCredential;
}

function createAccessTokenReader(configDir: string): EngineHostPorts["getAccessToken"] {
  const path = join(configDir, "auth-profiles.json");
  const queues = new Map<string, Promise<string>>();
  const delay = (milliseconds: number, signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted();
    if (signal === undefined) {
      return new Promise((resolve) => setTimeout(resolve, milliseconds));
    }
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        clearTimeout(timeout);
        reject(signal.reason);
      };
      const timeout = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, milliseconds);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  };
  const refresh = async (
    profileName: string,
    initial: StoredProfileSnapshot,
    current: OAuthCredential,
    signal?: AbortSignal,
  ) => {
    try {
      return {
        refreshed: await refreshCodexToken(current.refresh, signal),
        requestSnapshot: initial,
        requestProfile: current,
      };
    } catch (error) {
      signal?.throwIfAborted();
      if (classifyFailure(error) !== "reauth") throw error;
      await delay(2_000, signal);
      const requestSnapshot = loadStoredProfileSnapshot(path, profileName);
      if (requestSnapshot === null) throw new TypeError("OAuth profile is invalid.");
      const requestProfile = credential(requestSnapshot.profile);
      try {
        return {
          refreshed: await refreshCodexToken(requestProfile.refresh, signal),
          requestSnapshot,
          requestProfile,
        };
      } catch (retryError) {
        signal?.throwIfAborted();
        if (classifyFailure(retryError) === "reauth") {
          throw new RefreshTokenReusedError(profileName, retryError);
        }
        throw retryError;
      }
    }
  };
  const exclusive = async (
    profileName: string,
    signal?: AbortSignal,
    rejectedAccessToken?: string,
  ): Promise<string> => {
    const snapshot = loadStoredProfileSnapshot(path, profileName);
    if (snapshot === null) throw new TypeError("OAuth profile is invalid.");
    const current = credential(snapshot.profile);
    if (rejectedAccessToken === undefined || current.access !== rejectedAccessToken) {
      return current.access;
    }
    const { refreshed, requestSnapshot, requestProfile } = await refresh(
      profileName,
      snapshot,
      current,
      signal,
    );
    const next = {
      ...requestProfile,
      type: "oauth",
      access: refreshed.access,
      refresh: refreshed.refresh,
      expires: refreshed.expires,
      accountId: refreshed.accountId ?? requestProfile.accountId,
      email: requestProfile.email,
    } satisfies OAuthCredential;
    const saved = await compareAndSaveStoredProfile(path, profileName, requestSnapshot, next);
    if (saved.status === "missing") throw new TypeError("OAuth profile is invalid.");
    return credential(saved.profile).access;
  };
  return async (profileName, signal, rejectedAccessToken) => {
    const previous = queues.get(profileName) ?? Promise.resolve("");
    const current = previous.then(
      () => exclusive(profileName, signal, rejectedAccessToken),
      () => exclusive(profileName, signal, rejectedAccessToken),
    );
    queues.set(profileName, current);
    try {
      return await current;
    } finally {
      if (queues.get(profileName) === current) queues.delete(profileName);
    }
  };
}

function sameHome(left: AthleteHome, right: AthleteHome): boolean {
  return (
    left.root === right.root &&
    left.storeDir === right.storeDir &&
    left.archiveDir === right.archiveDir &&
    left.configDir === right.configDir
  );
}

export async function createLocalCoachComposition(
  input: LocalCoachCompositionInput,
  dependencies: LocalCoachCompositionDependencies = {},
): Promise<LocalCoachComposition> {
  if (!sameHome(input.home, input.context.home)) {
    throw new TypeError("Writer home does not match the selected athlete home.");
  }
  if (input.config.dataDir !== input.home.root) {
    throw new TypeError("Configured data directory does not match the selected athlete home.");
  }
  const projected = engineConfigFromConfig(input.config);
  if (JSON.stringify(projected) !== JSON.stringify(input.engineConfig)) {
    throw new TypeError("Ready engine configuration does not match the selected athlete home.");
  }
  const now = dependencies.now ?? Date.now;
  const logger = createSubsystemLogger("agent", input.home.root);
  const planningIdentity = createAuthoredIdentity(input.home.configDir, { now });
  const planningRepository = createLegacyPlanRepository(input.context.store);
  const planningTimezone = resolveUserTimezone(input.config.session.timezone);
  const planningDateKey = (): number =>
    Number(todayInTZ(planningTimezone, new Date(now())).replaceAll("-", ""));
  await importLegacyCurrentPlan({
    home: input.home,
    store: input.context.store,
    identity: planningIdentity,
    importDateKey: planningDateKey(),
    importTimestampMs: now(),
    logger: { warn: () => logger.warn("legacy_plan_import_skipped") },
  });
  const persistPlan = await createLegacyPlanRowWriter({
    repository: planningRepository,
    identity: planningIdentity,
    fallbackDateKey: planningDateKey,
    now,
  });
  const ownerClock = { now, monotonicNow: () => performance.now() };
  const referencePlan = (config: Config) =>
    createReferenceCapturePlan({
      now: new Date(now()),
      calendarTimeZone: resolveUserTimezone(config.session.timezone),
    });
  const intervalsCredentialApprovals = createIntervalsCredentialApprovalStore({ now });
  let intervalsConfigRevision = 0;
  const ownerLookup = (config: Config) => ({
    apiKey: config.intervals.apiKey,
    athleteId: config.intervals.athleteId.length === 0 ? "0" : config.intervals.athleteId,
    historyNewestDate: referencePlan(config).window.newest,
    clock: ownerClock,
  });
  const assertIntervalsOwner = async (
    current: Config,
    candidate: Config,
    signal: AbortSignal,
    claimUnownedCandidateWithoutCurrent = false,
    verificationEvidence?: IntervalsCredentialVerificationEvidence,
  ): Promise<RuntimeAthleteOwnerClaim | undefined> => {
    if (verificationEvidence !== undefined) {
      return await assertRuntimeAthleteOwnerFromEvidence(
        input.context.store,
        verificationEvidence,
        signal,
      );
    }
    const approval = await (dependencies.assertRuntimeAthleteOwner ?? assertRuntimeAthleteOwner)(
      input.context.store,
      {
        current: ownerLookup(current),
        candidate: ownerLookup(candidate),
        signal,
        ...(claimUnownedCandidateWithoutCurrent
          ? { claimUnownedCandidateWithoutCurrent: true }
          : {}),
      },
    );
    return approval ?? undefined;
  };
  let unapprovedConfig = copyConfig(input.config);
  if (
    unapprovedConfig.intervals.apiKey.length > 0 &&
    unapprovedConfig.intervals.athleteId.length === 0
  ) {
    unapprovedConfig = {
      ...unapprovedConfig,
      intervals: { ...unapprovedConfig.intervals, athleteId: "0" },
    };
  }
  const verifyIntervalsCredential = async (
    request: VerifyIntervalsCredentialRpcParams,
    signal: AbortSignal,
  ): Promise<VerifyIntervalsCredentialRpcResult> => {
    const configuredAthleteSelector = normalizeIntervalsAthleteSelector(
      unapprovedConfig.intervals.athleteId,
    );
    const configRevision = intervalsConfigRevision;
    let athleteSelector = configuredAthleteSelector;
    let usedCurrentAthleteFallback = false;
    const verificationPlan = referencePlan(unapprovedConfig);
    let verification = await verifyIntervalsCredentialAtPathWithEvidence(
      join(input.home.storeDir, "store.db"),
      {
        apiKey: request.api_key,
        athleteId: athleteSelector,
        historyNewestDate: verificationPlan.window.newest,
        clock: ownerClock,
        signal,
      },
    );
    if (
      verification.status === "refused" &&
      verification.reason === "credential-rejected" &&
      configuredAthleteSelector !== "0"
    ) {
      signal.throwIfAborted();
      athleteSelector = "0";
      usedCurrentAthleteFallback = true;
      verification = await verifyIntervalsCredentialAtPathWithEvidence(
        join(input.home.storeDir, "store.db"),
        {
          apiKey: request.api_key,
          athleteId: athleteSelector,
          historyNewestDate: verificationPlan.window.newest,
          clock: ownerClock,
          signal,
        },
      );
    }
    if (verification.status === "refused") return { reason: verification.reason };
    signal.throwIfAborted();
    if (usedCurrentAthleteFallback && verification.evidence.ownerState.status === "unowned") {
      return { reason: "owner-unresolved" };
    }
    return {
      approval: intervalsCredentialApprovals.issue({
        apiKey: request.api_key,
        configuredAthleteSelector,
        athleteSelector,
        evidence: verification.evidence,
        configRevision,
      }),
    };
  };
  let runtime: LocalStoreRuntime | undefined;
  let reference: LocalReferenceRuntime | undefined;
  let initialRefreshPromise: Promise<void> | undefined;
  let initialRefreshRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let initialRefreshFailedAttempts = 0;
  const initialRefreshController = new AbortController();
  let intervalsOwnerReady = unapprovedConfig.intervals.apiKey.length === 0;
  const approvedConfig = (): Config => approvedRuntimeConfig(unapprovedConfig, intervalsOwnerReady);
  const intervalsVerificationPending = (): boolean =>
    unapprovedConfig.intervals.apiKey.length > 0 && !intervalsOwnerReady;
  let initialRefreshStarted = !input.deferInitialRefresh;
  let initialRefreshConfigCaptured = !input.deferInitialRefresh;
  let schedulerStarted = false;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  try {
    if (!input.deferInitialRefresh && unapprovedConfig.intervals.apiKey.length > 0) {
      const startupOwnerClaim = await assertIntervalsOwner(
        unapprovedConfig,
        unapprovedConfig,
        new AbortController().signal,
      );
      await startupOwnerClaim?.claim();
      intervalsOwnerReady = true;
    }
    reference = await (dependencies.bootstrap ?? bootstrapReference)({
      dataDir: input.home.root,
      intervals: approvedConfig().intervals,
      readIntervals: () => approvedConfig().intervals,
      readCalendarTimeZone: () => resolveUserTimezone(approvedConfig().session.timezone),
      sport: cyclingSport,
      startScheduler: false,
      attemptLedgerForRun: () => {
        if (runtime === undefined)
          throw new Error("Store runtime has not started its paired window.");
        return runtime.attemptLedgerForRun();
      },
    });
    const runtimeOptions: LocalStoreRuntimeOptions = {
      env: input.env,
      config: approvedConfig(),
      readConfig: () => approvedConfig(),
      home: input.home,
      reference,
      writerContext: input.context,
      dependencies: dependencies.runtimeDependencies,
      ...(dependencies.platform === undefined ? {} : { platform: dependencies.platform }),
    };
    runtime =
      dependencies.createRuntime === undefined
        ? createStoreRuntime({
            ...runtimeOptions,
            reference: reference as ReferenceRuntime,
          })
        : dependencies.createRuntime(runtimeOptions);
    if (!input.deferInitialRefresh) {
      await runtime.runWindow();
      if (unapprovedConfig.intervals.apiKey.length > 0) {
        runtime.startScheduler();
        schedulerStarted = true;
      }
    }
    const logger = createSubsystemLogger("agent", input.home.root);
    const observeAttachment = (observation: AttachmentObservation): void => {
      observeChatAttachment(logger, observation);
    };
    let cleanupPlanningRequestSources:
      | ReturnType<typeof createPlanningRequestSourceCleanup>
      | undefined;
    const attachmentRepository = createChatAttachmentRepository(input.context.store);
    const attachmentObjects = createManagedChatAttachmentStore({
      archiveDir: input.home.archiveDir,
      kindByteLimits: {
        document: CHAT_ATTACHMENT_LIMITS.documentBytes,
        activity: CHAT_ATTACHMENT_LIMITS.activityBytes,
        workout: CHAT_ATTACHMENT_LIMITS.workoutBytes,
        image: CHAT_ATTACHMENT_LIMITS.imageBytes,
      },
      ...(dependencies.platform === undefined ? {} : { platform: dependencies.platform }),
      now,
    });
    const activityAttachmentOperations = createActivityAttachmentOperations({
      repository: attachmentRepository,
      reader: createManagedActivityReader({
        objects: attachmentObjects,
        limits: {
          activityBytes: CHAT_ATTACHMENT_LIMITS.activityBytes,
          parserMs: CHAT_ATTACHMENT_LIMITS.parserMs,
          parserOldGenerationMiB: CHAT_ATTACHMENT_LIMITS.parserOldGenerationMiB,
          sessions: 256,
        },
      }),
      importer: createNodeImportRuntime({
        archiveDir: input.home.archiveDir,
        store: input.context.store,
      }),
      store: input.context.store,
      runExclusive: (work) => runtime!.runExclusive(work),
      now,
    });
    const workoutLimits = {
      candidates: CHAT_ATTACHMENT_LIMITS.workoutCandidates,
      segmentsPerWorkout: CHAT_ATTACHMENT_LIMITS.workoutSegments,
      durationSeconds: CHAT_ATTACHMENT_LIMITS.workoutDurationSeconds,
      diagnostics: CHAT_ATTACHMENT_LIMITS.workoutDiagnostics,
      diagnosticChars: CHAT_ATTACHMENT_LIMITS.workoutDiagnosticChars,
      titleChars: CHAT_ATTACHMENT_LIMITS.workoutTitleChars,
      purposeChars: CHAT_ATTACHMENT_LIMITS.workoutPurposeChars,
    } as const;
    const workoutAttachmentOperations = createWorkoutAttachmentOperations({
      repository: attachmentRepository,
      reader: createManagedWorkoutReader({
        objects: attachmentObjects,
        limits: {
          ...workoutLimits,
          workoutBytes: CHAT_ATTACHMENT_LIMITS.workoutBytes,
          parserMs: CHAT_ATTACHMENT_LIMITS.parserMs,
          parserOldGenerationMiB: CHAT_ATTACHMENT_LIMITS.parserOldGenerationMiB,
        },
      }),
      limits: workoutLimits,
      runExclusive: (work) => runtime!.runExclusive(work),
      now,
    });
    const documentMediaAttachmentOperations = createDocumentMediaAttachmentOperations({
      repository: attachmentRepository,
      documents: createManagedDocumentReader({
        objects: attachmentObjects,
        limits: {
          documentBytes: CHAT_ATTACHMENT_LIMITS.documentBytes,
          extractedTextChars: CHAT_ATTACHMENT_LIMITS.extractedTextChars,
          pdfPages: CHAT_ATTACHMENT_LIMITS.pdfPages,
          pdfVisualPages: CHAT_ATTACHMENT_LIMITS.pdfVisualPages,
          pdfUsefulTextCharsPerPage: CHAT_ATTACHMENT_LIMITS.pdfUsefulTextCharsPerPage,
          docxEntries: CHAT_ATTACHMENT_LIMITS.docxEntries,
          docxExpandedBytes: CHAT_ATTACHMENT_LIMITS.docxExpandedBytes,
          docxCompressionRatio: CHAT_ATTACHMENT_LIMITS.docxCompressionRatio,
          csvRows: CHAT_ATTACHMENT_LIMITS.csvRows,
          csvColumns: CHAT_ATTACHMENT_LIMITS.csvColumns,
          csvRecordChars: CHAT_ATTACHMENT_LIMITS.csvRecordChars,
          parserMs: CHAT_ATTACHMENT_LIMITS.parserMs,
          parserOldGenerationMiB: CHAT_ATTACHMENT_LIMITS.parserOldGenerationMiB,
        },
      }),
      media: createManagedMediaReader({
        objects: attachmentObjects,
        limits: {
          imageBytes: CHAT_ATTACHMENT_LIMITS.imageBytes,
          imageDimension: CHAT_ATTACHMENT_LIMITS.imageDimension,
          imagePixels: CHAT_ATTACHMENT_LIMITS.imagePixels,
          documentBytes: CHAT_ATTACHMENT_LIMITS.documentBytes,
          pdfPages: CHAT_ATTACHMENT_LIMITS.pdfPages,
          pdfVisualPages: CHAT_ATTACHMENT_LIMITS.pdfVisualPages,
          pdfVisualPixels: CHAT_ATTACHMENT_LIMITS.pdfVisualPixels,
          pdfPageDimension: CHAT_ATTACHMENT_LIMITS.pdfPageDimension,
          parserMs: CHAT_ATTACHMENT_LIMITS.parserMs,
          parserOldGenerationMiB: CHAT_ATTACHMENT_LIMITS.parserOldGenerationMiB,
        },
      }),
      runExclusive: (work) => runtime!.runExclusive(work),
      now,
    });
    const attachmentOperations = createManagedChatAttachmentOperations({
      repository: attachmentRepository,
      objects: attachmentObjects,
      runExclusive: (work) => runtime!.runExclusive(work),
      now,
      observe: observeAttachment,
      beforeConversationCleanup: async (conversationId) => {
        if (cleanupPlanningRequestSources === undefined) {
          throw new Error("Planning request source cleanup is unavailable.");
        }
        await cleanupPlanningRequestSources(conversationId);
      },
      onAdmitted: async (admitted) => {
        observeAttachment({
          operation: "admission",
          kind: admitted.attachment.kind,
          result: "accepted",
          byteSize: admitted.attachment.byte_size,
          durationMs: Math.max(0, now() - admitted.attachment.created_at_ms),
          count: 1,
        });
        const startedAt = now();
        try {
          await documentMediaAttachmentOperations.preprocessAdmitted(admitted);
          await activityAttachmentOperations.preprocessAdmitted(admitted);
          await workoutAttachmentOperations.preprocessAdmitted(admitted);
          const current = await attachmentRepository.readAttachment(admitted.attachment.id);
          let parserVersion: string | undefined;
          if (current?.state_json !== null && current?.state_json !== undefined) {
            try {
              const state = JSON.parse(current.state_json) as Record<string, unknown>;
              const candidate = state.parserVersion ?? state.readerVersion;
              if (typeof candidate === "string") parserVersion = candidate;
            } catch {
              parserVersion = undefined;
            }
          }
          observeAttachment({
            operation: "preprocess",
            kind: admitted.attachment.kind,
            result:
              current?.status === "ready"
                ? "ready"
                : current?.status === "blocked"
                  ? "blocked"
                  : "failed",
            byteSize: admitted.attachment.byte_size,
            durationMs: now() - startedAt,
            count: 1,
            ...(parserVersion === undefined ? {} : { parserVersion }),
          });
        } catch (error) {
          observeAttachment({
            operation: "preprocess",
            kind: admitted.attachment.kind,
            result: "failed",
            byteSize: admitted.attachment.byte_size,
            durationMs: now() - startedAt,
            count: 1,
          });
          throw error;
        }
      },
    });
    await attachmentOperations.reconcile();
    const getAccessToken =
      input.oauthOwner === undefined
        ? createAccessTokenReader(input.home.configDir)
        : input.oauthOwner.getAccessToken.bind(input.oauthOwner);
    const openRouterModelMetadata = createPersistentOpenRouterModelMetadataCache(
      input.home.configDir,
    );
    const resolveAttachmentCapabilities = () => {
      const config = engineConfigFromConfig(approvedConfig());
      return createAttachmentCapabilityResolver({
        openRouterCache: openRouterModelMetadata,
        metadataMaxAgeMs: CHAT_ATTACHMENT_LIMITS.capabilityMetadataMaxAgeMs,
        now,
      }).resolve({
        provider: config.llm.provider,
        model: config.llm.model,
        transport: transportForProvider(config.llm.provider),
        ...(config.llm.apiKey.length === 0 ? {} : { apiKey: config.llm.apiKey }),
      });
    };
    const attachmentComposerOperations = createAttachmentComposerOperations({
      repository: attachmentRepository,
      attachments: attachmentOperations,
      activities: activityAttachmentOperations,
      workouts: workoutAttachmentOperations,
      capabilities: resolveAttachmentCapabilities,
    });
    const repository = (dependencies.createRepository ?? createAnchorRepository)(
      input.context.store,
    );
    const cyclingFtpAnchorResolver = (
      dependencies.createResolver ?? createCyclingFtpAnchorResolver
    )(repository);
    const powerProgress = createPowerProgressStateSource({
      store: input.context.store,
      archiveRoot: input.home.archiveDir,
      now,
    });
    const canonicalActivities = createCanonicalActivityReader(input.context.store);
    const trainingHistory = createTrainingHistorySource({
      facts: createTrainingHistoryReader(input.context.store),
      coverage: createTrainingCoverageReader(input.context.store),
    });
    const stateReader = createPersistedAthleteStateSource({
      dataDir: input.home.root,
      cyclingFtpAnchorResolver,
      now: () => new Date(now()),
      powerProgressSource: powerProgress,
      trainingHistorySource: trainingHistory,
      sourceOwner: () => approvedConfig().intervals.athleteId,
      calendarTimeZone: () => resolveUserTimezone(approvedConfig().session.timezone),
      droppedActivitiesSource: () => runtime!.currentDroppedActivities(),
    });
    const buildBundle = (config: Config): RuntimeBundle => {
      const timezone = resolveUserTimezone(config.session.timezone);
      const effectiveConfig =
        timezone === config.session.timezone
          ? config
          : {
              ...config,
              session: { ...config.session, timezone },
            };
      const memory = new Memory(input.home.root, timezone, {
        platform: dependencies.platform,
        persistPlan,
      });
      const conversationStore = createConversationStore(
        input.home.root,
        config.session.resetArchiveRetentionDays,
        { platform: dependencies.platform },
      );
      const planningReadService = createPlanningReadService({
        store: input.context.store,
        timezone,
        now,
      });
      const projectedConfig = engineConfigFromConfig(effectiveConfig);
      const attachmentCapabilityResolver = createAttachmentCapabilityResolver({
        openRouterCache: openRouterModelMetadata,
        metadataMaxAgeMs: CHAT_ATTACHMENT_LIMITS.capabilityMetadataMaxAgeMs,
        now,
      });
      const legacyClient =
        config.intervals.apiKey.length === 0
          ? null
          : makeChatClient({
              apiKey: config.intervals.apiKey,
              athleteId: config.intervals.athleteId,
            });
      const confirmations = new ConfirmationGate(now);
      const chatAttachments: ChatAttachmentTurnPort = {
        acceptQueuedMessage: async (request) => {
          await attachmentRepository.linkMessage({
            conversationId: request.chatId,
            messageId: request.messageId,
            attachmentIds: request.attachmentIds,
            createdAtMs: now(),
          });
        },
        prepareQueuedTurn: async (request) => {
          const importStartedAt = now();
          let activity: Awaited<
            ReturnType<typeof activityAttachmentOperations.turnPort.prepareQueuedTurn>
          >;
          try {
            activity = await activityAttachmentOperations.turnPort.prepareQueuedTurn(request);
            if (activity.activities.length > 0) {
              observeAttachment({
                operation: "import",
                kind: "activity",
                result: "succeeded",
                durationMs: now() - importStartedAt,
                count: activity.activities.length,
              });
            }
          } catch (error) {
            observeAttachment({
              operation: "import",
              kind: "activity",
              result: "failed",
              durationMs: now() - importStartedAt,
            });
            throw error;
          }
          const documentMedia = await documentMediaAttachmentOperations.prepareLinkedTurn(request);
          const workout = await workoutAttachmentOperations.prepareLinkedTurn(request);
          const attachmentContext = [documentMedia.attachmentContext, workout.attachmentContext]
            .filter((value): value is string => value !== undefined)
            .join("\n");
          const untrustedAttachmentText = [
            documentMedia.untrustedAttachmentText,
            workout.untrustedAttachmentText,
          ]
            .filter((value): value is string => value !== undefined)
            .join("\n");
          const attachments: ChatAttachmentReference[] = [];
          for (const message of request.messages) {
            for (const attachment of await attachmentRepository.listMessageAttachments(
              message.messageId,
            )) {
              attachments.push({
                attachmentId: attachment.id,
                displayName: attachment.display_name,
                kind: attachment.kind,
                extension: attachment.extension as ChatAttachmentReference["extension"],
              });
            }
          }
          return {
            ...activity,
            attachments,
            nativeMedia: documentMedia.nativeMedia,
            ...(attachmentContext.length === 0 ? {} : { attachmentContext }),
            ...(untrustedAttachmentText.length === 0 ? {} : { untrustedAttachmentText }),
          };
        },
        completeQueuedTurn: async (request) => {
          await activityAttachmentOperations.turnPort.completeQueuedTurn(request);
          await documentMediaAttachmentOperations.completeLinkedTurn(request);
          await workoutAttachmentOperations.completeLinkedTurn(request);
        },
      };
      const ports: EngineHostPorts = {
        config: projectedConfig,
        memory,
        chatStore: conversationStore,
        chatAttachments,
        attachmentCapabilities: {
          resolve: (signal) =>
            attachmentCapabilityResolver.resolve(
              {
                provider: projectedConfig.llm.provider,
                model: projectedConfig.llm.model,
                transport: transportForProvider(projectedConfig.llm.provider),
                ...(projectedConfig.llm.apiKey.length === 0
                  ? {}
                  : { apiKey: projectedConfig.llm.apiKey }),
              },
              signal,
            ),
        },
        transcriptWriter: conversationStore,
        coachDecisions: conversationStore,
        planningRead: {
          getPlanningReadModel: () => planningReadService.getPlanningReadModel({}),
        },
        secrets: { resolve: resolveSecretRef },
        platform: {
          legacyClient,
          athleteData: runtime!.athleteData,
          calendarMutations:
            legacyClient === null
              ? createMissingPlatformCalendarMutations()
              : createPlatformCalendarMutations(legacyClient),
        },
        logger,
        usage: { append: (line) => appendUsageLine(input.home.root, line) },
        stateReader,
        readReferenceState: () => readReferenceState(input.home.root),
        getAccessToken,
        classifyFailure,
        extractRetryAfterMs,
        now,
        randomId: dependencies.randomId ?? randomUUID,
        modelTransportDecorator: dependencies.modelTransportDecorator,
        onToolsAssembled: dependencies.onToolsAssembled,
        toolConfirmations: createToolConfirmationPort({
          gate: confirmations,
          summarizers: createProposalSummarizers({ intervals: legacyClient, tz: timezone }),
          requiresConfirmation: ({ chatId }) =>
            chatId !== "desktop" && chatId !== "cli" && !chatId.startsWith("cli:"),
        }),
      };
      const engineInput = { sport: cyclingSport, ports } satisfies CreateCoachEngineInput;
      const backend = (dependencies.createBackend ?? createCoachEngine)(engineInput);
      return {
        memory,
        chatStore: conversationStore,
        timezone,
        spendMeter: createSpendMeterService({
          dataDir: input.home.root,
          configDir: input.home.configDir,
          timezone,
          now,
        }),
        confirmations,
        engine: createCoachEngineAdapter({
          backend,
          getAthleteState: () => stateReader.getAthleteState(),
          cyclingFtpAnchorResolver,
          now,
        }),
      };
    };
    const initialBundle = buildBundle(approvedConfig());
    let activeTimezone = initialBundle.timezone;
    const reconfigurable = createReconfigurableRuntimeBundle(initialBundle);
    const persistConfig = dependencies.persistRuntimeConfig ?? persistRuntimeConfig;
    const ensureSchedulerStarted = (): void => {
      if (schedulerStarted || closing) return;
      runtime!.startScheduler();
      schedulerStarted = true;
    };
    const applyRuntimeConfig = async (
      request: ConfigureRuntimeRpcParams,
      signal: AbortSignal,
    ): Promise<ConfigureRuntimeRpcRefusalReason | void> => {
      signal.throwIfAborted();
      if (
        request.llm?.clear_credential === true &&
        request.llm.provider !== unapprovedConfig.llm.provider
      ) {
        return "credential-required";
      }
      if (
        request.llm?.clear_credential === true &&
        llmCredentialManagedByEnvironment(input.env, unapprovedConfig.llm.provider)
      ) {
        return "managed-by-environment";
      }
      if (
        request.intervals?.clear_credential === true &&
        nonemptyEnvironmentValue(input.env, "INTERVALS_API_KEY")
      ) {
        return "managed-by-environment";
      }
      if (
        request.intervals?.athlete_id !== undefined &&
        input.env.INTERVALS_ATHLETE_ID !== undefined
      ) {
        return "managed-by-environment";
      }
      if (request.session !== undefined) {
        const ownership = sessionConfigEnvironmentOwnership(input.env);
        for (const field of [
          "historyTokenBudgetRatio",
          "idleMinutes",
          "dailyResetHour",
          "resetArchiveRetentionDays",
          "timezone",
        ] as const) {
          if (request.session[field] !== undefined && ownership[field]) {
            throw new Error(`runtime session ${field} is controlled by the daemon environment`);
          }
        }
      }
      let effectiveRequest = request;
      let verificationEvidence: IntervalsCredentialVerificationEvidence | undefined;
      if (request.intervals?.verification_approval !== undefined) {
        const preliminaryCandidate = mergedRuntimeConfig(unapprovedConfig, request);
        let ownerState: Awaited<ReturnType<typeof readIntervalsStoreOwnerState>> | undefined;
        try {
          ownerState = await readIntervalsStoreOwnerState(input.context.store);
        } catch {}
        if (ownerState !== undefined) {
          const approval = intervalsCredentialApprovals.consume({
            approval: request.intervals.verification_approval,
            credentialDigest: digestIntervalsCredential(preliminaryCandidate.intervals.apiKey),
            configuredAthleteSelector: normalizeIntervalsAthleteSelector(
              unapprovedConfig.intervals.athleteId,
            ),
            ...(request.intervals.athlete_id === undefined
              ? {}
              : { requestedAthleteSelector: request.intervals.athlete_id }),
            ownerState,
            configRevision: intervalsConfigRevision,
          });
          if (approval !== undefined) {
            verificationEvidence = approval.evidence;
            if (
              approval.athleteSelector !==
              normalizeIntervalsAthleteSelector(preliminaryCandidate.intervals.athleteId)
            ) {
              if (input.env.INTERVALS_ATHLETE_ID !== undefined) {
                return "managed-by-environment";
              }
              effectiveRequest = {
                ...request,
                intervals: {
                  ...request.intervals,
                  athlete_id: approval.athleteSelector,
                },
              };
            }
          }
        }
      }
      const candidate = mergedRuntimeConfig(unapprovedConfig, effectiveRequest);
      const activeAthleteId =
        unapprovedConfig.intervals.athleteId.length === 0
          ? "0"
          : unapprovedConfig.intervals.athleteId;
      const candidateAthleteId =
        candidate.intervals.athleteId.length === 0 ? "0" : candidate.intervals.athleteId;
      const athleteIdChanged =
        effectiveRequest.intervals?.athlete_id !== undefined &&
        candidateAthleteId !== activeAthleteId;
      const apiKeyChanged =
        (effectiveRequest.intervals?.api_key !== undefined ||
          effectiveRequest.intervals?.clear_credential === true) &&
        candidate.intervals.apiKey !== unapprovedConfig.intervals.apiKey;
      let pendingOwnerClaim: RuntimeAthleteOwnerClaim | undefined;
      let intervalsOwnerApproved = false;
      if (
        athleteIdChanged ||
        (apiKeyChanged && effectiveRequest.intervals?.clear_credential !== true) ||
        (effectiveRequest.intervals !== undefined &&
          candidate.intervals.apiKey.length > 0 &&
          !intervalsOwnerReady)
      ) {
        if (
          apiKeyChanged &&
          input.env.INTERVALS_API_KEY !== undefined &&
          input.env.INTERVALS_API_KEY !== ""
        ) {
          throw new Error("runtime intervals credential is controlled by the daemon environment");
        }
        try {
          pendingOwnerClaim = await assertIntervalsOwner(
            unapprovedConfig,
            candidate,
            signal,
            unapprovedConfig.intervals.apiKey.length === 0 && candidate.intervals.apiKey.length > 0,
            verificationEvidence,
          );
          intervalsOwnerApproved = true;
        } catch (error) {
          if (!(error instanceof RuntimeAthleteOwnerRefusal)) throw error;
          if (error.reason === "current-credential-missing") return "credential-required";
          if (error.reason === "mismatch") return "training-account-mismatch";
          return "ownership-unavailable";
        }
      }
      if (
        request.llm !== undefined &&
        request.llm.clear_credential !== true &&
        candidate.llm.provider === "openai-codex"
      ) {
        if (input.oauthOwner !== undefined) {
          if (!(await input.oauthOwner.hasProfile(candidate.llm.authProfile ?? "openai-codex"))) {
            throw new TypeError(
              "OAuth profile is unavailable. Use desktop credential recovery or sign in again.",
            );
          }
        } else
          credential(
            loadStoredProfileSnapshot(
              join(input.home.configDir, "auth-profiles.json"),
              candidate.llm.authProfile ?? "openai-codex",
            )?.profile,
          );
      }
      const chatGptProfileClear =
        request.llm?.clear_credential === true && unapprovedConfig.llm.provider === "openai-codex";
      signal.throwIfAborted();
      await reconfigurable.replace(
        () => {
          signal.throwIfAborted();
          const latestCandidate = mergedRuntimeConfig(unapprovedConfig, effectiveRequest);
          if (
            intervalsOwnerApproved &&
            (latestCandidate.intervals.apiKey !== candidate.intervals.apiKey ||
              latestCandidate.intervals.athleteId !== candidate.intervals.athleteId)
          ) {
            throw new Error("Intervals configuration changed during ownership verification.");
          }
          const latestIntervalsChanged =
            latestCandidate.intervals.apiKey !== unapprovedConfig.intervals.apiKey ||
            latestCandidate.intervals.athleteId !== unapprovedConfig.intervals.athleteId;
          const replacementOwnerReady =
            latestCandidate.intervals.apiKey.length === 0 ||
            intervalsOwnerApproved ||
            (!latestIntervalsChanged && intervalsOwnerReady);
          return {
            latestCandidate,
            latestIntervalsChanged,
            replacementOwnerReady,
            replacement: buildBundle(approvedRuntimeConfig(latestCandidate, replacementOwnerReady)),
          };
        },
        async ({ latestCandidate, latestIntervalsChanged, replacementOwnerReady, replacement }) => {
          signal.throwIfAborted();
          const previousConfigFile =
            pendingOwnerClaim === undefined && !chatGptProfileClear
              ? undefined
              : captureRuntimeConfigFile(input.home.configDir);
          try {
            persistConfig(
              input.home.configDir,
              latestCandidate,
              effectiveRequest,
              unapprovedConfig,
            );
            if (chatGptProfileClear) {
              if (input.oauthOwner === undefined) {
                deleteStoredProfile(
                  join(input.home.configDir, "auth-profiles.json"),
                  unapprovedConfig.llm.authProfile ?? "openai-codex",
                );
              } else {
                await input.oauthOwner.deleteProfile(
                  unapprovedConfig.llm.authProfile ?? "openai-codex",
                );
              }
            }
            await pendingOwnerClaim?.claim();
          } catch (error) {
            if (previousConfigFile !== undefined) {
              try {
                restoreRuntimeConfigFile(input.home.configDir, previousConfigFile);
              } catch (rollbackError) {
                throw new AggregateError(
                  [error, rollbackError],
                  "Runtime account claim failed and configuration rollback was unsuccessful.",
                );
              }
            }
            throw error;
          }
          unapprovedConfig = latestCandidate;
          if (latestIntervalsChanged) intervalsConfigRevision += 1;
          intervalsOwnerReady = replacementOwnerReady;
          activeTimezone = replacement.timezone;
          return replacement;
        },
      );
      if (request.intervals !== undefined && candidate.intervals.apiKey.length > 0) {
        if (initialRefreshStarted && initialRefreshConfigCaptured && intervalsOwnerReady) {
          ensureSchedulerStarted();
          const refreshRevision = intervalsConfigRevision;
          void runtime!
            .runWindowAfter(() => Promise.resolve())
            .catch((error) =>
              logger.error("runtime_intervals_refresh_failed", undefined, {
                configRevision: refreshRevision,
                failure: serializeBoundaryError(error),
              }),
            );
        }
      }
    };
    const scheduleInitialRefreshRetry = (): void => {
      if (closing || initialRefreshRetryTimer !== undefined) return;
      initialRefreshFailedAttempts += 1;
      const delay = Math.min(
        INITIAL_REFRESH_RETRY_BASE_DELAY_MS * 2 ** (initialRefreshFailedAttempts - 1),
        INITIAL_REFRESH_RETRY_MAX_DELAY_MS,
      );
      const timer = setTimeout(() => {
        if (initialRefreshRetryTimer === timer) initialRefreshRetryTimer = undefined;
        if (!closing) void startInitialRefresh().catch(() => {});
      }, delay);
      timer.unref?.();
      initialRefreshRetryTimer = timer;
    };
    const startInitialRefresh = (): Promise<void> => {
      if (initialRefreshPromise !== undefined) return initialRefreshPromise;
      if (!input.deferInitialRefresh) {
        initialRefreshPromise = Promise.resolve();
        return initialRefreshPromise;
      }
      if (initialRefreshRetryTimer !== undefined) {
        clearTimeout(initialRefreshRetryTimer);
        initialRefreshRetryTimer = undefined;
      }
      initialRefreshStarted = true;
      const refreshRevision = intervalsConfigRevision;
      let ownerSucceeded = false;
      initialRefreshPromise = runtime!
        .runWindowAfter(async (signal) => {
          const initializationSignal = AbortSignal.any([signal, initialRefreshController.signal]);
          initializationSignal.throwIfAborted();
          initialRefreshConfigCaptured = true;
          const initialConfig = copyConfig(unapprovedConfig);
          if (initialConfig.intervals.apiKey.length > 0 && !intervalsOwnerReady) {
            const ownerClaim = await assertIntervalsOwner(
              initialConfig,
              initialConfig,
              initializationSignal,
            );
            initializationSignal.throwIfAborted();
            await ownerClaim?.claim();
            initializationSignal.throwIfAborted();
          }
          await reconfigurable.replace(
            () => {
              initializationSignal.throwIfAborted();
              return buildBundle(approvedRuntimeConfig(unapprovedConfig, true));
            },
            (replacement) => {
              initializationSignal.throwIfAborted();
              intervalsOwnerReady = true;
              activeTimezone = replacement.timezone;
              ownerSucceeded = true;
              return replacement;
            },
          );
        })
        .then(() => undefined)
        .finally(() => {
          if (ownerSucceeded && unapprovedConfig.intervals.apiKey.length > 0) {
            ensureSchedulerStarted();
          }
        })
        .catch((error) => {
          if (!closing) {
            logger.error("initial_store_refresh_failed", undefined, {
              configRevision: refreshRevision,
              failure: serializeBoundaryError(error),
            });
            initialRefreshPromise = undefined;
            if (
              !ownerSucceeded &&
              (!(error instanceof RuntimeAthleteOwnerRefusal) || error.transient)
            ) {
              scheduleInitialRefreshRetry();
            }
          }
          throw error;
        });
      return initialRefreshPromise;
    };
    const liveIntervals = Object.freeze({
      async read() {
        return Object.freeze({ ...approvedConfig().intervals });
      },
    });
    const options = Object.freeze({ liveIntervals });
    const analysisImport = createNodeImportRuntime({
      archiveDir: input.home.archiveDir,
      store: input.context.store,
    });
    const analysisCrypto = createNodeCrypto();
    const curveState = createAnalyticsCurveStateReader(input.context.store, (fields) => {
      if (fields.length === 0) throw new TypeError("empty key tuple");
      return H(analysisCrypto, ...(fields as [string | number, ...(string | number)[]]));
    });
    const curveSnapshots = createVerifiedSnapshotReader({
      archiveRoot: input.home.archiveDir,
      crypto: analysisCrypto,
      fs: nodeFileSystem(),
    });
    const analysisSources = createIntervalsSourceRepository(input.context.store, (fields) => {
      if (fields.length === 0) throw new TypeError("empty key tuple");
      return H(analysisCrypto, ...(fields as [string | number, ...(string | number)[]]));
    });
    const providerAccess = createProviderActivityAnalysisClientAccess({
      credentials: options.liveIntervals,
    });
    const archiveDependencies = {
      archive: analysisImport.archive,
      store: input.context.store,
      sources: analysisSources,
      runExclusive: <T>(work: () => Promise<T>) => runtime!.runExclusive(work),
      now,
    };
    const providerStreams = createProviderActivityStreamReader({
      access: providerAccess,
      archive: createProviderActivityStreamArchive({
        ...archiveDependencies,
      }),
    });
    const providerIntervals = createProviderActivityIntervalReader({
      access: providerAccess,
      archive: createProviderActivityIntervalsArchive({ ...archiveDependencies }),
    });
    const providerBestEfforts = createProviderActivityBestEffortReader({
      access: providerAccess,
      archive: createProviderActivityBestEffortsArchive({ ...archiveDependencies }),
    });
    const providerHistograms = createProviderActivityHistogramReader({
      access: providerAccess,
      archive: createProviderActivityHistogramArchive({ ...archiveDependencies }),
    });
    const providerPowerHeartRate = createProviderActivityPowerHeartRateReader({
      access: providerAccess,
      archive: createProviderActivityPowerHeartRateArchive({ ...archiveDependencies }),
    });
    const trustedActivitySources = createTrustedActivitySourceResolver(input.context.store);
    const activityAnalysis = createStoredActivityAnalysisService({
      store: input.context.store,
      activities: canonicalActivities,
      sources: trustedActivitySources,
      analyzers: {
        aerobicDrift: createAerobicDriftAnalyzer({
          activities: canonicalActivities,
          provider: providerStreams,
        }),
        intervals: createIntervalReviewAnalyzer({ provider: providerIntervals }),
        bestEfforts: createBestEffortAnalyzer({ provider: providerBestEfforts }),
        powerDistribution: createPowerDistributionAnalyzer({ provider: providerHistograms }),
        heartRateDistribution: createHeartRateDistributionAnalyzer({
          provider: providerHistograms,
        }),
        powerHeartRate: createPowerHeartRateAnalyzer({ provider: providerPowerHeartRate }),
      },
      runCacheWrite: (work) => runtime!.runExclusive(work),
      now,
    });
    const trainingExport = createTrainingExportService({
      credentials: options.liveIntervals,
      sources: trustedActivitySources,
    });
    const coachOperations = createCoachOperations(
      {
        home: input.home,
        context: input.context,
        runtime,
        intervalsCredentials: options.liveIntervals,
        historyNewestDate: () => referencePlan(approvedConfig()).window.newest,
        calendarTimeZone: () => resolveUserTimezone(approvedConfig().session.timezone),
        readTranscriptPage: (request) => reconfigurable.getTranscriptPage(request),
        readArchivedConversations: (request) => reconfigurable.listArchivedConversations(request),
        readArchivedTranscriptPage: (request) => reconfigurable.getArchivedTranscriptPage(request),
        deleteArchivedConversation: ({ boundaryRef }) =>
          reconfigurable.withChatStore(async (chatStore) => {
            const manifest = chatStore.inspectArchivedConversation("desktop", boundaryRef);
            if (manifest === null) {
              return { schemaVersion: 1, status: "not-found" };
            }
            if (cleanupPlanningRequestSources === undefined) {
              throw new Error("Planning request source cleanup is unavailable.");
            }
            await cleanupPlanningRequestSources("desktop", {
              messageIds: manifest.turnIds,
              attachmentIds: manifest.attachmentIds,
            });
            await attachmentOperations.cleanupAttachments("desktop", manifest.attachmentIds);
            const deleted = chatStore.finalizeArchivedConversationDeletion("desktop", manifest);
            return {
              schemaVersion: 1,
              status: deleted ? "deleted" : "not-found",
            };
          }),
        applyRuntimeConfig,
        verifyIntervalsCredential,
        intervalsVerificationPending,
        readRuntimeConfig: () =>
          runtimeConfigSnapshot(
            input.home.configDir,
            unapprovedConfig,
            input.env,
            activeTimezone,
            intervalsVerificationPending(),
            input.oauthOwner,
          ),
      },
      dependencies.operationsDependencies,
    );
    const readFtpAnchor = async (
      confidence: "manual" | "platform",
    ): Promise<PlanFtpSourceValue | null> => {
      const row =
        confidence === "manual"
          ? await input.context.store.get(
              "SELECT value, valid_from FROM anchor_history WHERE sport = ? AND anchor_type = ? AND confidence = ? ORDER BY valid_from DESC, id DESC LIMIT 1",
              ["cycling", "ftp", confidence],
            )
          : await input.context.store.get(
              "SELECT value, valid_from FROM anchor_history WHERE sport = ? AND anchor_type = ? AND confidence = ? AND source = ? ORDER BY valid_from DESC, id DESC LIMIT 1",
              ["cycling", "ftp", confidence, "intervals-icu"],
            );
      if (
        row === undefined ||
        typeof row.value !== "number" ||
        typeof row.valid_from !== "number"
      ) {
        return null;
      }
      return { watts: row.value, refreshedAtMs: row.valid_from * 1_000 };
    };
    const ftp = createCyclingPlanFtpAdapter({
      readManual: () => readFtpAnchor("manual"),
      readIntervalsFtp: () => readFtpAnchor("platform"),
      async readIntervalsEftp() {
        const latest = readReferenceState(input.home.root).latest;
        const watts = latest?.derived_metrics?.eftp;
        const refreshedAtMs = Date.parse(latest?.metadata?.last_updated ?? "");
        return typeof watts === "number" && Number.isFinite(refreshedAtMs)
          ? { watts, refreshedAtMs }
          : null;
      },
      async saveManual(watts) {
        const stamp = planningIdentity.hlcStamp();
        const validFrom = Math.floor(stamp.physicalMs / 1_000);
        const deviceId = await planningIdentity.deviceId();
        const inserted = await repository.insertIfAbsent({
          id: planningIdentity.newUlid(),
          sport: "cycling",
          anchor_type: "ftp",
          value: watts,
          unit: "W",
          valid_from: validFrom,
          source: "athlete",
          confidence: "manual",
          note: null,
          provenance: "manual",
          device_id: deviceId,
          hlc_physical_ms: stamp.physicalMs,
          hlc_counter: stamp.counter,
        });
        if (inserted) return;
        const existing = await input.context.store.get(
          "SELECT confidence FROM anchor_history WHERE sport = ? AND anchor_type = ? AND valid_from = ?",
          ["cycling", "ftp", validFrom],
        );
        if (existing?.confidence !== "manual") throw new Error("Manual FTP could not be saved.");
        await input.context.store.run(
          "UPDATE anchor_history SET value = ?, unit = ?, source = ?, note = ?, provenance = ?, device_id = ?, hlc_physical_ms = ?, hlc_counter = ? WHERE sport = ? AND anchor_type = ? AND valid_from = ? AND confidence = ?",
          [
            watts,
            "W",
            "athlete",
            null,
            "manual",
            deviceId,
            stamp.physicalMs,
            stamp.counter,
            "cycling",
            "ftp",
            validFrom,
            "manual",
          ],
        );
      },
      async refreshIntervals() {
        await coachOperations.sync({});
      },
    });
    const planCalendar = createPlanMirrorCalendarAdapter(() => {
      const intervals = approvedConfig().intervals;
      return intervals.apiKey.length === 0
        ? null
        : makeChatClient({ apiKey: intervals.apiKey, athleteId: intervals.athleteId });
    });
    const readiness = {
      async read({
        plan,
        workouts,
        todayDateKey,
      }: {
        readonly plan: { readonly targetDateKey: number | null };
        readonly workouts: readonly {
          readonly dateKey: number;
          readonly name: string;
          readonly durationS: number | null;
          readonly structureJson: string;
        }[];
        readonly todayDateKey: number;
      }) {
        const latest = readLatestReference(input.home.root);
        const civil = (dateKey: number): string => {
          const value = String(dateKey).padStart(8, "0");
          return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
        };
        const refreshedAtMs = Date.parse(latest?.metadata.last_updated ?? "");
        let estimatedCp = projectCyclingEstimatedCp({
          curves: undefined,
          calculatedOn: civil(todayDateKey),
          lastSuccessfulSyncAtMs: null,
          stale: false,
        });
        try {
          const state = await curveState.readState();
          if (state.current !== null) {
            const projected = await projectAnalyticsCurveEvidence(state.current, curveSnapshots);
            const failedAt = state.refreshFailure?.failedEpochSeconds ?? null;
            estimatedCp = projectCyclingEstimatedCp({
              curves: projected.sustainabilityCurves?.cycling,
              calculatedOn: state.current.generation.frozenOn,
              lastSuccessfulSyncAtMs: state.current.promotedEpochSeconds * 1_000,
              stale:
                failedAt !== null && failedAt * 1_000 >= state.current.promotedEpochSeconds * 1_000,
            });
            if (estimatedCp.unavailableReason === "mathematically-invalid") {
              logger.warn("estimated_cp_mathematically_invalid");
            }
          }
        } catch {
          // Estimated CP is optional evidence; readiness remains available when it cannot load.
        }
        return projectCyclingReadinessInput({
          today: civil(todayDateKey),
          raceDate: plan.targetDateKey === null ? null : civil(plan.targetDateKey),
          wellness: latest?.wellness_data ?? null,
          currentStatus: latest?.current_status ?? null,
          estimatedCp,
          lastSuccessfulRefreshAtMs: Number.isFinite(refreshedAtMs) ? refreshedAtMs : null,
          workouts: workouts.map((workout) => ({
            date: civil(workout.dateKey),
            name: workout.name,
            durationS: workout.durationS,
            structureJson: workout.structureJson,
          })),
        });
      },
      async refresh() {
        await coachOperations.sync({});
      },
    };
    const planRepository = createPlanRepository(input.context.store);
    const planningRequestRepository = createPlanningRequestRepository(
      input.context.store,
      analysisCrypto,
    );
    const chatPlanOutboxRepository = createChatPlanOutboxRepository(
      input.context.store,
      analysisCrypto,
    );
    cleanupPlanningRequestSources = createPlanningRequestSourceCleanup({
      outbox: chatPlanOutboxRepository,
      requests: planningRequestRepository,
      identity: planningIdentity,
    });
    const planConversationRepository = createPlanConversationRepository(input.context.store);
    const planningRequestIntake = createPlanningRequestIntakeService({
      requests: planningRequestRepository,
      intake: createPlanningRequestIntakeRepository(input.context.store),
      plans: planRepository,
      conversations: planConversationRepository,
      identity: planningIdentity,
      workoutLimits,
      todayDateKey: planningDateKey,
    });
    const planIntakes = createPlanIntakeRepository(input.context.store);
    const planDraftBuilds = createPlanDraftBuildRepository(input.context.store);
    const planningOperations = createPlanningOperations(
      {
        context: input.context,
        engine: reconfigurable.engine,
        identity: planningIdentity,
      },
      {
        intakes: planIntakes,
        draftBuilds: planDraftBuilds,
        ftp,
        draftBuilder: createCyclingPlanDraftBuilder({
          intakes: planIntakes,
          checkpoints: planDraftBuilds,
          ftp,
          identity: planningIdentity,
          todayDateKey: planningDateKey,
        }),
        course: createNodePlanRaceCourseAdapter(),
        todayDateKey: planningDateKey,
        calendar: planCalendar,
        workoutDriftCalendar: planCalendar,
        readiness,
        requests: planningRequestRepository,
        proposalPremiseReader: createPlanningRequestPremiseReader(planningRequestRepository),
      },
    );
    const planningRequestOperations = createPlanningRequestDeliveryService(
      {
        outbox: chatPlanOutboxRepository,
        requests: planningRequestRepository,
        identity: planningIdentity,
        async resolveTarget() {
          const latest = await planRepository.readLatest();
          if (latest?.status === "active") return "active_plan";
          if (latest?.status === "draft") return "draft";
          return "plan_creation";
        },
        async resolveWorkoutSource({ chatId, attachmentId }) {
          const attachment = await attachmentRepository.readAttachment(attachmentId);
          if (
            attachment === undefined ||
            attachment.conversation_id !== chatId ||
            attachment.kind !== "workout" ||
            (attachment.status !== "ready" && attachment.status !== "sent")
          ) {
            throw new TypeError("Workout attachment is unavailable.");
          }
          const set = await workoutAttachmentOperations.readWorkoutSet(attachmentId);
          const workout = set.workouts.find(
            (candidate) => candidate.workoutId === set.selectedWorkoutId,
          );
          if (workout === undefined) throw new TypeError("Workout selection is unavailable.");
          return {
            attachment: {
              attachmentId: attachment.id,
              displayName: attachment.display_name,
              extension: set.sourceFormat,
            },
            selectedWorkout: {
              setId: set.setId,
              workoutId: workout.workoutId,
              workout: JSON.parse(JSON.stringify(workout)) as NonNullable<
                CreatePlanningRequestPayload["sourceSnapshot"]["selectedWorkout"]
              >["workout"],
            },
          };
        },
      },
      {
        afterPlanningAccepted: async (request) => {
          await planningRequestIntake(request);
        },
      },
    );
    const operations = {
      ...coachOperations,
      admitChatAttachment: async (request) => {
        const startedAt = now();
        const result = await attachmentOperations.admit(request);
        if (result.status !== "accepted") {
          observeAttachment({
            operation: "admission",
            kind: "unknown",
            result:
              result.status === "rejected"
                ? result.reason
                : result.status === "storage_failed"
                  ? result.failureCode
                  : "failed",
            durationMs: now() - startedAt,
            count: 1,
          });
        }
        return result;
      },
      admitPastedChatAttachment: async (request) => {
        const startedAt = now();
        const bytes = Buffer.from(request.dataBase64, "base64");
        if (
          bytes.byteLength === 0 ||
          bytes.toString("base64") !== request.dataBase64 ||
          bytes.byteLength > CHAT_ATTACHMENT_LIMITS.imageBytes
        ) {
          observeAttachment({
            operation: "admission",
            kind: "unknown",
            result: "validation_failed",
            byteSize: bytes.byteLength,
            durationMs: now() - startedAt,
            count: 1,
          });
          return {
            selectionId: request.selectionId,
            displayName: request.displayName,
            status: "rejected" as const,
            reason:
              bytes.byteLength > CHAT_ATTACHMENT_LIMITS.imageBytes
                ? ("file_too_large" as const)
                : ("validation_failed" as const),
          };
        }
        const result = await attachmentOperations.admitPasted({
          chatId: request.chatId,
          selectionId: request.selectionId,
          displayName: request.displayName,
          bytes,
        });
        if (result.status !== "accepted") {
          observeAttachment({
            operation: "admission",
            kind: "image",
            result:
              result.status === "rejected"
                ? result.reason
                : result.status === "storage_failed"
                  ? result.failureCode
                  : "failed",
            byteSize: bytes.byteLength,
            durationMs: now() - startedAt,
            count: 1,
          });
        }
        return result;
      },
      getChatAttachmentComposer: (request) => attachmentComposerOperations.read(request.chatId),
      saveChatAttachmentDraftText: (request) =>
        attachmentComposerOperations.saveText(request.chatId, request.text),
      removeChatAttachment: (request) =>
        attachmentComposerOperations.remove(request.chatId, request.attachmentId),
      retryChatAttachment: (request) =>
        attachmentComposerOperations.retry(request.chatId, request.attachmentId),
      selectChatAttachmentWorkout: (request) =>
        attachmentComposerOperations.selectWorkout(
          request.chatId,
          request.attachmentId,
          request.workoutId,
        ),
      clearChatAttachmentDraft: (request) => attachmentComposerOperations.clear(request.chatId),
      getPlanningReadModel: (request) =>
        createPlanningReadService({
          store: input.context.store,
          timezone: activeTimezone,
          now,
        }).getPlanningReadModel(request),
      getActivityAnalysis: (request, signal) =>
        activityAnalysis.getActivityAnalysis(request, signal),
      exportTrainingFile: (request, signal) => trainingExport.export(request, signal),
      ...planningRequestOperations,
      ...planningOperations,
    } satisfies CoachOperations &
      PlanningReadOperations &
      PlanningRequestOperations &
      PlanningOperations;
    return {
      engine: reconfigurable.engine,
      operations,
      spendMeter: reconfigurable.spendMeter,
      confirmations: reconfigurable.confirmations,
      startInitialRefresh,
      close() {
        closePromise ??= (async () => {
          closing = true;
          if (initialRefreshRetryTimer !== undefined) {
            clearTimeout(initialRefreshRetryTimer);
            initialRefreshRetryTimer = undefined;
          }
          initialRefreshController.abort(new Error("Coach lifecycle closed."));
          let failure: { readonly error: unknown } | undefined;
          const attempt = async (operation: () => void | Promise<void>): Promise<void> => {
            try {
              await operation();
            } catch (error) {
              failure ??= { error };
            }
          };
          await attempt(() => dependencies.closeHostAdapters?.());
          await attempt(() => reference!.scheduler.stop());
          await attempt(() => runtime!.close());
          await initialRefreshPromise?.catch(() => {});
          if (failure !== undefined) throw failure.error;
        })();
        return closePromise;
      },
    };
  } catch (error) {
    reference?.scheduler.stop();
    if (runtime !== undefined) await runtime.close();
    throw error;
  }
}
