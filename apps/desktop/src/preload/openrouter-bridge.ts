import type { IpcRenderer } from "electron";
import {
  DESKTOP_OPENROUTER_CODE_SIGN_IN_CHANNEL,
  DESKTOP_OPENROUTER_CREDIT_STATUS_CHANNEL,
  DESKTOP_OPENROUTER_OPEN_PAGE_CHANNEL,
  DESKTOP_OPENROUTER_SIGN_IN_CANCEL_CHANNEL,
  DESKTOP_OPENROUTER_SIGN_IN_CHANNEL,
  DESKTOP_OPENROUTER_SIGN_IN_PROGRESS_CHANNEL,
  DESKTOP_OPENROUTER_SIGN_IN_REOPEN_CHANNEL,
  DESKTOP_OPENROUTER_USE_COPIED_CODE_CHANNEL,
} from "../main/constants.js";
import { exactKeys, record } from "./shape.js";

type OpenRouterSignInPhase = "waiting-for-browser" | "completing-sign-in";

interface OpenRouterSignInProgress {
  readonly operationId: string;
  readonly phase: OpenRouterSignInPhase;
}

const OPERATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const CREDIT_STATUSES: ReadonlySet<unknown> = new Set(["paid", "never-paid", "unknown"]);
const PAGES: ReadonlySet<unknown> = new Set(["credits", "keys"]);
const REFUSALS: ReadonlySet<unknown> = new Set([
  "already-in-progress",
  "cancelled",
  "not-finished",
  "unreachable",
  "not-saved",
  "saved-not-active",
  "clipboard-no-code",
  "clipboard-unavailable",
  "code-expired",
  "invalid-input",
]);

function operationIdOf(value: unknown): string {
  if (typeof value !== "string" || !OPERATION_ID_PATTERN.test(value)) throw new TypeError();
  return value;
}

function parseCredit(value: unknown): string {
  if (typeof value !== "string" || !CREDIT_STATUSES.has(value)) throw new TypeError();
  return value;
}

export function parseOpenRouterSignInResult(value: unknown, operationId: string): unknown {
  if (!record(value) || value.operationId !== operationId) throw new TypeError();
  if (value.status === "connected" && exactKeys(value, ["credit", "operationId", "status"])) {
    return { status: "connected", operationId, credit: parseCredit(value.credit) };
  }
  if (value.status === "awaiting-code" && exactKeys(value, ["operationId", "status"])) {
    return { status: "awaiting-code", operationId };
  }
  if (
    value.status === "refused" &&
    exactKeys(value, ["operationId", "reason", "status"]) &&
    REFUSALS.has(value.reason)
  ) {
    return { status: "refused", operationId, reason: value.reason };
  }
  throw new TypeError();
}

function parseProgress(value: unknown): OpenRouterSignInProgress | undefined {
  if (!record(value) || !exactKeys(value, ["operationId", "phase"])) return undefined;
  if (typeof value.operationId !== "string" || !OPERATION_ID_PATTERN.test(value.operationId)) {
    return undefined;
  }
  return value.phase === "waiting-for-browser" || value.phase === "completing-sign-in"
    ? { operationId: value.operationId, phase: value.phase }
    : undefined;
}

function parseBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new TypeError();
  return value;
}

async function invokeParsed<T>(
  ipc: Pick<IpcRenderer, "invoke">,
  channel: string,
  args: readonly unknown[],
  parse: (value: unknown) => T,
): Promise<T> {
  try {
    return parse(await ipc.invoke(channel, ...args));
  } catch {
    throw new TypeError();
  }
}

export function createOpenRouterSignInBridge(
  ipc: Pick<IpcRenderer, "invoke" | "on">,
  parseSelection: (value: unknown) => unknown,
) {
  const listeners = new Set<(progress: OpenRouterSignInProgress) => void>();
  ipc.on(DESKTOP_OPENROUTER_SIGN_IN_PROGRESS_CHANNEL, (_event, value: unknown) => {
    const progress = parseProgress(value);
    if (progress === undefined) return;
    for (const listener of listeners) queueMicrotask(() => listener({ ...progress }));
  });
  const start = async (channel: string, input: unknown) => {
    if (!record(input) || !exactKeys(input, ["operationId", "selection"])) throw new TypeError();
    const operationId = operationIdOf(input.operationId);
    const request = { operationId, selection: parseSelection(input.selection) };
    return invokeParsed(ipc, channel, [request], (value) =>
      parseOpenRouterSignInResult(value, operationId),
    );
  };
  const withOperation = <T>(channel: string, input: unknown, parse: (value: unknown) => T) => {
    const operationId = operationIdOf(input);
    return invokeParsed(ipc, channel, [{ operationId }], parse);
  };
  return {
    openRouterSignIn: (input: unknown) => start(DESKTOP_OPENROUTER_SIGN_IN_CHANNEL, input),
    startOpenRouterCodeSignIn: (input: unknown) =>
      start(DESKTOP_OPENROUTER_CODE_SIGN_IN_CHANNEL, input),
    useCopiedOpenRouterCode: async (input: unknown) =>
      withOperation(DESKTOP_OPENROUTER_USE_COPIED_CODE_CHANNEL, input, (value) =>
        parseOpenRouterSignInResult(value, operationIdOf(input)),
      ),
    cancelOpenRouterSignIn: async (input: unknown) =>
      withOperation(DESKTOP_OPENROUTER_SIGN_IN_CANCEL_CHANNEL, input, parseBoolean),
    reopenOpenRouterSignIn: async (input: unknown) =>
      withOperation(DESKTOP_OPENROUTER_SIGN_IN_REOPEN_CHANNEL, input, parseBoolean),
    openRouterCreditStatus: async (...args: unknown[]) => {
      if (args.length !== 0) throw new TypeError();
      return invokeParsed(ipc, DESKTOP_OPENROUTER_CREDIT_STATUS_CHANNEL, [], parseCredit);
    },
    openOpenRouterPage: async (page: unknown) => {
      if (!PAGES.has(page)) throw new TypeError();
      return invokeParsed(ipc, DESKTOP_OPENROUTER_OPEN_PAGE_CHANNEL, [{ page }], parseBoolean);
    },
    onOpenRouterSignInProgress: (listener: unknown) => {
      if (typeof listener !== "function") throw new TypeError();
      const typedListener = listener as (progress: OpenRouterSignInProgress) => void;
      listeners.add(typedListener);
      return (): void => {
        listeners.delete(typedListener);
      };
    },
  };
}
