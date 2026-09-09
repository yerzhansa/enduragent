// ─── Per-sport seam type (ADR-0010) ───────────────────────────────────
export type {
  DfaSummary,
  PowerCurveDeltaSummary,
  ReferenceSportAdapter,
} from "./sport-adapter.js";

// ─── Per-sport adapter delegation targets (ADR-0010) ──────────────────
// A per-sport adapter hook surfacing a registry-owned metric delegates to
// the registry compute and projects its rich output to a thin shape; it must
// never re-derive or register a second compute. The rich return types stay
// inferred — re-exporting the rich PowerCurveDelta unaliased would collide
// (TS2308) with the thin PowerCurveDeltaSummary already exported above.
export { computeDfaA1Profile, computePowerCurveDelta } from "./metrics/capability.js";
export type { MetricInput } from "./metrics/metric-input.js";

// ─── Per-sport seam boot-config error ─────────────────────────────────
export { ReferenceConfigError } from "./errors.js";

// ─── Service-aggregate type for downstream channels ───────────────────
export type { ReferenceServices } from "./services.js";

// ─── Running CS-anchor resolution (Tier 2) ────────────────────────────
// `resolveRunningCs` reads the latest synced profile; channels call it per turn.
// `ResolvedCs` is the anchor shape sport tools receive via `CoreDeps.resolvedCs`.
export { resolveRunningCs, collectRunCsRows, CS_MIN_MPS, CS_MAX_MPS } from "./cs-resolution.js";
export type { ResolvedCs, RunCsRow, CsConfidence } from "./cs-resolution.js";

// ─── Constants ────────────────────────────────────────────────────────
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

// ─── Path resolution ──────────────────────────────────────────────────
export { referenceDataDir } from "./paths.js";

// ─── Compaction tokens ───────────────────────────────────────────────
export { REFERENCE_PRESERVE_TOKENS } from "./preserve-tokens.js";

// ─── Zod schemas + per-file SCHEMA_VERSION constants ──────────────────
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

// ─── Input-schema projections ────────────────────────────────────────
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

// ─── Trademark policy + anti-corruption layer (ADR-0012) ──────────────
export {
  TP_API_FIELDS,
  TP_DENYLIST_FIELDS,
} from "./trademark-policy.js";
export {
  assertNoTpKeysRemain,
  parseRenamedActivity,
  parseRenamedWellnessRow,
  renameTpFieldsOnActivity,
  renameTpFieldsOnWellnessRow,
  type RenamedActivityRow,
  type RenamedWellnessRow,
} from "./sync/rename-tp-fields.js";
export {
  makeIntervalsHttpFactory,
  type RunScopedHttpFactory,
  type RunScopedHttpFactoryArgs,
} from "./sync/intervals-client-factory.js";
export { normalizeStreams } from "./sync/fetch-live-bundle.js";

// ─── Validation: recommendation metadata + audit log ──────────────────
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

// ─── Validation: Layer-1 sync gate ────────────────────────────────────
export { gateLatestJson } from "./validation/sync-gate.js";
export type {
  GateResult,
  GateStep,
  GateFailure,
  GateWarning,
} from "./validation/sync-gate.js";

// ─── Validation: Layer-2 validator + Layer-3 prompt rules ──────────────
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
