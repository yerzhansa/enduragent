import { cliPhrasebook, say } from "../cli-copy.js";
import { msg, type CoachLanguage } from "@enduragent/i18n";
import type { BinaryConfig } from "../binary.js";
import type { ConfirmationGate } from "../agent/confirmation-gate.js";
import { buildWhatsNewMessage } from "../release-notes.js";
import type { ReferenceServices } from "../reference/services.js";
import { resolveRunningCs } from "@enduragent/kernel/reference/cs-resolution";
import { formatSyncReply } from "../reference/sync/format-sync-reply.js";
import { formatSnapshotRaw } from "../reference/sync/snapshot-debug.js";
import { provenanceForLatestSection } from "../reference/source-provenance.js";
import {
  checkForUpdate,
  checkForUpdateWithDailyTelemetry,
  getCurrentVersion,
  getKnownTelegramChatIds,
  getLastNotifiedVersion,
  isManagedDeploy,
  MANAGED_DEPLOY_UPDATE_NOTICE,
  selfUpdate,
  setLastNotifiedVersion,
} from "../updater.js";
import { loadAllowedSenders, loadAllowedSendersWithSource } from "./allowed-senders.js";
import { createAuthMiddleware } from "./telegram-access.js";
import type { TelegramHostCapabilities } from "./telegram-host.js";

export interface CreateNpmTelegramHostInput {
  readonly language: CoachLanguage;
  readonly binary: BinaryConfig;
  readonly confirmations: Pick<ConfirmationGate, "peek" | "confirm" | "cancel">;
  readonly dataDir: string;
  readonly reference?: Pick<ReferenceServices, "loadLatest" | "runSync">;
}

function logSecurityStartup(dataDir: string, binaryName: string): void {
  const { state, source } = loadAllowedSendersWithSource(dataDir);
  const primary = state.primaryOperator ?? say("telegram.security.none");
  if (state.dmPolicy === "open") {
    console.error(
      say("telegram.security.open", {
        service: "Telegram",
        variable: "CYCLING_COACH_DM_POLICY",
        count: state.allowFrom.length,
        formattedCount: cliPhrasebook().format.number(state.allowFrom.length, {
          useGrouping: false,
        }),
        primary,
        source,
      }),
    );
    return;
  }
  console.error(
    say("telegram.security.allowlist", {
      service: "Telegram",
      policy: state.dmPolicy,
      count: state.allowFrom.length,
      formattedCount: cliPhrasebook().format.number(state.allowFrom.length, { useGrouping: false }),
      primary,
      source,
    }),
  );
  if (state.dmPolicy === "pairing" && state.allowFrom.length === 0) {
    console.error(say("telegram.security.noSenders", { command: `${binaryName} add-sender <id>` }));
  }
}

export function createNpmTelegramHost(input: CreateNpmTelegramHostInput): TelegramHostCapabilities {
  logSecurityStartup(input.dataDir, input.binary.binaryName);
  const releaseBase = {
    updateDescription: msg("telegram.menu.update"),
    whatsNewUnavailableText: msg("telegram.release.unavailable", { service: "npm" }),
    version: async () =>
      `${input.binary.displayName} v${getCurrentVersion(input.binary.binaryName)}`,
    whatsNew: async (phrasebook?: import("@enduragent/i18n/messages").Phrasebook) => {
      const info = await checkForUpdate(input.binary.binaryName);
      return info === null
        ? ({ kind: "unavailable" } as const)
        : ({
            kind: "available",
            text: await buildWhatsNewMessage(input.binary.binaryName, info, phrasebook),
          } as const);
    },
  };
  const release = isManagedDeploy(input.binary.binaryName)
    ? {
        ...releaseBase,
        updatePolicy: "managed-deploy" as const,
        updateNotice: async () => MANAGED_DEPLOY_UPDATE_NOTICE,
      }
    : {
        ...releaseBase,
        updatePolicy: "npm-self-update" as const,
        binaryName: input.binary.binaryName,
        check: () => checkForUpdate(input.binary.binaryName),
        install: async (version: string) => selfUpdate(input.binary.binaryName, version),
      };
  const reference = input.reference;

  return {
    language: input.language,
    access: {
      middleware: createAuthMiddleware({
        dataDir: input.dataDir,
        language: input.language,
        binaryName: input.binary.binaryName,
        challengeRateLimit: new Map(),
        challengeMinIntervalMs: 60_000,
      }),
    },
    confirmations: {
      peek: async ({ chatId, phrasebook }) => input.confirmations.peek(chatId, phrasebook),
      confirm: ({ chatId, nonce, phrasebook }) =>
        input.confirmations.confirm(chatId, nonce, phrasebook),
      cancel: async ({ chatId, nonce }) => input.confirmations.cancel(chatId, nonce),
    },
    ...(reference === undefined
      ? {}
      : {
          operations: {
            resolveTurnContext: async () => {
              const latest = reference.loadLatest();
              return {
                resolvedCs: resolveRunningCs(latest),
                referenceProvenance:
                  latest === null
                    ? undefined
                    : provenanceForLatestSection(latest, "athlete_profile"),
              };
            },
            sync: async ({ chatId, phrasebook }) => ({
              text: formatSyncReply(await reference.runSync({ chatId }), undefined, phrasebook),
            }),
          },
          diagnostics: {
            rawSnapshot: async ({ section, phrasebook }) =>
              formatSnapshotRaw(reference.loadLatest(), section, phrasebook),
          },
        }),
    authorization: {
      isPrimaryOperator: async ({ senderId }) =>
        loadAllowedSenders(input.dataDir).primaryOperator === senderId,
    },
    release,
  };
}

export interface TelegramUpdateMessageSender {
  sendMessage(chatId: string, text: string): Promise<unknown>;
}

export async function notifyNpmTelegramUpdate(
  sender: TelegramUpdateMessageSender,
  dataDir: string,
  binary: BinaryConfig,
  language: CoachLanguage,
): Promise<void> {
  try {
    const info = await checkForUpdateWithDailyTelemetry(binary.binaryName, dataDir);
    if (!info?.updateAvailable || getLastNotifiedVersion(dataDir) === info.latest) return;

    const allowed = loadAllowedSenders(dataDir);
    const allowSet = new Set(allowed.allowFrom);
    const knownChats = getKnownTelegramChatIds(dataDir);
    const chatIds =
      allowed.dmPolicy === "open" ? knownChats : knownChats.filter((id) => allowSet.has(id));
    let delivered = false;
    for (const chatId of chatIds) {
      try {
        const book = await language.phrasebookFor({ chatId: `telegram:${chatId}` });
        const updateInstruction = isManagedDeploy(binary.binaryName)
          ? book.say(
              msg("telegram.update.managedInstruction", {
                whatsnew: "/whatsnew",
                notice: book.say(MANAGED_DEPLOY_UPDATE_NOTICE),
              }),
            )
          : book.say(
              msg("telegram.update.instruction", { whatsnew: "/whatsnew", update: "/update" }),
            );
        const message = book.say(
          msg("telegram.update.available", {
            current: info.current,
            latest: info.latest,
            updateInstruction,
            availability: `${book.format.number(24)}/${book.format.number(7)}`,
            desktopUrl: "https://enduragent.icu",
            railwayUrl: "https://railway.com/deploy/cycling-coach",
            platform: "macOS",
            provider: "Railway",
          }),
        );
        await sender.sendMessage(chatId, message);
        delivered = true;
      } catch {}
    }
    if (delivered) setLastNotifiedVersion(dataDir, info.latest);
  } catch {}
}
