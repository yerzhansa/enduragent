import type { IpcRenderer } from "electron";
import {
  DESKTOP_INTERVALS_SIGN_IN_CANCEL_CHANNEL,
  DESKTOP_INTERVALS_SIGN_IN_CHANNEL,
  DESKTOP_INTERVALS_SIGN_IN_PROGRESS_CHANNEL,
  DESKTOP_INTERVALS_SIGN_IN_REOPEN_CHANNEL,
} from "../main/constants.js";
import { displayableAthleteName } from "../main/intervals-athlete-name.js";
import { exactKeys, record, RUNTIME_STATES } from "./shape.js";

type IntervalsSignInPhase = "waiting-for-browser" | "completing-sign-in";

const INTERVALS_CREDENTIAL_REFUSAL_REASONS = new Set([
  "sign-in-denied",
  "sign-in-failed",
  "sign-in-timed-out",
  "sign-in-cancelled",
  "sign-in-unreachable",
  "credential-rejected",
  "malformed-athlete-response",
  "validation-timeout",
  "validation-aborted",
  "validation-unavailable",
  "training-account-mismatch",
  "owner-unresolved",
  "store-unavailable",
  "encryption-unavailable",
  "unsafe-backend",
  "storage-failed",
  "runtime-unavailable",
]);

function parseIntervalsCredentialCurrent(value: unknown): unknown {
  if (
    !record(value) ||
    !exactKeys(value, ["runtimeState", "slot", "state"]) ||
    value.slot !== "intervals-icu" ||
    (value.state !== "missing" && value.state !== "configured" && value.state !== "re-prompt") ||
    (value.state === "configured"
      ? !RUNTIME_STATES.has(value.runtimeState as string)
      : value.runtimeState !== null)
  ) {
    throw new TypeError();
  }
  return { slot: "intervals-icu", state: value.state, runtimeState: value.runtimeState };
}

function parseAthleteName(value: unknown): string {
  const name = displayableAthleteName(value);
  if (name === undefined) throw new TypeError();
  return name;
}

export function parseIntervalsSignInResult(value: unknown): unknown {
  if (!record(value) || typeof value.outcome !== "string") throw new TypeError();
  const current = parseIntervalsCredentialCurrent(value.current);
  if (value.outcome === "applied" && exactKeys(value, ["current", "outcome"])) {
    return { outcome: "applied", current };
  }
  if (value.outcome === "applied" && exactKeys(value, ["athleteName", "current", "outcome"])) {
    return { outcome: "applied", current, athleteName: parseAthleteName(value.athleteName) };
  }
  if (
    value.outcome === "refused" &&
    typeof value.reason === "string" &&
    INTERVALS_CREDENTIAL_REFUSAL_REASONS.has(value.reason) &&
    exactKeys(value, ["current", "outcome", "reason"])
  ) {
    return { outcome: "refused", reason: value.reason, current };
  }
  if (value.outcome === "saved-not-active" && exactKeys(value, ["current", "outcome"])) {
    return { outcome: "saved-not-active", current };
  }
  if (
    value.outcome === "uncertain" &&
    value.reason === "storage-uncertain" &&
    exactKeys(value, ["current", "outcome", "reason"])
  ) {
    return { outcome: "uncertain", reason: "storage-uncertain", current };
  }
  throw new TypeError();
}

function progressPhase(value: unknown): IntervalsSignInPhase | undefined {
  if (!record(value) || !exactKeys(value, ["phase"])) return undefined;
  return value.phase === "waiting-for-browser" || value.phase === "completing-sign-in"
    ? value.phase
    : undefined;
}

function requireZeroArguments(args: readonly unknown[]): void {
  if (args.length !== 0) throw new TypeError();
}

async function invokeParsed<T>(
  ipc: Pick<IpcRenderer, "invoke">,
  channel: string,
  parse: (value: unknown) => T,
): Promise<T> {
  try {
    return parse(await ipc.invoke(channel));
  } catch {
    throw new TypeError();
  }
}

function parseBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new TypeError();
  return value;
}

export function createIntervalsSignInBridge(ipc: Pick<IpcRenderer, "invoke" | "on">) {
  const listeners = new Set<(phase: IntervalsSignInPhase) => void>();
  ipc.on(DESKTOP_INTERVALS_SIGN_IN_PROGRESS_CHANNEL, (_event, value: unknown) => {
    const phase = progressPhase(value);
    if (phase === undefined) return;
    for (const listener of listeners) queueMicrotask(() => listener(phase));
  });
  return {
    signInWithIntervals: async (...args: unknown[]) => {
      requireZeroArguments(args);
      return invokeParsed(ipc, DESKTOP_INTERVALS_SIGN_IN_CHANNEL, parseIntervalsSignInResult);
    },
    cancelIntervalsSignIn: async (...args: unknown[]) => {
      requireZeroArguments(args);
      return invokeParsed(ipc, DESKTOP_INTERVALS_SIGN_IN_CANCEL_CHANNEL, parseBoolean);
    },
    reopenIntervalsSignIn: async (...args: unknown[]) => {
      requireZeroArguments(args);
      return invokeParsed(ipc, DESKTOP_INTERVALS_SIGN_IN_REOPEN_CHANNEL, parseBoolean);
    },
    onIntervalsSignInProgress: (listener: unknown) => {
      if (typeof listener !== "function") throw new TypeError();
      const typedListener = listener as (phase: IntervalsSignInPhase) => void;
      listeners.add(typedListener);
      return (): void => {
        listeners.delete(typedListener);
      };
    },
  };
}
