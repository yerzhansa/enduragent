import { PLATFORM_COPY } from "../../platform-copy";
import { msg, type Message } from "@enduragent/i18n";
import type {
  AthleteSettingsSaveError,
  AthleteSettingsValidationError,
} from "../../settings/athlete-controller";
import type { CredentialSettingsEntry } from "../../settings/credential-controller";
import type { ProviderModelValidationError } from "../../settings/provider-model-controller";
import type { SessionSettingField } from "../../settings/session-controller";

export const COACH_VALIDATION_COPY: Readonly<Record<ProviderModelValidationError, Message>> = {
  "model-required": msg("settings.coach.validation.modelRequired"),
  "model-too-long": msg("settings.coach.validation.modelTooLong"),
  "model-control-characters": msg("settings.coach.validation.modelControlCharacters"),
};

export const COACH_SAVE_ERROR_COPY = {
  "invalid-input": msg("settings.coach.error.invalidInput"),
  "credential-required": msg("settings.coach.error.credentialRequired"),
  "runtime-unavailable": msg("settings.coach.error.runtimeUnavailable"),
  "request-failed": msg("settings.coach.error.requestFailed"),
} as const;

export const ATHLETE_VALIDATION_COPY: Readonly<Record<AthleteSettingsValidationError, Message>> = {
  "athlete-required": msg("settings.athlete.validation.athleteRequired"),
  "athlete-whitespace": msg("settings.athlete.validation.athleteWhitespace"),
  "athlete-too-long": msg("settings.athlete.validation.athleteTooLong"),
  "athlete-control-characters": msg("settings.athlete.validation.athleteControlCharacters"),
};

export const ATHLETE_SAVE_ERROR_COPY: Readonly<Record<AthleteSettingsSaveError, Message>> = {
  "credential-required": msg("settings.athlete.error.credentialRequired"),
  "ownership-unavailable": msg("settings.athlete.error.ownershipUnavailable"),
  "training-account-mismatch": msg("settings.athlete.error.trainingAccountMismatch"),
  "managed-by-environment": msg("settings.athlete.error.managedByEnvironment", {
    product: "Enduragent",
  }),
  "request-failed": msg("settings.athlete.error.requestFailed"),
  "not-applied": msg("settings.athlete.error.notApplied"),
  "runtime-unavailable": msg("settings.athlete.error.runtimeUnavailable"),
};

export const MANAGED_BY_ENVIRONMENT_COPY = msg("settings.managedByEnvironment", {
  product: "Enduragent",
});

export interface ConversationFieldDefinition {
  readonly field: SessionSettingField;
  readonly label: Message;
  readonly help: Message;
  readonly type: "text" | "number";
  readonly min?: string;
  readonly max?: string;
  readonly step?: string;
  readonly suffix?: Message | "%";
}

export const CONVERSATION_FIELDS: readonly ConversationFieldDefinition[] = [
  {
    field: "timezone",
    label: msg("settings.conversation.fields.timezone.label"),
    help: msg("settings.conversation.fields.timezone.help", {
      product: "Enduragent",
      timezone: "Europe/London",
    }),
    type: "text",
  },
  {
    field: "dailyResetHour",
    label: msg("settings.conversation.fields.dailyResetHour.label"),
    help: msg("settings.conversation.fields.dailyResetHour.help"),
    type: "number",
    min: "0",
    max: "23",
    step: "1",
  },
  {
    field: "idleMinutes",
    label: msg("settings.conversation.fields.idleMinutes.label"),
    help: msg("settings.conversation.fields.idleMinutes.help"),
    type: "number",
    min: "0",
    step: "1",
    suffix: msg("settings.conversation.fields.idleMinutes.suffix"),
  },
  {
    field: "resetArchiveRetentionDays",
    label: msg("settings.conversation.fields.resetArchiveRetentionDays.label"),
    help: msg("settings.conversation.fields.resetArchiveRetentionDays.help"),
    type: "number",
    min: "0",
    step: "1",
    suffix: msg("settings.conversation.fields.resetArchiveRetentionDays.suffix"),
  },
  {
    field: "historyTokenBudgetRatio",
    label: msg("settings.conversation.fields.historyTokenBudgetRatio.label"),
    help: msg("settings.conversation.fields.historyTokenBudgetRatio.help"),
    type: "number",
    min: "0",
    max: "100",
    step: "any",
    suffix: "%",
  },
] as const;

export function conversationSaveErrorCopy(
  reason: "request-failed" | "not-applied" | "runtime-unavailable",
): Message {
  if (reason === "not-applied") {
    return msg("settings.conversation.error.notApplied");
  }
  if (reason === "runtime-unavailable") {
    return msg("settings.conversation.error.runtimeUnavailable");
  }
  return msg("settings.conversation.error.requestFailed");
}

export function credentialRuntimeLabel(state: CredentialSettingsEntry["runtimeState"]): Message {
  if (state === "active") return msg("settings.credentials.runtime.active");
  if (state === "verifying") return msg("settings.credentials.runtime.verifying");
  if (state === "stored-inactive") return msg("settings.credentials.runtime.storedInactive");
  return msg("settings.credentials.runtime.failed");
}

export function telegramFeedbackMessage(
  value: string,
  recoveryAction = PLATFORM_COPY.credentialRecoveryAction,
): Message | null {
  const connected = /^Telegram connected to @(.+)\. Pairing needs to be set up\.$/u.exec(value);
  if (connected !== null)
    return msg("settings.telegram.feedback.pairing.connected", {
      telegram: "Telegram",
      username: connected[1] ?? "",
    });
  switch (value) {
    case "Reading and verifying the Telegram token…":
      return msg("settings.telegram.feedback.working.pasteToken", { telegram: "Telegram" });
    case "Turning Telegram off…":
      return msg("settings.telegram.feedback.working.disable", { telegram: "Telegram" });
    case "Deleting the Telegram connection…":
      return msg("settings.telegram.feedback.working.remove", { telegram: "Telegram" });
    case "Removing the bot’s webhook…":
      return msg("settings.telegram.feedback.working.removeWebhook");
    case "Creating a private pairing code…":
      return msg("settings.telegram.feedback.working.beginPairing");
    case "Clearing the Telegram delivery warning…":
      return msg("settings.telegram.feedback.working.acknowledgeGap", { telegram: "Telegram" });
    case "Adding a Telegram user…":
      return msg("settings.telegram.feedback.working.addSender", { telegram: "Telegram" });
    case "Removing the Telegram user…":
      return msg("settings.telegram.feedback.working.removeSender", { telegram: "Telegram" });
    case "Checking the Telegram connection…":
      return msg("settings.telegram.feedback.working.reconcile", { telegram: "Telegram" });
    case "The bot token could not be verified or saved. Copy a fresh token from BotFather and try again.":
      return msg("settings.telegram.feedback.failure.pasteToken", { botFather: "BotFather" });
    case "The webhook could not be removed. Check the internet connection and try again.":
      return msg("settings.telegram.feedback.failure.webhook");
    case "Pairing could not start. Check the bot connection and try again.":
      return msg("settings.telegram.feedback.failure.pairing");
    case "The allowed-user list could not be changed. Check the user ID and try again.":
      return msg("settings.telegram.feedback.failure.senders");
    case "Telegram settings could not be changed. Try again.":
      return msg("settings.telegram.feedback.failure.change", { telegram: "Telegram" });
    case "The primary Telegram user may have been saved, but Enduragent could not verify storage. Restart Enduragent and check Telegram before pairing again.":
      return msg("settings.telegram.feedback.failure.pairingUncertain", {
        product: "Enduragent",
        telegram: "Telegram",
      });
    case "The Telegram connection may have started, but Enduragent could not confirm whether it finished. Restart Enduragent and check Telegram before trying again.":
      return msg("settings.telegram.feedback.failure.connectUncertain", {
        product: "Enduragent",
        telegram: "Telegram",
      });
    case "Telegram connection deletion may not have completed. Restart Enduragent and check whether the bot is still connected before trying again.":
      return msg("settings.telegram.feedback.failure.removeUncertain", {
        product: "Enduragent",
        telegram: "Telegram",
      });
    case "The Telegram change may have started, but Enduragent could not confirm whether it finished. Restart Enduragent and check this setting before trying again.":
      return msg("settings.telegram.feedback.failure.changeUncertain", {
        product: "Enduragent",
        telegram: "Telegram",
      });
    case "The copied token was not applied because secure storage could not be verified. The current Telegram bot is unchanged. Restart Enduragent and check Telegram before trying again.":
      return msg("settings.telegram.feedback.failure.tokenStorageUnverified", {
        product: "Enduragent",
        telegram: "Telegram",
      });
    case "Telegram connection deletion could not be confirmed because secure storage could not be verified. Restart Enduragent and check Telegram before trying again.":
      return msg("settings.telegram.feedback.failure.removeStorageUnverified", {
        product: "Enduragent",
        telegram: "Telegram",
      });
    case "The change was not applied because storage could not be verified. Restart Enduragent and check this setting before trying again.":
      return msg("settings.telegram.feedback.failure.changeStorageUnverified", {
        product: "Enduragent",
      });
    case "No secure credential backend is available, so Enduragent refused to access the saved bot token without encryption. Quit and reopen Enduragent, then choose Check again.":
      return msg("settings.telegram.feedback.failure.unsafeAccess", { product: "Enduragent" });
    case "The current Telegram bot is unchanged because no secure credential backend is available. Enduragent refused to save the copied token without encryption. Quit and reopen Enduragent, copy the bot token again, then retry.":
      return msg("settings.telegram.feedback.failure.unsafeTokenUnchanged", {
        product: "Enduragent",
        telegram: "Telegram",
      });
    case "No secure credential backend is available, so Enduragent refused to save the bot token without encryption. Quit and reopen Enduragent, copy the bot token again, then retry.":
      return msg("settings.telegram.feedback.failure.unsafeToken", { product: "Enduragent" });
    case "The clipboard could not be read. No Telegram token was used.":
      return msg("settings.telegram.feedback.failure.clipboardUnavailable", {
        telegram: "Telegram",
      });
    case "The clipboard could not be cleared, so the copied token was not used. The current Telegram bot is unchanged.":
      return msg("settings.telegram.feedback.failure.clipboardClearFailed", {
        telegram: "Telegram",
      });
    case "The clipboard does not contain a valid Telegram bot token. The current Telegram bot is unchanged.":
      return msg("settings.telegram.feedback.failure.invalidTokenFormat", { telegram: "Telegram" });
    case "Telegram rejected the copied token. The current Telegram bot is unchanged.":
      return msg("settings.telegram.feedback.failure.invalidToken", { telegram: "Telegram" });
    case "Telegram could not verify the copied token right now. The current Telegram bot is unchanged.":
      return msg("settings.telegram.feedback.failure.validationUnavailable", {
        telegram: "Telegram",
      });
    case "The copied bot still uses a webhook. Remove the webhook, then delete the current connection and connect this bot.":
      return msg("settings.telegram.feedback.failure.webhookRemovalRequired");
    case "The copied token could not be stored. The current Telegram bot is unchanged.":
      return msg("settings.telegram.feedback.failure.storageFailed", { telegram: "Telegram" });
    case "The copied token was not applied. The current Telegram bot is unchanged.":
      return msg("settings.telegram.feedback.failure.tokenNotApplied", { telegram: "Telegram" });
    case "Telegram is connecting.":
      return msg("settings.telegram.feedback.health.connecting", { telegram: "Telegram" });
    case "Copy a bot token from BotFather, then paste it from the clipboard.":
      return msg("settings.telegram.feedback.health.waitingForToken", { botFather: "BotFather" });
    case "Telegram rejected this token. Delete the connection, then connect a new bot with a fresh token from BotFather.":
      return msg("settings.telegram.feedback.health.invalidToken", {
        botFather: "BotFather",
        telegram: "Telegram",
      });
    case "Another service is polling this bot. Stop that deployment, then check again.":
      return msg("settings.telegram.feedback.health.conflict");
    case "This bot is still owned by another Desktop installation. Delete the connection there before connecting it here.":
      return msg("settings.telegram.feedback.health.transferRequired");
    case "Telegram needs attention. Keep the app open, check the connection, and try again.":
      return msg("settings.telegram.feedback.health.failed", { telegram: "Telegram" });
    case "Telegram reconnected after a long gap. Some messages may not have arrived.":
      return msg("settings.telegram.feedback.health.gap", { telegram: "Telegram" });
    case "Pairing code ready. Send it to the bot in Telegram.":
      return msg("settings.telegram.feedback.pairing.ready", { telegram: "Telegram" });
    case "Telegram is paired with its primary user.":
      return msg("settings.telegram.feedback.pairing.paired", { telegram: "Telegram" });
    case "The primary Telegram user could not be saved. Check local disk access and try pairing again.":
      return msg("settings.telegram.feedback.pairing.storageFailed", { telegram: "Telegram" });
    case "Pairing was refused because this bot already has a primary user.":
      return msg("settings.telegram.feedback.pairing.refused");
    case "Pairing is unavailable until the Telegram bot can connect.":
      return msg("settings.telegram.feedback.pairing.unavailable", { telegram: "Telegram" });
    case "A new Telegram pairing code is ready. Send it to the bot in Telegram.":
      return msg("settings.telegram.feedback.pairing.replaced", { telegram: "Telegram" });
    case "The pairing code expired before it was used. Create a new code when you are ready.":
      return msg("settings.telegram.feedback.pairing.expired");
    case "Telegram pairing was cancelled.":
      return msg("settings.telegram.feedback.pairing.cancelled", { telegram: "Telegram" });
    case "Telegram settings aren’t available. Keep the app open and try again.":
      return msg("settings.telegram.feedback.unavailable", { telegram: "Telegram" });
    case "The allowed-user list may have changed, but Enduragent could not verify storage. Restart Enduragent and check the list before trying again.":
      return msg("settings.telegram.feedback.sender.storageUncertain", { product: "Enduragent" });
    case "The allowed-user list may have changed, but Enduragent lost confirmation from the local coaching service. Restart Enduragent and check the list before trying again.":
      return msg("settings.telegram.feedback.sender.daemonUncertain", { product: "Enduragent" });
    case "Telegram user removed.":
      return msg("settings.telegram.feedback.sender.removed", { telegram: "Telegram" });
    case "Turning Telegram on…":
      return msg("settings.telegram.feedback.working.enable", { telegram: "Telegram" });
    case "Cancelling pairing…":
      return msg("settings.telegram.feedback.working.cancelPairing");
    case "Telegram is online.":
      return msg("settings.telegram.feedback.health.online", { telegram: "Telegram" });
    case "Telegram is off.":
      return msg("settings.telegram.feedback.health.off", { telegram: "Telegram" });
    case "Telegram user added.":
      return msg("settings.telegram.feedback.sender.added", { telegram: "Telegram" });
    case `Secure token storage is unavailable. Quit and reopen Enduragent, ${PLATFORM_COPY.credentialRecoveryAction}, then choose Check again.`:
      return msg("settings.telegram.feedback.platform.encryptionAccess", {
        product: "Enduragent",
        recoveryAction,
      });
    case `The current Telegram bot is unchanged because secure token storage is unavailable. Quit and reopen Enduragent, ${PLATFORM_COPY.credentialRecoveryAction}, copy the bot token again, then retry.`:
      return msg("settings.telegram.feedback.platform.encryptionUnchanged", {
        product: "Enduragent",
        telegram: "Telegram",
        recoveryAction,
      });
    case `Secure token storage is unavailable. Quit and reopen Enduragent, ${PLATFORM_COPY.credentialRecoveryAction}, copy the bot token again, then retry.`:
      return msg("settings.telegram.feedback.platform.encryptionSave", {
        product: "Enduragent",
        recoveryAction,
      });
    case `The copied bot still uses a webhook. Remove the webhook before pairing it with ${PLATFORM_COPY.computer}.`:
      return msg("settings.telegram.feedback.platform.webhookConnect", {
        computer: PLATFORM_COPY.computer,
      });
    case `Telegram polling is paused while ${PLATFORM_COPY.computer} sleeps.`:
      return msg("settings.telegram.feedback.platform.suspended", {
        telegram: "Telegram",
        computer: PLATFORM_COPY.computer,
      });
    case `Telegram is offline. Enduragent will keep trying while ${PLATFORM_COPY.computer} is awake and online.`:
      return msg("settings.telegram.feedback.platform.offline", {
        product: "Enduragent",
        telegram: "Telegram",
        computer: PLATFORM_COPY.computer,
      });
    case `Bot verified. Remove its webhook before pairing it with ${PLATFORM_COPY.computer}.`:
      return msg("settings.telegram.feedback.platform.webhookVerified", {
        computer: PLATFORM_COPY.computer,
      });
    case `Telegram connection deleted from ${PLATFORM_COPY.computer}.`:
      return msg("settings.telegram.feedback.platform.removed", {
        telegram: "Telegram",
        computer: PLATFORM_COPY.computer,
      });
    default:
      return null;
  }
}

export function credentialFeedbackMessage(value: string): Message | null {
  const confirmation = /^Confirm deletion of the (.+) credential\.$/u.exec(value);
  if (confirmation !== null)
    return msg("settings.credentials.feedback.delete.confirmProvider", {
      provider: confirmation[1] ?? "",
    });
  const deleting = /^Deleting the (.+) credential locally…$/u.exec(value);
  if (deleting !== null)
    return msg("settings.credentials.feedback.delete.deletingProvider", {
      provider: deleting[1] ?? "",
    });
  switch (value) {
    case "Credential deletion could not be confirmed because secure storage could not be verified. Restart Enduragent and reload before trying again.":
      return msg("settings.credentials.feedback.delete.unverified", { product: "Enduragent" });
    case "Unlock your login Keychain outside Enduragent, then Retry.":
      return msg("settings.credentials.feedback.recovery.locked", { product: "Enduragent" });
    case "The credential encryption key is missing. Restore it if possible, then Retry, or remove all credentials and start again.":
      return msg("settings.credentials.feedback.recovery.missing");
    case "Secure credential storage is unavailable. Retry, or remove all credentials and start again.":
      return msg("settings.credentials.feedback.recovery.unavailable");
    case "Enduragent can’t open some saved credentials safely. Enter each affected credential again.":
      return msg("settings.credentials.feedback.recovery.unverified", { product: "Enduragent" });
    case "This credential is managed outside Settings and can’t be deleted here.":
      return msg("settings.credentials.feedback.delete.managed");
    case "That credential is no longer stored. Reload to refresh the list.":
      return msg("settings.credentials.feedback.delete.notStored");
    case "The credential was retained because secure storage could not confirm its encryption key.":
      return msg("settings.credentials.feedback.delete.keyUnverified");
    case "The credential remains stored. No deletion was completed. Try again.":
      return msg("settings.credentials.feedback.delete.retained");
    case "The saved and active credential states could not be reconciled. Reconnect and reload before trying again.":
      return msg("settings.credentials.feedback.delete.reconcileFailed");
    case "The coach could not stop using this credential safely. It was not deleted.":
      return msg("settings.credentials.feedback.delete.stopFailed");
    case "Saved credentials aren’t available. Reconnect and reload.":
      return msg("settings.credentials.feedback.unavailable");
    case "Confirm removal of all credentials.":
      return msg("settings.credentials.feedback.reset.confirm");
    case "Credential removal cancelled.":
      return msg("settings.credentials.feedback.reset.cancelled");
    case "Credential deletion cancelled.":
      return msg("settings.credentials.feedback.delete.cancelled");
    case "Removing all credentials…":
      return msg("settings.credentials.feedback.reset.removing");
    case "Credential removal could not be verified because Settings could not reload. Reconnect and reload.":
      return msg("settings.credentials.feedback.reset.unverified");
    case "Credentials were removed, but Settings could not reload. Reconnect and reload.":
      return msg("settings.credentials.feedback.reset.reloadFailed");
    case "Enduragent could not stop every active credential. Retry to finish removing credentials.":
      return msg("settings.credentials.feedback.reset.stopFailed", { product: "Enduragent" });
    case "Enduragent could not remove every stored credential. Retry.":
      return msg("settings.credentials.feedback.reset.removeFailed", { product: "Enduragent" });
    case "All credentials were removed. Secure storage cleanup will be retried.":
      return msg("settings.credentials.feedback.reset.cleanupPending");
    case "All credentials were removed. Set them up again when you’re ready.":
      return msg("settings.credentials.feedback.reset.removed");
    case "Credential deleted locally, but setup readiness couldn’t be refreshed. Reload credential status.":
      return msg("settings.credentials.feedback.delete.setupRefreshFailed");
    case "Credential deleted locally. Secure storage cleanup will be retried.":
      return msg("settings.credentials.feedback.delete.cleanupPending");
    case "Credential deleted locally. Current credential status couldn’t be refreshed.":
      return msg("settings.credentials.feedback.delete.refreshFailed");
    case "Credential deleted locally.":
      return msg("settings.credentials.feedback.delete.deleted");
    default:
      return null;
  }
}

export function conversationValidationMessage(field: SessionSettingField): Message {
  switch (field) {
    case "timezone":
      return msg("settings.conversation.validation.timezone", { timezone: "Europe/London" });
    case "dailyResetHour":
      return msg("settings.conversation.validation.dailyResetHour");
    case "idleMinutes":
      return msg("settings.conversation.validation.idleMinutes");
    case "resetArchiveRetentionDays":
      return msg("settings.conversation.validation.resetArchiveRetentionDays");
    case "historyTokenBudgetRatio":
      return msg("settings.conversation.validation.historyTokenBudgetRatio");
  }
}

export function credentialKindMessage(kind: CredentialSettingsEntry["kind"]): Message {
  switch (kind) {
    case "Provider API key":
      return msg("settings.credentials.kind.provider");
    case "ChatGPT profile":
      return msg("settings.credentials.kind.chatgpt", { chatgpt: "ChatGPT" });
    case "Training account key":
      return msg("settings.credentials.kind.training");
  }
}

export function providerLabelMessage(value: string): Message | null {
  switch (value) {
    case "Claude subscription":
      return msg("settings.coach.providerLabel.claude", { claude: "Claude" });
    case "ChatGPT subscription":
      return msg("settings.coach.providerLabel.chatgpt", { chatgpt: "ChatGPT" });
    case "Codex agent (experimental)":
      return msg("settings.coach.providerLabel.codex", { codex: "Codex" });
    default:
      return null;
  }
}
