import { mkdirSync, readFileSync } from "node:fs";
import { z } from "zod";
import { atomicWriteFileSync } from "./io/atomic-write-file-sync.js";
import { withInterprocessFileLockSync } from "./io/interprocess-file-lock-sync.js";

export interface ModelCatalogPaths {
  readonly attemptLock: string;
  readonly attemptState: string;
  readonly installationDirectory: string;
  readonly ownerLock: string;
  readonly ownerSnapshot: string;
  readonly privateDirectory: string;
  readonly privateSnapshot: string;
}

export const MODEL_CATALOG_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export const ATTEMPT_STATE_VERSION = 1;

const InFlightAttemptStateSchema = z
  .object({
    schemaVersion: z.literal(ATTEMPT_STATE_VERSION),
    attemptStatus: z.literal("in-flight"),
    lastAttemptAt: z.string().datetime({ offset: true }),
    systemUptimeMs: z.number().finite().nonnegative(),
  })
  .strict();
const CompletedAttemptStateSchema = z
  .object({
    schemaVersion: z.literal(ATTEMPT_STATE_VERSION),
    attemptStatus: z.literal("completed"),
    lastAttemptAt: z.string().datetime({ offset: true }),
    systemUptimeMs: z.number().finite().nonnegative(),
  })
  .strict();
const AttemptStateSchema = z.discriminatedUnion("attemptStatus", [
  InFlightAttemptStateSchema,
  CompletedAttemptStateSchema,
]);

interface AttemptAnchor {
  readonly lastAttemptAt: number;
  readonly serialized: string;
  readonly systemUptimeMs: number;
}

export type AttemptRead =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "in-flight"; anchor: AttemptAnchor }>
  | Readonly<{ kind: "completed"; anchor: AttemptAnchor }>;

type DurableAttempt =
  | Readonly<{ kind: "in-flight"; anchor: AttemptAnchor }>
  | Readonly<{ kind: "completed"; anchor: AttemptAnchor }>;

type AttemptClaim =
  | Readonly<{ kind: "claimed"; anchor: AttemptAnchor }>
  | Readonly<{ kind: "not-due"; anchor: AttemptAnchor }>
  | Readonly<{ kind: "repaired"; anchor: AttemptAnchor }>
  | Readonly<{ kind: "failed" }>;

type AttemptTransition =
  | Readonly<{ kind: "transitioned"; anchor: AttemptAnchor }>
  | Readonly<{ kind: "superseded" }>
  | Readonly<{ kind: "failed" }>;

export function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

export function readAttempt(path: string): AttemptRead {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return errorCode(error) === "ENOENT" ? { kind: "missing" } : { kind: "invalid" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "invalid" };
  }
  const state = AttemptStateSchema.safeParse(parsed);
  if (!state.success) return { kind: "invalid" };
  const lastAttemptAt = Date.parse(state.data.lastAttemptAt);
  if (!Number.isFinite(lastAttemptAt)) return { kind: "invalid" };
  return {
    kind: state.data.attemptStatus,
    anchor: {
      lastAttemptAt,
      serialized: state.data.lastAttemptAt,
      systemUptimeMs: state.data.systemUptimeMs,
    },
  };
}

export function serializedTime(now: number): string | undefined {
  if (!Number.isFinite(now)) return undefined;
  try {
    return new Date(now).toISOString();
  } catch {
    return undefined;
  }
}

export function writeJson(path: string, value: unknown): void {
  atomicWriteFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function attemptAnchor(
  lastAttemptAt: number,
  systemUptimeMs: number,
): AttemptAnchor | undefined {
  const serialized = serializedTime(lastAttemptAt);
  if (serialized === undefined || !Number.isFinite(systemUptimeMs) || systemUptimeMs < 0) {
    return undefined;
  }
  return { lastAttemptAt, serialized, systemUptimeMs };
}

export function writeAttempt(path: string, attempt: DurableAttempt): void {
  writeJson(path, {
    schemaVersion: ATTEMPT_STATE_VERSION,
    attemptStatus: attempt.kind,
    lastAttemptAt: attempt.anchor.serialized,
    systemUptimeMs: attempt.anchor.systemUptimeMs,
  });
}

export function sameAttempt(left: AttemptAnchor, right: AttemptAnchor): boolean {
  return left.serialized === right.serialized && left.systemUptimeMs === right.systemUptimeMs;
}

export function claimAttempt(
  paths: ModelCatalogPaths,
  now: number,
  systemUptimeMs: number,
  elapsedWindowMs: number,
): AttemptClaim {
  try {
    mkdirSync(paths.installationDirectory, { recursive: true, mode: 0o700 });
    return withInterprocessFileLockSync(paths.attemptLock, () => {
      const observed = attemptAnchor(now, systemUptimeMs);
      if (observed === undefined) return { kind: "failed" };
      const prior = readAttempt(paths.attemptState);
      if (prior.kind === "in-flight") {
        const repaired = attemptAnchor(Math.max(now, prior.anchor.lastAttemptAt), systemUptimeMs);
        if (repaired === undefined) return { kind: "failed" };
        writeAttempt(paths.attemptState, { kind: "completed", anchor: repaired });
        return { kind: "repaired", anchor: repaired };
      }
      if (prior.kind === "completed") {
        if (systemUptimeMs < prior.anchor.systemUptimeMs) {
          const repaired = attemptAnchor(Math.max(now, prior.anchor.lastAttemptAt), systemUptimeMs);
          if (repaired === undefined) return { kind: "failed" };
          writeAttempt(paths.attemptState, { kind: "completed", anchor: repaired });
          return { kind: "repaired", anchor: repaired };
        }
        const wallElapsed = now - prior.anchor.lastAttemptAt;
        const uptimeElapsed = systemUptimeMs - prior.anchor.systemUptimeMs;
        if (wallElapsed < MODEL_CATALOG_REFRESH_INTERVAL_MS || uptimeElapsed < elapsedWindowMs) {
          return { kind: "not-due", anchor: prior.anchor };
        }
      }
      if (prior.kind === "invalid") {
        const repaired = attemptAnchor(now, systemUptimeMs);
        if (repaired === undefined) return { kind: "failed" };
        writeAttempt(paths.attemptState, { kind: "completed", anchor: repaired });
        return { kind: "repaired", anchor: repaired };
      }
      writeAttempt(paths.attemptState, { kind: "in-flight", anchor: observed });
      return { kind: "claimed", anchor: observed };
    });
  } catch {
    return { kind: "failed" };
  }
}

export function transitionAttempt(
  paths: ModelCatalogPaths,
  expected: DurableAttempt,
  next: DurableAttempt,
): AttemptTransition {
  try {
    return withInterprocessFileLockSync(paths.attemptLock, () => {
      const current = readAttempt(paths.attemptState);
      if (current.kind !== expected.kind || !sameAttempt(current.anchor, expected.anchor)) {
        return { kind: "superseded" };
      }
      writeAttempt(paths.attemptState, next);
      return { kind: "transitioned", anchor: next.anchor };
    });
  } catch {
    return { kind: "failed" };
  }
}

export function reanchorAttempt(
  paths: ModelCatalogPaths,
  claimed: AttemptAnchor,
  now: number,
  systemUptimeMs: number,
): AttemptTransition {
  const observed = attemptAnchor(now, systemUptimeMs);
  if (observed === undefined) return { kind: "failed" };
  return transitionAttempt(
    paths,
    { kind: "in-flight", anchor: claimed },
    { kind: "in-flight", anchor: observed },
  );
}

export function completeAttempt(
  paths: ModelCatalogPaths,
  pending: AttemptAnchor,
  now: number,
  systemUptimeMs: number,
): AttemptTransition {
  const observed = attemptAnchor(now, systemUptimeMs);
  if (observed === undefined) return { kind: "failed" };
  return transitionAttempt(
    paths,
    { kind: "in-flight", anchor: pending },
    { kind: "completed", anchor: observed },
  );
}
