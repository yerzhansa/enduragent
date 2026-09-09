import init001 from "./001_init.sql";
import sql from "./002_repair_log.sql";
import dedup003 from "./003_dedup_confirmation.sql";
import fixerSettings004 from "./004_repair_fixer_settings.sql";
import syncState005 from "./005_sync_state.sql";
import incremental006 from "./006_incremental_ingest.sql";
import syncFailure007 from "./007_sync_failure.sql";
import storeOwner008 from "./008_store_owner.sql";
import activitySourceResolver009 from "./009_activity_source_resolver.sql";
import analyticsCurves010 from "./010_analytics_curves.sql";
import activityAnalysisProjection011 from "./011_activity_analysis_projection.sql";
import planning012 from "./012_planning.sql";
import planConversations013 from "./013_plan_conversations.sql";
import planReconciliation014 from "./014_plan_reconciliation.sql";
import planRaceCourse015 from "./015_plan_race_course.sql";
import planWorkoutMatch016 from "./016_plan_workout_match.sql";
import planWorkoutDrift017 from "./017_plan_workout_drift.sql";
import planProposals018 from "./018_plan_proposals.sql";
import planAdaptationLedger019 from "./019_plan_adaptation_ledger.sql";
import planSettings020 from "./020_plan_settings.sql";
import planReplacement021 from "./021_plan_replacement.sql";
import planWeeklyReview022 from "./022_plan_weekly_review.sql";
import planRaceOutcome023 from "./023_plan_race_outcome.sql";
import planIntake024 from "./024_plan_intake.sql";
import chatAttachments025 from "./025_chat_attachments.sql";
import planningRequests026 from "./026_planning_requests.sql";
import chatPlanOutbox027 from "./027_chat_plan_outbox.sql";
import planWorkoutAdditions028 from "./028_plan_workout_additions.sql";
import planningDomain029 from "./029_planning_domain.sql";
import trainingHistoryCoverage030 from "./030_training_history_coverage.sql";
import trainingHistoryGapEvidence031 from "./031_training_history_gap_evidence.sql";
import planningAuthority032 from "./032_planning_authority.sql";

export interface Migration {
  /** Ascending schema version this migration advances the store to. */
  readonly version: number;
  /** The migration file's stem (diagnostics only). */
  readonly name: string;
  /** The DDL text, bundled as a string at build time. */
  readonly sql: string;
}

/**
 * Ordered numbered migrations, ascending by version. The migrator applies each
 * whose version exceeds the store's PRAGMA user_version, in order.
 */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: "001_init", sql: init001 },
  { version: 2, name: "002_repair_log", sql },
  { version: 3, name: "003_dedup_confirmation", sql: dedup003 },
  { version: 4, name: "004_repair_fixer_settings", sql: fixerSettings004 },
  { version: 5, name: "005_sync_state", sql: syncState005 },
  { version: 6, name: "006_incremental_ingest", sql: incremental006 },
  { version: 7, name: "007_sync_failure", sql: syncFailure007 },
  { version: 8, name: "008_store_owner", sql: storeOwner008 },
  { version: 9, name: "009_activity_source_resolver", sql: activitySourceResolver009 },
  { version: 10, name: "010_analytics_curves", sql: analyticsCurves010 },
  { version: 11, name: "011_activity_analysis_projection", sql: activityAnalysisProjection011 },
  { version: 12, name: "012_planning", sql: planning012 },
  { version: 13, name: "013_plan_conversations", sql: planConversations013 },
  { version: 14, name: "014_plan_reconciliation", sql: planReconciliation014 },
  { version: 15, name: "015_plan_race_course", sql: planRaceCourse015 },
  { version: 16, name: "016_plan_workout_match", sql: planWorkoutMatch016 },
  { version: 17, name: "017_plan_workout_drift", sql: planWorkoutDrift017 },
  { version: 18, name: "018_plan_proposals", sql: planProposals018 },
  { version: 19, name: "019_plan_adaptation_ledger", sql: planAdaptationLedger019 },
  { version: 20, name: "020_plan_settings", sql: planSettings020 },
  { version: 21, name: "021_plan_replacement", sql: planReplacement021 },
  { version: 22, name: "022_plan_weekly_review", sql: planWeeklyReview022 },
  { version: 23, name: "023_plan_race_outcome", sql: planRaceOutcome023 },
  { version: 24, name: "024_plan_intake", sql: planIntake024 },
  { version: 25, name: "025_chat_attachments", sql: chatAttachments025 },
  { version: 26, name: "026_planning_requests", sql: planningRequests026 },
  { version: 27, name: "027_chat_plan_outbox", sql: chatPlanOutbox027 },
  { version: 28, name: "028_plan_workout_additions", sql: planWorkoutAdditions028 },
  { version: 29, name: "029_planning_domain", sql: planningDomain029 },
  { version: 30, name: "030_training_history_coverage", sql: trainingHistoryCoverage030 },
  { version: 31, name: "031_training_history_gap_evidence", sql: trainingHistoryGapEvidence031 },
  { version: 32, name: "032_planning_authority", sql: planningAuthority032 },
];
