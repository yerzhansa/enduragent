//
// Single source of truth for Reference's freshness, retention, and sync-loop
// timing constants. Imported by every Reference module that needs a window;
// no Reference module hardcodes these numbers locally.

// ─── Freshness windows (since `last_updated` in latest.json) ───────────
/** <24 h: data is fresh; coaching uses it without caveat. */
export const FRESH_MS = 24 * 60 * 60 * 1000;
/** >48 h: data is stale; trigger lazy refresh in the background. */
export const STALE_MS = 48 * 60 * 60 * 1000;
/** >7 d: data is critical; force a fresh sync before answering. */
export const CRITICAL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Tolerance for a `last_updated` timestamp in the future. A few minutes of
 * clock skew (NTP correction, VM time-sync) is benign; beyond this the
 * timestamp is impossible and the cache is treated as stale rather than fresh.
 */
export const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

export type ReferenceFreshness = "fresh" | "flag" | "stale" | "critical";

export function referenceFreshnessAt(
  instant: string,
  now: Date = new Date(),
): ReferenceFreshness {
  const refreshedAt = Date.parse(instant);
  const evaluatedAt = now.getTime();
  if (!Number.isFinite(refreshedAt) || !Number.isFinite(evaluatedAt)) return "stale";
  const elapsed = evaluatedAt - refreshedAt;
  if (elapsed < -FUTURE_TOLERANCE_MS) return "stale";
  if (elapsed >= CRITICAL_MS) return "critical";
  if (elapsed >= STALE_MS) return "stale";
  if (elapsed >= FRESH_MS) return "flag";
  return "fresh";
}

// ─── Retention windows ─────────────────────────────────────────────────
/** Days of history retained at "latest" granularity (recent activities + wellness). */
export const LATEST_RETENTION_DAYS = 7;

// ─── Sync-loop timing (mutex / cooldown / scheduled tick) ──────────────
/**
 * Maximum time `runSync()` waits to acquire the sync mutex before responding
 * with a soft "another sync in flight, try again shortly" message. This
 * constant pins the SLA.
 */
export const MUTEX_ACQUIRE_TIMEOUT_MS = 30_000;
/**
 * Outer-operation timeout for a single `runSync()` body. If this fires, the
 * mutex is force-released, in-flight HTTP is aborted, and `error_state.json`
 * is written for the curator's visibility.
 */
export const SYNC_OPERATION_TIMEOUT_MS = 120_000;
/** Per-chat cooldown for the `/sync` Telegram command. */
export const SYNC_COOLDOWN_MS = 30_000;
/** Mutex acquire time over this threshold logs a WARN — operator signal. */
export const MUTEX_HOT_WARN_MS = 10_000;
/** Scheduled refresh cadence (in-process timer). */
export const SCHEDULED_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
/**
 * Per-request HTTP timeout chained with the orchestrator-level signal so a
 * single hung endpoint cannot consume the full SYNC_OPERATION_TIMEOUT_MS
 * budget (ADR-0011, point 2).
 */
export const PER_REQUEST_TIMEOUT_MS = 30_000;

// ─── /snapshot raw chunked-vs-document dispatch ─────────────────────────
/** If `formatSnapshotRaw` produces more chunks than this, send as a document. */
export const SNAPSHOT_DOCUMENT_THRESHOLD_CHUNKS = 10;
/** If the raw dump exceeds this byte budget, send as a document instead of chunked replies. */
export const SNAPSHOT_DOCUMENT_THRESHOLD_BYTES = 65_536;
