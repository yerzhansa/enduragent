import type { OpenRouterCreditStatus, OpenRouterSignInPhase } from "@enduragent/core";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import {
  DESKTOP_OPENROUTER_CODE_SIGN_IN_CHANNEL,
  DESKTOP_OPENROUTER_CREDIT_STATUS_CHANNEL,
  DESKTOP_OPENROUTER_OPEN_PAGE_CHANNEL,
  DESKTOP_OPENROUTER_SIGN_IN_CANCEL_CHANNEL,
  DESKTOP_OPENROUTER_SIGN_IN_CHANNEL,
  DESKTOP_OPENROUTER_SIGN_IN_PROGRESS_CHANNEL,
  DESKTOP_OPENROUTER_SIGN_IN_REOPEN_CHANNEL,
  DESKTOP_OPENROUTER_USE_COPIED_CODE_CHANNEL,
} from "./constants.js";
import type { CredentialWriteResult } from "./credential-vault.js";
import { parseOnboardingLlmSelection, type OnboardingLlmSelection } from "./llm-selection.js";
import type {
  OpenRouterAuthController,
  OpenRouterKeyStore,
  OpenRouterPage,
  OpenRouterSignInResult,
  OpenRouterStoreOutcome,
} from "./openrouter-auth.js";
import { isDesktopRendererUrl } from "./renderer-navigation.js";

const OPERATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const CREDIT_STATUSES: ReadonlySet<string> = new Set(["paid", "never-paid", "unknown"]);
const PAGES: ReadonlySet<string> = new Set(["credits", "keys"]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && [...keys].sort().every((key, i) => key === actual[i]);
}

function single(args: readonly unknown[], keys: readonly string[]): Record<string, unknown> {
  const value = args[0];
  if (args.length !== 1 || !record(value) || !exactKeys(value, keys)) throw new TypeError();
  return value;
}

function operationIdOf(value: Record<string, unknown>): string {
  const operationId = value.operationId;
  if (typeof operationId !== "string" || !OPERATION_ID_PATTERN.test(operationId)) {
    throw new TypeError();
  }
  return operationId;
}

export function parseOpenRouterSignInSelection(value: unknown): OnboardingLlmSelection {
  const selection = parseOnboardingLlmSelection(value);
  if (selection.provider !== "openrouter") throw new TypeError();
  return { ...selection, endpoint: { mode: "default" } };
}

export function openRouterStoreOutcome(result: CredentialWriteResult): OpenRouterStoreOutcome {
  if (result.status !== "configured") return "not-saved";
  return result.runtimeReady ? "connected" : "saved-not-active";
}

function minimizeResult(result: OpenRouterSignInResult): OpenRouterSignInResult {
  if (result.status === "connected") {
    return { status: "connected", operationId: result.operationId, credit: result.credit };
  }
  if (result.status === "awaiting-code") {
    return { status: "awaiting-code", operationId: result.operationId };
  }
  return { status: "refused", operationId: result.operationId, reason: result.reason };
}

function minimizeCredit(value: OpenRouterCreditStatus): OpenRouterCreditStatus {
  return CREDIT_STATUSES.has(value) ? value : "unknown";
}

export function installDesktopOpenRouterIpc(input: {
  readonly ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  readonly isTrusted: (event: IpcMainInvokeEvent) => boolean;
  readonly auth: OpenRouterAuthController;
  readonly prepareStore: (selection: OnboardingLlmSelection) => OpenRouterKeyStore | null;
}): () => void {
  let disposed = false;
  const requireTrusted = (event: IpcMainInvokeEvent): void => {
    if (disposed || !input.isTrusted(event)) throw new TypeError();
  };
  const progress =
    (sender: IpcMainInvokeEvent["sender"], operationId: string) =>
    (phase: OpenRouterSignInPhase): void => {
      try {
        if (disposed || sender.isDestroyed() || !isDesktopRendererUrl(sender.mainFrame.url)) {
          return;
        }
        sender.send(DESKTOP_OPENROUTER_SIGN_IN_PROGRESS_CHANNEL, { operationId, phase });
      } catch {
        return;
      }
    };
  const startInput = (
    args: readonly unknown[],
  ): { readonly operationId: string; readonly store: OpenRouterKeyStore | null } => {
    const value = single(args, ["operationId", "selection"]);
    const operationId = operationIdOf(value);
    return {
      operationId,
      store: input.prepareStore(parseOpenRouterSignInSelection(value.selection)),
    };
  };
  const handlers = [
    [
      DESKTOP_OPENROUTER_SIGN_IN_CHANNEL,
      async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        requireTrusted(event);
        const { operationId, store } = startInput(args);
        if (store === null) return { status: "refused", operationId, reason: "invalid-input" };
        return minimizeResult(
          await input.auth.signIn(operationId, store, progress(event.sender, operationId)),
        );
      },
    ],
    [
      DESKTOP_OPENROUTER_CODE_SIGN_IN_CHANNEL,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        requireTrusted(event);
        const { operationId, store } = startInput(args);
        if (store === null) return { status: "refused", operationId, reason: "invalid-input" };
        return minimizeResult(input.auth.startCodeSignIn(operationId, store));
      },
    ],
    [
      DESKTOP_OPENROUTER_USE_COPIED_CODE_CHANNEL,
      async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        requireTrusted(event);
        const operationId = operationIdOf(single(args, ["operationId"]));
        return minimizeResult(
          await input.auth.useCopiedCode(operationId, progress(event.sender, operationId)),
        );
      },
    ],
    [
      DESKTOP_OPENROUTER_SIGN_IN_CANCEL_CHANNEL,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        requireTrusted(event);
        return input.auth.cancel(operationIdOf(single(args, ["operationId"])));
      },
    ],
    [
      DESKTOP_OPENROUTER_SIGN_IN_REOPEN_CHANNEL,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        requireTrusted(event);
        return input.auth.reopen(operationIdOf(single(args, ["operationId"])));
      },
    ],
    [
      DESKTOP_OPENROUTER_CREDIT_STATUS_CHANNEL,
      async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        requireTrusted(event);
        if (args.length !== 0) throw new TypeError();
        return minimizeCredit(await input.auth.readCreditStatus());
      },
    ],
    [
      DESKTOP_OPENROUTER_OPEN_PAGE_CHANNEL,
      (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        requireTrusted(event);
        const page = single(args, ["page"]).page;
        if (typeof page !== "string" || !PAGES.has(page)) throw new TypeError();
        return input.auth.openPage(page as OpenRouterPage);
      },
    ],
  ] as const;
  for (const [channel, handler] of handlers) input.ipcMain.handle(channel, handler);
  return () => {
    if (disposed) return;
    disposed = true;
    for (const [channel] of handlers) input.ipcMain.removeHandler(channel);
    input.auth.dispose();
  };
}
