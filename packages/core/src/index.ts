// ─── Binary deployment shell ──────────────────────────────────────────
export type { BinaryConfig } from "./binary.js";
export { getCoachHome } from "./coach-home.js";

// ─── Setup wizard ─────────────────────────────────────────────────────
export { runSetup } from "./setup.js";

// ─── Binary entry point ───────────────────────────────────────────────
export { runBinary } from "./run-binary.js";
export type { PreparedCoachComposition, RunBinaryHooks } from "./run-binary.js";
export { reportFatal } from "./process-guard.js";

// ─── Sport contract ───────────────────────────────────────────────────
export type {
  CoreDeps,
  DerivedPreserveTokens,
  IntervalsActivityType,
  MemorySectionSpec,
  Person,
  PreserveTokens,
  Sport,
  SportId,
  SportMemoryShape,
  SportPersona,
  ToolRegistration,
} from "./sport.js";
export {
  createCoreToolsWithSportConfig,
  createMemoryQueryTool,
  createMemoryReadTool,
  createMemorySnapshot,
  createMemoryTools,
  createPureCoreIntervalsTools,
  getEffectiveSections,
  mergeSportSkills,
} from "./sport.js";

// ─── Reference layer (see NOTICE.md for upstream attribution) ────────
// Per-sport seam types, freshness/timing constants, path resolver, I/O
// helpers, strict Zod cache schemas with per-file SCHEMA_VERSION
// constants, REFERENCE_PRESERVE_TOKENS, and downstream submodules
// (sync, metrics, validation, curator, units, audit) as they come online.
export * from "./reference/index.js";
export { bootstrapReference } from "./reference/runtime.js";
export type { BootstrapReferenceDeps, ReferenceRuntime } from "./reference/runtime.js";
export { wrapFetchWithSignal } from "./reference/sync/intervals-client-factory.js";
export { makeAbortableClient, makeChatClient } from "./reference/sync/intervals-client-factory.js";

export {
  appendUsageLine,
  readUsageLedger,
  USAGE_LEDGER_FILE,
  USAGE_LEDGER_MAX_BYTES,
  type UsageLedgerReadResult,
} from "./usage-ledger.js";
export { atomicWriteJson } from "./io/atomic-write-json.js";

// ─── Logging substrate ────────────────────────────────────────────────
export {
  createSubsystemLogger,
  createSubsystemLoggers,
  redactObject,
  REDACTION_SENTINEL,
  serializeError,
  LOG_LEVELS,
  normalizeLogLevel,
} from "./logging/index.js";
export type { LogLine, LogLevel, SubsystemLogger, Subsystem } from "./logging/index.js";

// ─── Memory ───────────────────────────────────────────────────────────
export type { MemorySnapshot, MemoryStore, MemoryWriteSource } from "./memory.js";
export { Memory, type MemoryOptions } from "./memory/store.js";
export type { MemoryJournalEntry } from "./memory/journal.js";

// ─── Secrets ──────────────────────────────────────────────────────────
export type { EnvSecretRef, ExecSecretRef, SecretRef, SecretsResolver } from "./secrets/types.js";
export { SecretResolutionError, isSecretRef } from "./secrets/types.js";
export { resolveSecretRef, _resolveSecretRefWithOverrides } from "./secrets/resolve.js";
export {
  detectBackends,
  _detectBackendsWithOverrides,
  findInPath,
} from "./secrets/backends/detect.js";
export type { BackendAvailability, KeychainState, OpState } from "./secrets/backends/detect.js";
export {
  KeychainUnsafeValueError,
  KeychainUnsupportedPlatformError,
  assertKeychainSafeValue,
  keychainItemDelete,
  keychainItemExists,
  keychainItemUpsert,
  keychainLoginPath,
  keychainSecretRef,
} from "./secrets/backends/keychain.js";
export type { KeychainOverrides } from "./secrets/backends/keychain.js";
export {
  OpVaultAmbiguousError,
  SecretTooLargeError,
  opItemCreate,
  opItemDelete,
  opItemGet,
  opItemUpdate,
  opSecretRef,
  opVaultList,
  redactTemplateForLog,
} from "./secrets/backends/op.js";

// ─── Intervals ────────────────────────────────────────────────────────
export type { IntervalsClient } from "./intervals.js";

// ─── Agent ────────────────────────────────────────────────────────────
export { CoachAgent } from "./agent/coach-agent.js";
export { createCoachEngine } from "./agent/coach-engine.js";
export type { LegacyEngineOverrides, LocalCoachEngine } from "./agent/coach-engine.js";
export {
  ConfirmationGate,
  GATED_TOOL_NAMES,
  PROPOSAL_TTL_MS,
  createProposalSummarizers,
  createToolConfirmationPort,
} from "./agent/confirmation-gate.js";
export type { ConfirmOutcome, ProposalSummarizer, Summarized } from "./agent/confirmation-gate.js";
export { ChatStore } from "./agent/chat-store.js";
export {
  ConversationRecoveryError,
  createConversationStore,
  type ConversationStoreOptions,
  type ConversationStorePort,
} from "./agent/conversation-store.js";
export {
  MAX_ARCHIVED_CONVERSATION_ENTRIES,
  MAX_TRANSCRIPT_PAGE_RESPONSE_BYTES,
  MAX_TRANSCRIPT_PAGE_TURNS,
  MAX_TRANSCRIPT_RECORD_BYTES,
  ArchivedConversationDeletionConflictError,
  UnsafeTranscriptTargetError,
} from "./agent/transcript-store.js";
export type {
  ArchivedConversationDeletionManifest,
  ArchivedConversationList,
  ArchivedConversationSummary,
  TranscriptPageRequest,
  TranscriptPageResult,
  TranscriptPageEntry,
  TranscriptPageTurn,
  TranscriptInterruptedTurnRecord,
  TranscriptTurnRecord,
  TranscriptDecisionAnsweredInput,
  TranscriptDecisionContinuationCompletedInput,
  TranscriptDecisionRequestedInput,
  TranscriptDecisionSkippedInput,
  TranscriptDecisionRecord,
} from "./agent/transcript-store.js";
export {
  WindowsPrivatePathPolicyError,
  assertWindowsPrivateDirectoryStable,
  assertWindowsPrivateFileBinding,
  assertWindowsPrivateFileMetadata,
  assertWindowsPrivatePathRead,
  bindWindowsPrivateDirectory,
  classifyWindowsPrivatePathDurability,
  classifyWindowsPrivatePathFailure,
  sameWindowsPrivatePathIdentity,
  windowsPrivatePathIdentity,
} from "./io/windows-private-path-policy.js";
export type {
  WindowsPrivateDirectoryBinding,
  WindowsPrivatePathIdentity,
  WindowsPrivatePathPolicyStage,
} from "./io/windows-private-path-policy.js";
export { engineConfigFromConfig } from "./agent/engine-host-adapter.js";
export { classifyFailure, extractRetryAfterMs } from "./agent/token-utils.js";
export {
  DATE_KEY_RE,
  dateKeySchema,
  INTERVALS_LIST_MAX_RANGE_DAYS,
  validateListRange,
  validateWorkoutCreationDate,
} from "./agent/date-schema.js";
export {
  COACH_EVENT_TAG,
  COACH_EXTERNAL_ID_PREFIX,
  buildCoachEventProvenance,
  buildCoachExternalId,
  isCoachOwnedEvent,
} from "./agent/event-provenance.js";

// ─── Auth ─────────────────────────────────────────────────────────────
export {
  RefreshTokenReusedError,
  getFreshToken,
  loadProfile,
  saveProfile,
} from "./auth/profiles.js";
export type { OAuthCredential } from "./auth/profiles.js";
export {
  assertCliOAuthHome,
  DesktopOwnedOAuthHomeError,
  DESKTOP_OAUTH_OWNERSHIP_FILE,
  migrateDesktopOAuthProfiles,
  compareAndSaveStoredProfile,
  deleteStoredProfile,
  loadStoredProfileSnapshot,
  recoverAndSaveStoredProfile,
  saveStoredProfile,
} from "./auth/profile-store.js";
export type {
  CompareAndSaveStoredProfileResult,
  DeleteStoredProfileResult,
  StoredProfile,
  StoredProfileSnapshot,
} from "./auth/profile-store.js";
export { TokenRefreshError } from "./auth/refresh-failure.js";
export type { RefreshFailure, RefreshFailureReason } from "./auth/refresh-failure.js";
export { runCodexLogin } from "./auth/openai-codex-login.js";
export { CodexLoginError, loginCodex, refreshCodexToken } from "./agent/codex/oauth.js";
export type {
  CodexCredentials,
  CodexLoginErrorReason,
  CodexLoginOptions,
  CodexLoginProgressPhase,
} from "./agent/codex/oauth.js";

// ─── Channels ─────────────────────────────────────────────────────────
export { createTelegramBot } from "./channels/telegram.js";
export type {
  CreateTelegramChannelInput,
  TelegramChannelRuntime,
  TelegramDrainSnapshot,
} from "./channels/telegram.js";
export { deleteTelegramWebhook, inspectTelegramCredential } from "./channels/telegram-setup.js";
export type {
  TelegramCredentialInspectionResult,
  TelegramSetupApi,
  TelegramSetupDependencies,
} from "./channels/telegram-setup.js";
export { createNpmTelegramHost, notifyNpmTelegramUpdate } from "./channels/npm-telegram-host.js";
export type {
  CreateNpmTelegramHostInput,
  TelegramUpdateMessageSender,
} from "./channels/npm-telegram-host.js";
export type {
  TelegramAccessCapabilities,
  TelegramAuthorizationCapabilities,
  TelegramConfirmationCapabilities,
  TelegramDiagnosticsCapabilities,
  TelegramHostCapabilities,
  TelegramInvocationCapabilities,
  TelegramInvocationReservation,
  TelegramOperationsCapabilities,
  TelegramReleaseBase,
  TelegramReleaseCapabilities,
} from "./channels/telegram-host.js";

// ─── Config ───────────────────────────────────────────────────────────
export {
  CONFIG_DIR,
  CONFIG_FILE,
  claudeCliDisabledByEnvironment,
  claudeCliPatchFrom,
  codexAgentPatchFrom,
  loadConfig,
  loadConfigFromYaml,
  readConfigYaml,
  resolveConfigSecrets,
  sessionConfigEnvironmentOwnership,
} from "./config.js";
export type { Config, LoadConfigOptions, SessionConfigEnvironmentOwnership } from "./config.js";
export { DATA_SOURCES, resolveDataSource } from "./config.js";
export type { DataSource } from "./config.js";
export {
  COMPACT_MODEL_DEFAULTS,
  DEFAULT_MODELS,
  KEYLESS_LLM_PROVIDERS,
  LLM_MODEL_CATALOGUE,
  LLM_PROVIDERS,
  PROVIDER_BASE_URLS,
  contextWindowForModel,
  isKeylessProvider,
  resolveLlmProvider,
  resolveRuntimeConfig,
} from "./runtime-config.js";
export type {
  ClaudeCliBilling,
  ClaudeCliRuntimeConfigPatch,
  ClaudeCliRuntimeSettings,
  CodexAgentReasoningEffort,
  CodexAgentRuntimeConfigPatch,
  CodexAgentRuntimeSettings,
  EffectiveRuntimeConfig,
  KeylessLlmProvider,
  LlmModelCatalogueEntry,
  LlmModelOption,
  LlmProvider,
  RuntimeConfigPatch,
  RuntimeConfigResolverOptions,
} from "./runtime-config.js";
export {
  CLAUDE_CLI_DISABLED_MESSAGE,
  CODEX_AGENT_DISABLED_MESSAGE,
  CODEX_AGENT_REASONING_EFFORTS,
  CODEX_AGENT_WINDOWS_MESSAGE,
} from "./runtime-config.js";
export {
  ClaudeCliConfigError,
  ClaudeWorkingAreaError,
  createClaudeWorkingArea,
  ensureClaudeCliReady,
  invalidateClaudeAccountProbeCache,
} from "@enduragent/engine";
export type {
  ClaudeAccountClass,
  ClaudeAccountProbeResult,
  ClaudeCliConfigErrorKind,
  ClaudeCliReadiness,
  ClaudeWorkingAreaPort,
  EnsureClaudeCliReadyDeps,
  EnsureClaudeCliReadyInput,
  ProbeClaudeAccountInput,
} from "@enduragent/engine";
export {
  createPlatformAthleteDataReader,
  createPlatformCalendarMutations,
  createMissingPlatformCalendarMutations,
  createStoreAthleteDataReader,
  formatStoreFreshness,
  isRealCivilDate,
  PlatformApiError,
  PlatformCredentialsRequiredError,
} from "./athlete-data.js";
export type {
  AthleteDataReader,
  AthleteReadResult,
  CalendarEventForDelete,
  CalendarEventUpdate,
  PlatformCalendarMutations,
  StoredDataFreshness,
} from "./athlete-data.js";
export {
  addSecondarySender,
  AllowedSendersCommitUncertainError,
  claimPrimaryOperator,
  listDesktopAllowedSenders,
  loadAllowedSendersFromFile,
  loadAllowedSendersWithSource,
  MAX_ALLOWED_SENDERS_FILE_BYTES,
  removeSecondarySender,
  resetDesktopAllowedSenders,
  bindDesktopTelegramAccess,
  SENDER_ID_RE,
} from "./channels/allowed-senders.js";
export type {
  AddSecondarySenderResult,
  AllowedSendersStorageOptions,
  ClaimPrimaryOperatorResult,
  DesktopAllowedSender,
  RemoveSecondarySenderResult,
} from "./channels/allowed-senders.js";
export { createAuthMiddleware } from "./channels/telegram-access.js";
export type { CreateAuthMiddlewareOpts } from "./channels/telegram-access.js";

// ─── Updater ──────────────────────────────────────────────────────────
export {
  buildCheckUrl,
  checkForUpdate,
  getCurrentVersion,
  getInstanceId,
  getKnownTelegramChatIds,
  getLastNotifiedVersion,
  isManagedDeploy,
  isStableCalVer,
  isUpdateAvailable,
  MANAGED_DEPLOY_UPDATE_NOTICE,
  selfUpdate,
  setLastNotifiedVersion,
} from "./updater.js";
export type { UpdateInfo } from "./updater.js";

// ─── Release notes ───────────────────────────────────────────────────
export { fetchLatestReleaseNotes } from "./release-notes.js";
export type {
  FetchLatestReleaseNotesOptions,
  ReleaseNotesFetch,
  ReleaseNotesResult,
  RepoInfo,
} from "./release-notes.js";
export type { OAuthCredentialOwner } from "./auth/oauth-owner.js";
