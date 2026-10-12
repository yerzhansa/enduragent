import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

  recordSelfUpdate(marker: SelfUpdateMarker): void {
    const state = this.load();
    state.selfUpdate = marker;
    if (typeof marker.updateId === "number") {
      this.record(state, marker.updateId, this.dependencies.now());
    }
    this.save(state);
  }
}
