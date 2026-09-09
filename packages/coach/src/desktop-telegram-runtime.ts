import {
  createAuthMiddleware,
  createTelegramBot,
  loadAllowedSendersFromFile,
  type TelegramHostCapabilities,
} from "@enduragent/core";
import type { LocalCoachLifecycle } from "./local-runner.js";
import { withTrustedTurnLanguage } from "./coach-engine-adapter.js";
import type { InvocationCoordinator } from "./daemon/invocation-coordinator.js";
import type {
  DesktopTelegramRuntime,
  DesktopTelegramRuntimeFactoryInput,
} from "./desktop-telegram-controller.js";

export interface CreateDesktopTelegramRuntimeFactoryInput {
  readonly lifecycle: Pick<
    LocalCoachLifecycle,
    "home" | "engine" | "operations" | "confirmations" | "language"
  >;
  readonly invocations: InvocationCoordinator;
  readonly appVersion: string;
}

export interface DesktopTelegramRuntimeDependencies {
  readonly createBot?: typeof createTelegramBot;
  readonly createAccessMiddleware?: typeof createAuthMiddleware;
  readonly loadAllowedSenders?: typeof loadAllowedSendersFromFile;
}

function syncReply(result: Awaited<ReturnType<LocalCoachLifecycle["operations"]["sync"]>>): string {
  if (!result.referenceSucceeded) {
    return "Training data synced, but coaching data could not refresh. Try /sync again.";
  }
  return result.published
    ? "Sync complete — your training data is up to date."
    : "Already up to date — no new training data was found.";
}

function createDesktopTelegramHost(
  input: CreateDesktopTelegramRuntimeFactoryInput,
  dependencies: DesktopTelegramRuntimeDependencies,
  admitted: DesktopTelegramRuntimeFactoryInput["admitted"],
  consumePairing: DesktopTelegramRuntimeFactoryInput["consumePairing"],
): TelegramHostCapabilities {
  const dataDir = input.lifecycle.home.root;
  const canAdmit = (): boolean => admitted() && input.invocations.canAdmit();
  const loadAllowedSenders = dependencies.loadAllowedSenders ?? loadAllowedSendersFromFile;
  const accessMiddleware = (dependencies.createAccessMiddleware ?? createAuthMiddleware)({
    dataDir,
    binaryName: "cycling-coach-desktop",
    challengeRateLimit: new Map(),
    challengeMinIntervalMs: 60_000,
    loadAllowedSenders,
    pairingChallenge: ({ senderId }) =>
      `<b>This bot is private.</b>\n\nYour Telegram user ID is <code>${senderId}</code>. Open Cycling Coach Desktop → Settings → Telegram to approve it.`,
    consumePairing,
  });
  return {
    language: input.lifecycle.language,
    access: {
      middleware: async (context, next) => {
        if (canAdmit()) {
          await accessMiddleware(context, async () => {
            // `next()` reaches offset dedupe and reservation without yielding, so this check fences both.
            if (canAdmit()) await next();
          });
        }
      },
    },
    confirmations: {
      peek: async ({ chatId }) => input.lifecycle.confirmations.peek(chatId),
      confirm: ({ chatId, nonce }) => input.lifecycle.confirmations.confirm(chatId, nonce),
      cancel: async ({ chatId, nonce }) => input.lifecycle.confirmations.cancel(chatId, nonce),
    },
    invocations: {
      reserve: (chatId) => input.invocations.reserve({ key: chatId }),
    },
    operations: {
      resolveTurnContext: async () => undefined,
      sync: async () => ({ text: syncReply(await input.lifecycle.operations.sync({})) }),
    },
    authorization: {
      isPrimaryOperator: async ({ senderId }) =>
        loadAllowedSenders(dataDir).primaryOperator === senderId,
    },
    release: {
      updatePolicy: "desktop-owned",
      updateDescription: "Check for updates in the Desktop app",
      whatsNewUnavailableText: "Open the Desktop app to see release notes.",
      version: async () => `Cycling Coach Desktop v${input.appVersion}`,
      whatsNew: async () => ({ kind: "unavailable" }),
      updateNotice: async () => "Updates are installed from the Desktop app.",
    },
  };
}

export function createDesktopTelegramRuntimeFactory(
  input: CreateDesktopTelegramRuntimeFactoryInput,
  dependencies: DesktopTelegramRuntimeDependencies = {},
): (runtime: DesktopTelegramRuntimeFactoryInput) => DesktopTelegramRuntime {
  return ({ token, admitted, onStarted, onPollingSuccess, onPollingFailure, consumePairing }) => {
    const host = createDesktopTelegramHost(input, dependencies, admitted, consumePairing);
    return (dependencies.createBot ?? createTelegramBot)({
      webhookPolicy: "preserve",
      token,
      engine: withTrustedTurnLanguage(input.lifecycle.engine),
      host,
      dataDir: input.lifecycle.home.root,
      onStart: onStarted,
      onPollingSuccess,
      onPollingFailure,
    });
  };
}
