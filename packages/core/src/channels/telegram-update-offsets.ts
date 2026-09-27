import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Durable Telegram update-offset / dedupe store. Normal polling no longer drops
// pending updates on startup (so a message sent while the bot was down is still
// delivered on restart); this store is the safety that keeps a restart from
// re-processing an update the previous run already handled, and keeps a
// self-update `/update` from re-triggering itself after the restart.
//
// The store is owner-only JSON under dataDir, keyed by a short SHA-256 of the
// bot token so two bots sharing a dataDir never share a dedupe log. The raw
// token is NEVER written — only its fingerprint appears (in the filename).

// Bounded ring of recently dispatched update ids. Guards exact-replay dedupe
// (a crash mid-turn re-delivers an update whose id was already recorded).
export const MAX_DISPATCHED_IDS = 200;
export const UPDATE_ID_EPOCH_INACTIVITY_MS = 7 * 24 * 60 * 60 * 1_000;

const STORE_VERSION = 2 as const;

export interface TelegramUpdateOffsetDependencies {
  readonly now: () => number;
}

export interface SelfUpdateMarker {
  updateId: number | null;
  chatId: number;
  ts: string;
  targetVersion: string;
}

export interface UpdateOffsetState {
  version: typeof STORE_VERSION;
  lastUpdateId: number;
  lastAcceptedAtMs: number | null;
  dispatchedUpdateIds: number[];
  selfUpdate?: SelfUpdateMarker;
}

// Short, non-reversible fingerprint of the bot token. Only the first 16 hex
// chars are used — enough to disambiguate co-located bots, not enough to be a
// credential.
export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

function emptyState(): UpdateOffsetState {
  return {
    version: STORE_VERSION,
    lastUpdateId: 0,
    lastAcceptedAtMs: null,
    dispatchedUpdateIds: [],
  };
}

function parsePersistedUpdateIds(
  value: Record<string, unknown>,
): Pick<UpdateOffsetState, "lastUpdateId" | "dispatchedUpdateIds"> | null {
  if (
    typeof value.lastUpdateId !== "number" ||
    !Number.isSafeInteger(value.lastUpdateId) ||
    value.lastUpdateId < 0 ||
    !Array.isArray(value.dispatchedUpdateIds) ||
    value.dispatchedUpdateIds.length > MAX_DISPATCHED_IDS
  ) {
    return null;
  }

  const dispatchedUpdateIds: number[] = [];
  for (const updateId of value.dispatchedUpdateIds) {
    if (
      typeof updateId !== "number" ||
      !Number.isSafeInteger(updateId) ||
      updateId <= 0 ||
      (dispatchedUpdateIds.length > 0 &&
        updateId <= dispatchedUpdateIds[dispatchedUpdateIds.length - 1]!)
    ) {
      return null;
    }
    dispatchedUpdateIds.push(updateId);
  }

  const lastDispatchedUpdateId = dispatchedUpdateIds.at(-1) ?? 0;
  if (lastDispatchedUpdateId !== value.lastUpdateId) return null;
  return { lastUpdateId: value.lastUpdateId, dispatchedUpdateIds };
}

export class TelegramUpdateOffsetStore {
  private readonly path: string;
  private readonly dependencies: TelegramUpdateOffsetDependencies;

  constructor(
    dataDir: string,
    token: string,
    dependencies: TelegramUpdateOffsetDependencies = { now: Date.now },
  ) {
    this.path = join(dataDir, `telegram-offsets.${tokenFingerprint(token)}.json`);
    this.dependencies = dependencies;
  }

  load(): UpdateOffsetState {
    if (!existsSync(this.path)) return emptyState();
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.path, "utf-8"));
    } catch {
      return emptyState();
    }
    if (typeof parsed !== "object" || parsed === null) return emptyState();
    const v = parsed as Record<string, unknown>;
    if (v.version !== 1 && v.version !== STORE_VERSION) return emptyState();
    const persistedUpdateIds = parsePersistedUpdateIds(v);
    if (persistedUpdateIds === null) return emptyState();
    const { lastUpdateId, dispatchedUpdateIds } = persistedUpdateIds;
    let lastAcceptedAtMs: number | null = null;
    if (typeof v.lastAcceptedAtMs === "number" && Number.isFinite(v.lastAcceptedAtMs)) {
      lastAcceptedAtMs = v.lastAcceptedAtMs;
    } else if (v.version === 1) {
      try {
        lastAcceptedAtMs = statSync(this.path).mtimeMs;
      } catch (error) {
        if (!(typeof error === "object" && error !== null && "code" in error && String(error.code) === "ENOENT")) throw error;
        lastAcceptedAtMs = null;
      }
    }
    if (
      v.version === STORE_VERSION &&
      lastAcceptedAtMs === null &&
      (lastUpdateId !== 0 || dispatchedUpdateIds.length > 0)
    ) {
      return emptyState();
    }
    const state: UpdateOffsetState = {
      version: STORE_VERSION,
      lastUpdateId,
      lastAcceptedAtMs,
      dispatchedUpdateIds,
    };
    const marker = v.selfUpdate;
    if (typeof marker === "object" && marker !== null) {
      const m = marker as Record<string, unknown>;
      if (
        typeof m.chatId === "number" &&
        typeof m.ts === "string" &&
        typeof m.targetVersion === "string"
      ) {
        state.selfUpdate = {
          updateId: typeof m.updateId === "number" ? m.updateId : null,
          chatId: m.chatId,
          ts: m.ts,
          targetVersion: m.targetVersion,
        };
      }
    }
    return state;
  }

  private save(state: UpdateOffsetState): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, this.path);
  }

  // Record an update id as dispatched, advancing the offset and the bounded ring.
  private record(state: UpdateOffsetState, updateId: number, acceptedAtMs: number): void {
    if (updateId > state.lastUpdateId) {
      state.dispatchedUpdateIds.push(updateId);
      if (state.dispatchedUpdateIds.length > MAX_DISPATCHED_IDS) {
        state.dispatchedUpdateIds = state.dispatchedUpdateIds.slice(-MAX_DISPATCHED_IDS);
      }
      state.lastUpdateId = updateId;
    }
    state.lastAcceptedAtMs = Math.max(state.lastAcceptedAtMs ?? acceptedAtMs, acceptedAtMs);
  }

  // Returns true if this update should be dispatched, recording it first —
  // record before dispatch so a crash-mid-turn re-delivery dedupes safely.
  // Fails OPEN: a corrupt or unwritable store must never silence the athlete, so
  // any error means "dispatch it" rather than dropping the message.
  shouldDispatch(updateId: number): boolean {
    try {
      const state = this.load();
      const acceptedAtMs = this.dependencies.now();
      if (updateId <= state.lastUpdateId) {
        if (
          state.lastAcceptedAtMs === null ||
          acceptedAtMs - state.lastAcceptedAtMs < UPDATE_ID_EPOCH_INACTIVITY_MS
        ) {
          return false;
        }
        // Telegram may choose a new, lower update-id sequence after a week
        // without generated updates. We only know when an update was last
        // accepted, which can make this reset early when newer updates were
        // ignored, but cannot make it miss a genuine week-long epoch change.
        // Resetting favors delivery and may permit a duplicate from the old
        // bounded replay ring; retaining the high-water mark could drop every
        // message in the new epoch.
        state.lastUpdateId = 0;
        state.dispatchedUpdateIds = [];
      }
      if (state.dispatchedUpdateIds.includes(updateId)) return false;
      this.record(state, updateId, acceptedAtMs);
      this.save(state);
      return true;
    } catch {
      return true;
    }
  }

  // Persist a self-update marker before `/update` stops the bot. The marker id
  // is recorded as dispatched so the re-delivered `/update` is deduped after the
  // restart. Throws on write failure so the caller can decline to stop.
  recordSelfUpdate(marker: SelfUpdateMarker): void {
    const state = this.load();
    state.selfUpdate = marker;
    if (typeof marker.updateId === "number") {
      this.record(state, marker.updateId, this.dependencies.now());
    }
    this.save(state);
  }
}
