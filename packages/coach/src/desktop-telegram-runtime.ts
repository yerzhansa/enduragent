import {
  createAuthMiddleware,
  createTelegramBot,
  escapeHtmlText,
  loadAllowedSendersFromFile,
  type TelegramHostCapabilities,
} from "@enduragent/core";
import { msg } from "@enduragent/i18n";
import type { Phrasebook } from "@enduragent/i18n/messages";
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

function syncReply(
  result: Awaited<ReturnType<LocalCoachLifecycle["operations"]["sync"]>>,
  phrasebook: Phrasebook,
): string {
  if (!result.referenceSucceeded) {
    return phrasebook.say(msg("telegram.sync.desktopReferenceFailed", { command: "/sync" }));
  }
  return result.published
    ? phrasebook.say(msg("telegram.sync.desktopComplete"))
    : phrasebook.say(msg("telegram.sync.desktopUnchanged"));
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
    language: input.lifecycle.language,
    binaryName: "cycling-coach-desktop",
    challengeRateLimit: new Map(),
    challengeMinIntervalMs: 60_000,
    loadAllowedSenders,
    pairingChallenge: ({ senderId, phrasebook }) =>
      `<b>${escapeHtmlText(phrasebook.say(msg("telegram.pairing.private")))}</b>\n\n${escapeHtmlText(phrasebook.say(msg("telegram.pairing.desktopIdentity", { service: "Telegram" })))} <code>${escapeHtmlText(senderId)}</code>. ${escapeHtmlText(phrasebook.say(msg("telegram.pairing.desktopApproval", { product: "Cycling Coach Desktop" })))}`,
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
      peek: async ({ chatId, phrasebook }) =>
        input.lifecycle.confirmations.peek(chatId, phrasebook),
      confirm: ({ chatId, nonce, phrasebook }) =>
        input.lifecycle.confirmations.confirm(chatId, nonce, phrasebook),
      cancel: async ({ chatId, nonce }) => input.lifecycle.confirmations.cancel(chatId, nonce),
    },
    invocations: {
      reserve: (chatId) => input.invocations.reserve({ key: chatId }),
    },
    operations: {
      resolveTurnContext: async () => undefined,
      sync: async ({ chatId, phrasebook }) => ({
        text: syncReply(
          await input.lifecycle.operations.sync({}),
          phrasebook ?? (await input.lifecycle.language.phrasebookFor({ chatId })),
        ),
      }),
    },
    authorization: {
      isPrimaryOperator: async ({ senderId }) =>
        loadAllowedSenders(dataDir).primaryOperator === senderId,
    },
    release: {
      updatePolicy: "desktop-owned",
      updateDescription: msg("telegram.release.desktopUpdateDescription"),
      whatsNewUnavailableText: msg("telegram.release.desktopReleaseNotes"),
      version: async () => `Cycling Coach Desktop v${input.appVersion}`,
      whatsNew: async () => ({ kind: "unavailable" }),
      updateNotice: async () => msg("telegram.release.desktopUpdateNotice"),
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
