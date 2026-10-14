export type {
  DfaSummary,
  PowerCurveDeltaSummary,
  ReferenceSportAdapter,
} from "./sport-adapter.js";

export { computeDfaA1Profile, computePowerCurveDelta } from "./metrics/capability.js";
export type { MetricInput } from "./metrics/metric-input.js";

export { ReferenceConfigError } from "./errors.js";

export type { ReferenceServices } from "./services.js";

export { resolveRunningCs, collectRunCsRows, CS_MIN_MPS, CS_MAX_MPS } from "./cs-resolution.js";
export type { ResolvedCs, RunCsRow, CsConfidence } from "./cs-resolution.js";

export {
  FRESH_MS,
  STALE_MS,
  CRITICAL_MS,
  LATEST_RETENTION_DAYS,
  MUTEX_ACQUIRE_TIMEOUT_MS,
  SYNC_OPERATION_TIMEOUT_MS,
  SYNC_COOLDOWN_MS,
  MUTEX_HOT_WARN_MS,
  SCHEDULED_SYNC_INTERVAL_MS,
} from "./freshness.js";

export { referenceDataDir } from "./paths.js";

export { REFERENCE_PRESERVE_TOKENS } from "./preserve-tokens.js";

export {
  LATEST_SCHEMA_VERSION,
  LatestJsonSchema,
  type LatestJson,
  HISTORY_SCHEMA_VERSION,
  HistoryJsonSchema,
  type HistoryJson,
  INTERVALS_SCHEMA_VERSION,
  IntervalsJsonSchema,
  type IntervalsJson,
  ROUTES_SCHEMA_VERSION,
  RoutesJsonSchema,
  type RoutesJson,
  FTP_HISTORY_SCHEMA_VERSION,
  FtpHistoryJsonSchema,
  type FtpHistoryJson,
  SCHEDULER_SCHEMA_VERSION,
  SchedulerStateSchema,
  type SchedulerState,
  ERROR_STATE_SCHEMA_VERSION,
  ErrorStateSchema,
  type ErrorState,
  ErrorPhaseSchema,
  type ErrorPhase,
  ErrorCallerSchema,
  type ErrorCaller,
  ErrorMitigationSchema,
  type ErrorMitigation,
} from "./schemas/index.js";

export {
  ActivitySchema,
  type Activity,
  WellnessDaySchema,
  type WellnessDay,
  WeeklyRollupSchema,
  type WeeklyRollup,
  FtpHistoryPointSchema,
  type FtpHistoryPoint,
  PlannedEventSchema,
  type PlannedEvent,
  FixtureSchema,
  type FixtureShape,
  IcuIntervalRepSchema,
  type IcuIntervalRep,
  ZoneTimesSchema,
  type ZoneTimes,
  ZoneTimeEntrySchema,
  type ZoneTimeEntry,
  IcuZoneTimeEntrySchema,
  type IcuZoneTimeEntry,
} from "./schemas/index.js";

export {
  TP_API_FIELDS,
  TP_DENYLIST_FIELDS,
} from "./trademark-policy.js";
export {
  assertNoTpKeysRemain,
  parseRenamedActivity,
  renameTpFieldsOnActivity,
  type RenamedActivityRow,
} from "./sync/rename-tp-fields.js";
export {
  makeIntervalsHttpFactory,
  type RunScopedHttpFactory,
  type RunScopedHttpFactoryArgs,
} from "./sync/intervals-client-factory.js";
export { normalizeStreams } from "./sync/fetch-live-bundle.js";

export {
  AUDIT_SCHEMA_VERSION,
  CitationSchema,
  type Citation,
  RecommendationMetadataSchema,
  type RecommendationMetadata,
  AuditLogEntrySchema,
  type AuditLogEntry,
} from "./validation/recommendation-metadata.js";
export { writeAuditEntry, computeResponseHash } from "./audit/writer.js";
export { parseAuditLog } from "./audit/parse.js";

export { gateLatestJson } from "./validation/sync-gate.js";
export type {
  GateResult,
  GateStep,
  GateFailure,
  GateWarning,
} from "./validation/sync-gate.js";

export {
  validateRecommendation,
  parseMetaBlock,
  getByPath,
  DEFAULT_LAYER_2_MODE,
  type Layer2Mode,
  type ValidationResult,
} from "./validation/validate-response.js";
export {
  validateAndRetry,
  type RetryOpts,
  type RetryResult,
} from "./validation/retry-with-feedback.js";
export { LAYER_3_PROMPT_RULES } from "./validation/layer3-prompt.js";
