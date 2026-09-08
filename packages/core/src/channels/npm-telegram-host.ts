import type { CoachLanguage } from "@enduragent/i18n";
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
  const primary = state.primaryOperator ?? "none";
  if (state.dmPolicy === "open") {
    console.error(
      "[security] WARNING: DM policy is OPEN — this bot will answer ANY Telegram user who finds it.\n" +
        "[security] WARNING: Unset CYCLING_COACH_DM_POLICY to restore allowlist/pairing.\n" +
        `[security] Allowlist on record: ${state.allowFrom.length} senders (primary: ${primary}). Source: ${source}.`,
    );
    return;
  }
  console.error(
    `[security] Telegram allowlist: ${state.dmPolicy} mode (${state.allowFrom.length} allowed senders, primary: ${primary}). Source: ${source}.`,
  );
  if (state.dmPolicy === "pairing" && state.allowFrom.length === 0) {
    console.error(
      `[security] No allowed senders configured. DM the bot to receive your user-ID, then run \`${binaryName} add-sender <id>\` to authorize yourself.`,
    );
  }
}

export function createNpmTelegramHost(input: CreateNpmTelegramHostInput): TelegramHostCapabilities {
  logSecurityStartup(input.dataDir, input.binary.binaryName);
  const releaseBase = {
    updateDescription: "Check for and install updates",
    whatsNewUnavailableText: "Couldn't reach npm to check the latest version. Try again later.",
    version: async () =>
      `${input.binary.displayName} v${getCurrentVersion(input.binary.binaryName)}`,
    whatsNew: async () => {
      const info = await checkForUpdate(input.binary.binaryName);
      return info === null
        ? ({ kind: "unavailable" } as const)
        : ({
            kind: "available",
            text: await buildWhatsNewMessage(input.binary.binaryName, info),
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
        binaryName: input.binary.binaryName,
        challengeRateLimit: new Map(),
        challengeMinIntervalMs: 60_000,
      }),
    },
    confirmations: {
      peek: async ({ chatId }) => input.confirmations.peek(chatId),
      confirm: ({ chatId, nonce }) => input.confirmations.confirm(chatId, nonce),
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
            sync: async ({ chatId }) => ({
              text: formatSyncReply(await reference.runSync({ chatId })),
            }),
          },
          diagnostics: {
            rawSnapshot: async ({ section }) => formatSnapshotRaw(reference.loadLatest(), section),
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
): Promise<void> {
  try {
    const info = await checkForUpdateWithDailyTelemetry(binary.binaryName, dataDir);
    if (!info?.updateAvailable || getLastNotifiedVersion(dataDir) === info.latest) return;

    const allowed = loadAllowedSenders(dataDir);
    const allowSet = new Set(allowed.allowFrom);
    const knownChats = getKnownTelegramChatIds(dataDir);
    const chatIds =
      allowed.dmPolicy === "open" ? knownChats : knownChats.filter((id) => allowSet.has(id));
    const updateInstruction = isManagedDeploy(binary.binaryName)
      ? `Send /whatsnew to see what changed. ${MANAGED_DEPLOY_UPDATE_NOTICE}`
      : "Send /whatsnew to see what changed, /update to install.";
    const message = `Update available: ${info.current} → ${info.latest}\n${updateInstruction}\n\nDesktop app for macOS is available: https://enduragent.icu\n\nWant the bot running 24/7 without keeping your computer on? Deploy the Railway template: https://railway.com/deploy/cycling-coach`;

    let delivered = false;
    for (const chatId of chatIds) {
      try {
        await sender.sendMessage(chatId, message);
        delivered = true;
      } catch {}
    }
    if (delivered) setLastNotifiedVersion(dataDir, info.latest);
  } catch {}
}
