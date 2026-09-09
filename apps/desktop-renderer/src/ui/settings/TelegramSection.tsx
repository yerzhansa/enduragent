import { msg, type Message } from "@enduragent/i18n";
import { telegramFeedbackMessage } from "./copy";
import type { Phrasebook } from "@enduragent/i18n/messages";
import { usePhrasebook } from "@enduragent/i18n/react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
} from "react";
import { Button } from "@enduragent/ui";
import {
  hasActiveTelegramPairingCode,
  type TelegramControlStatus,
  type TelegramSettingsState,
} from "../../settings/telegram-controller";
import { credentialChangesBlocked } from "../../settings/credential-controller";
import { PLATFORM_COPY, platformCredentialRecoveryAction } from "../../platform-copy";
import { settingsMutationActive } from "../../state/settings-slice";
import { useEnduragentStore } from "../../state/store";
import { InlineConfirmation } from "@enduragent/ui";

const HEADING_CLASS =
  "mx-1 mt-[26px] mb-2 text-[11px] font-normal tracking-[0.07em] text-ink-3 uppercase first:mt-0";
const GROUP_CLASS = "rounded-xl border border-line bg-surface shadow-elev-1";
const ROW_CLASS = "flex items-center gap-4 border-b border-line px-4 py-[13px] last:border-b-0";
const ROW_TITLE_CLASS = "text-sm font-[560]";
const ROW_DETAIL_CLASS = "mt-px text-[12.5px] text-ink-2";
const CONFIRMATION_TITLE_CLASS = "m-0 text-[13.5px] font-[560]";
const CONFIRMATION_COPY_CLASS = "mt-1 mb-2.5 text-[12.5px] text-ink-2";
const INLINE_ACTIONS_CLASS = "flex flex-none flex-wrap items-center gap-2";
const ATTENTION_CLASS =
  "flex items-center justify-between gap-[14px] border-b border-line bg-sunk px-4 py-[13px] shadow-[inset_3px_0_0_var(--danger)] max-[620px]:flex-col max-[620px]:items-stretch [&_p]:m-0 [&_p]:text-[12.5px] [&_p]:text-ink-2";
const FIELD_CLASS =
  "h-[30px] min-w-0 flex-1 rounded-ctl border border-line-2 bg-surface px-[11px] text-sm text-ink shadow-elev-1 transition-[border-color,box-shadow] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/20 focus-visible:outline-0 disabled:opacity-64";

function content(state: TelegramSettingsState) {
  if (state.status === "ready" || state.status === "working" || state.status === "error") {
    return state;
  }
  return null;
}

function channelLabel(status: TelegramControlStatus, say: Phrasebook["say"]): string {
  if (status.channel.state === "online") return say("settings.telegram.channel.online");
  if (status.channel.state === "starting") return say("settings.telegram.channel.connecting");
  if (status.channel.state === "suspended") return say("settings.telegram.channel.suspended");
  if (status.channel.state === "offline-retrying")
    return say("settings.telegram.channel.reconnecting");
  if (status.channel.state === "conflict") return say("settings.telegram.channel.conflict");
  if (status.channel.state === "invalid-token")
    return say("settings.telegram.channel.tokenRejected");
  if (status.channel.state === "transfer-required")
    return say("settings.telegram.channel.transferRequired");
  if (status.channel.state === "failed") return say("settings.telegram.channel.failed");
  if (status.channel.state === "waiting-for-credential")
    return say("settings.telegram.channel.waitingForCredential");
  return say("settings.telegram.channel.off");
}

function channelTone(status: TelegramControlStatus): "active" | "failed" | "idle" {
  if (status.channel.state === "online") return "active";
  if (
    status.channel.state === "conflict" ||
    status.channel.state === "invalid-token" ||
    status.channel.state === "transfer-required" ||
    status.channel.state === "failed"
  ) {
    return "failed";
  }
  return "idle";
}

function attentionCopy(status: TelegramControlStatus, say: Phrasebook["say"]): string | null {
  if (status.channel.state === "conflict") {
    return say("settings.telegram.attention.conflict");
  }
  if (status.channel.state === "transfer-required") {
    return say("settings.telegram.attention.transferRequired", { product: "Enduragent" });
  }
  if (status.channel.state === "invalid-token") {
    return say("settings.telegram.attention.invalidToken", {
      botFather: "BotFather",
      telegram: "Telegram",
    });
  }
  if (status.channel.state === "failed") {
    if (status.channel.errorCode === "telegram-credential-encryption-unavailable") {
      return say("settings.telegram.attention.encryption", {
        product: "Enduragent",
        recoveryAction: say(platformCredentialRecoveryAction()),
      });
    }
    if (status.channel.errorCode === "telegram-credential-unsafe-backend") {
      return say("settings.telegram.attention.unsafeBackend", { product: "Enduragent" });
    }
    if (status.channel.errorCode === "telegram-credential-unavailable") {
      return say("settings.telegram.attention.credentialUnavailable", { product: "Enduragent" });
    }
    if (status.channel.errorCode === "telegram-credential-storage-failed") {
      return say("settings.telegram.attention.storageFailed");
    }
    if (status.channel.errorCode === "telegram-settings-storage-uncertain") {
      return say("settings.telegram.attention.storageUncertain", { telegram: "Telegram" });
    }
    if (status.channel.errorCode === "telegram-daemon-unavailable") {
      return say("settings.telegram.attention.daemonUnavailable", { product: "Enduragent" });
    }
    if (status.channel.errorCode === "telegram-drain-required") {
      return say("settings.telegram.attention.drainRequired", { telegram: "Telegram" });
    }
    if (status.channel.errorCode === "telegram-home-mismatch") {
      return say("settings.telegram.attention.homeMismatch", { product: "Enduragent" });
    }
    return say("settings.telegram.attention.startFailed", {
      product: "Enduragent",
      telegram: "Telegram",
    });
  }
  if (status.channel.state === "offline-retrying") {
    return say("settings.telegram.attention.offline", {
      product: "Enduragent",
      telegram: "Telegram",
      computer: PLATFORM_COPY.computer,
    });
  }
  return null;
}

function pairingFailureCopy(status: TelegramControlStatus, say: Phrasebook["say"]): string | null {
  if (status.pairing.state === "expired") {
    return say("settings.telegram.pairing.expired");
  }
  if (status.pairing.state !== "failed") return null;
  if (status.pairing.errorCode === "telegram-pairing-storage-uncertain") {
    return say("settings.telegram.pairing.storageUncertain", {
      product: "Enduragent",
      telegram: "Telegram",
    });
  }
  if (status.pairing.errorCode === "telegram-pairing-storage-failed") {
    return say("settings.telegram.pairing.storageFailed", { telegram: "Telegram" });
  }
  if (status.pairing.errorCode === "telegram-pairing-refused") {
    return say("settings.telegram.pairing.refused");
  }
  return say("settings.telegram.pairing.unavailable", { telegram: "Telegram" });
}

function parseSenderId(value: string): number | null {
  const trimmed = value.trim();
  if (!/^[1-9]\d*$/u.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= 10 ? parsed : null;
}

export function TelegramSection(): ReactElement {
  const { say, format } = usePhrasebook();
  const state = useEnduragentStore((store) => store.settings.telegram);
  const credentialState = useEnduragentStore((store) => store.settings.credentials);
  const mutating = useEnduragentStore((store) => settingsMutationActive(store.settings));
  const port = useEnduragentStore((store) => store.settingsPorts?.telegram ?? null);
  const current = content(state);
  const telegram = current?.telegram ?? null;
  const [senderDraft, setSenderDraft] = useState("");
  const [senderError, setSenderError] = useState<Message | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmRemoveSenderId, setConfirmRemoveSenderId] = useState<number | null>(null);
  const [firstTimeOpen, setFirstTimeOpen] = useState(() => telegram?.credentialConfigured !== true);
  const deleteTrigger = useRef<HTMLButtonElement>(null);
  const removeSenderTrigger = useRef<HTMLButtonElement>(null);
  const firstTimeTrigger = useRef<HTMLButtonElement>(null);
  const firstTimeHeading = useRef<HTMLHeadingElement>(null);
  const focusFirstTimeHeading = useRef(false);
  const previousCredentialIdentityMissing = useRef<boolean | null>(
    telegram === null
      ? null
      : telegram.credentialConfigured === false &&
          telegram.bot.state === "unconfigured" &&
          (telegram.channel.state === "disabled" ||
            telegram.channel.state === "waiting-for-credential"),
  );
  const allowedSenders = current?.allowedSenders ?? null;
  const feedback = current?.feedback ?? null;
  const healthMessage = telegramFeedbackMessage(
    current?.healthAnnouncement ?? "",
    say(platformCredentialRecoveryAction()),
  );
  const healthAnnouncement =
    healthMessage === null ? (current?.healthAnnouncement ?? "") : say(healthMessage);
  const feedbackMessage = telegramFeedbackMessage(
    feedback?.message ?? "",
    say(platformCredentialRecoveryAction()),
  );
  const loading = state.status === "closed" || state.status === "loading";
  const working = state.status === "working";
  const busy = mutating || loading || working;
  const credentialMutationBlocked = credentialChangesBlocked(credentialState, false);
  const removing = state.status === "working" && state.operation === "remove";
  const removingSender = state.status === "working" && state.operation === "remove-sender";
  const botUsername =
    telegram === null || telegram.bot.state === "unconfigured" ? null : telegram.bot.username;
  const credentialIdentityMissing =
    telegram?.credentialConfigured === false &&
    telegram.bot.state === "unconfigured" &&
    (telegram.channel.state === "disabled" || telegram.channel.state === "waiting-for-credential");
  const credentialIdentityUnknown =
    telegram !== null &&
    !credentialIdentityMissing &&
    !(telegram.credentialConfigured && telegram.bot.state !== "unconfigured");
  const attention =
    telegram === null
      ? null
      : (attentionCopy(telegram, say) ??
        (credentialIdentityUnknown
          ? say("settings.telegram.attention.identityUnknown", { telegram: "Telegram" })
          : null));
  const pairingFailure = telegram === null ? null : pairingFailureCopy(telegram, say);
  const paired = telegram?.pairing.state === "paired";
  const needsCheck =
    credentialIdentityUnknown ||
    telegram?.channel.state === "conflict" ||
    telegram?.channel.state === "transfer-required" ||
    telegram?.channel.state === "failed" ||
    telegram?.channel.state === "offline-retrying";

  useEffect(() => {
    if (
      telegram === null ||
      !telegram.credentialConfigured ||
      telegram.bot.state === "unconfigured"
    ) {
      setConfirmRemove(false);
    }
  }, [telegram]);

  useEffect(() => {
    if (
      confirmRemoveSenderId !== null &&
      allowedSenders !== null &&
      !allowedSenders.senders.some((sender) => sender.senderId === confirmRemoveSenderId)
    ) {
      setConfirmRemoveSenderId(null);
    }
  }, [allowedSenders, confirmRemoveSenderId]);

  useEffect(() => {
    if (!credentialIdentityMissing) return;
    setSenderDraft("");
    setSenderError(null);
  }, [credentialIdentityMissing]);

  useLayoutEffect(() => {
    if (telegram === null) {
      previousCredentialIdentityMissing.current = null;
      return;
    }
    const previous = previousCredentialIdentityMissing.current;
    previousCredentialIdentityMissing.current = credentialIdentityMissing;
    if (previous !== false || !credentialIdentityMissing) return;
    focusFirstTimeHeading.current = true;
    setFirstTimeOpen(true);
  }, [credentialIdentityMissing, telegram]);

  useLayoutEffect(() => {
    if (!firstTimeOpen || !focusFirstTimeHeading.current) return;
    firstTimeHeading.current?.focus();
    focusFirstTimeHeading.current = false;
  }, [firstTimeOpen, telegram?.credentialConfigured]);

  const submitSender = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (credentialMutationBlocked) return;
    const senderId = parseSenderId(senderDraft);
    if (senderId === null) {
      setSenderError(msg("settings.telegram.sender.validation", { telegram: "Telegram" }));
      return;
    }
    setSenderError(null);
    setSenderDraft("");
    port?.addSender(senderId);
  };

  return (
    <>
      <h2 className={HEADING_CLASS}>{say("settings.telegram.title")}</h2>
      <section className={GROUP_CLASS} aria-label="Telegram">
        <div className="flex items-start justify-between gap-4 border-b border-line px-4 py-[15px]">
          <div>
            <p className="mt-0 mb-[3px] text-[15px] font-[620]">Telegram</p>
            <p className={ROW_DETAIL_CLASS}>
              {say("settings.telegram.detail", { telegram: "Telegram" })}
            </p>
          </div>
          {telegram === null ? null : (
            <span
              className="inline-flex h-[18px] flex-none items-center justify-center gap-1 whitespace-nowrap rounded-[4px] border border-transparent bg-surface-2 px-[5px] text-xs leading-none font-medium text-ink-2 data-[state=active]:bg-[color-mix(in_srgb,var(--ok)_var(--tint),transparent)] data-[state=active]:text-ok data-[state=failed]:bg-[color-mix(in_srgb,var(--danger)_var(--tint),transparent)] data-[state=failed]:text-danger"
              data-state={channelTone(telegram)}
            >
              {channelLabel(telegram, say)}
            </span>
          )}
        </div>
        <p className="m-0 border-b border-line px-4 py-[13px] text-[13px] text-ink-2">
          {say("settings.telegram.availability", {
            product: "Enduragent",
            telegram: "Telegram",
            computer: PLATFORM_COPY.computer,
          })}
        </p>
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {healthAnnouncement}
        </span>
        {telegram?.channel.state === "suspended" ? (
          <p className="m-0 border-b border-line px-4 py-[13px] text-[13px] text-ink-2">
            {say("settings.telegram.suspended", {
              telegram: "Telegram",
              computer: PLATFORM_COPY.computer,
            })}
          </p>
        ) : null}

        {telegram?.gapWarning.state === "possible-message-loss" ? (
          <div
            className="flex items-center justify-between gap-[14px] border-b border-line bg-sunk px-4 py-[13px] shadow-[inset_3px_0_0_var(--brand)] max-[620px]:flex-col max-[620px]:items-stretch [&_p]:m-0 [&_p]:text-[12.5px] [&_p]:text-ink-2"
            role="alert"
          >
            <div>
              <p className={CONFIRMATION_TITLE_CLASS}>
                {say("settings.telegram.gap.title", { telegram: "Telegram" })}
              </p>
              <p className={CONFIRMATION_COPY_CLASS}>
                {say("settings.telegram.gap.detail", {
                  product: "Enduragent",
                  telegram: "Telegram",
                })}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                port?.acknowledgeGapWarning();
              }}
            >
              {say("settings.telegram.gap.acknowledge")}
            </Button>
          </div>
        ) : null}

        {attention === null ? null : (
          <div className={ATTENTION_CLASS} role="alert">
            <p>{attention}</p>
            <div className={INLINE_ACTIONS_CLASS}>
              {needsCheck ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    port?.reconcile();
                  }}
                >
                  {say("settings.telegram.check")}
                </Button>
              ) : null}
            </div>
          </div>
        )}

        {telegram === null && state.status === "error" && state.kind === "load" ? (
          <div className={ROW_CLASS}>
            <div className="min-w-0 flex-1">
              <div className={ROW_TITLE_CLASS}>
                {say("settings.telegram.unavailable", { telegram: "Telegram" })}
              </div>
              <div className={ROW_DETAIL_CLASS}>{say("settings.telegram.reloadDetail")}</div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                port?.retry();
              }}
            >
              {say("settings.telegram.retry")}
            </Button>
          </div>
        ) : null}

        {telegram?.credentialConfigured === true && botUsername !== null ? (
          <div className={ROW_CLASS}>
            <div className="min-w-0 flex-1">
              <div className={ROW_TITLE_CLASS}>@{botUsername}</div>
              <div className={ROW_DETAIL_CLASS}>
                {paired
                  ? say("settings.telegram.paired", { telegram: "Telegram" })
                  : say("settings.telegram.verified", { telegram: "Telegram" })}
              </div>
            </div>
            <div className={INLINE_ACTIONS_CLASS}>
              {paired ? (
                telegram.channel.desiredState === "enabled" ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      port?.disable();
                    }}
                  >
                    {say("settings.telegram.disable")}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="default"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      port?.enable();
                    }}
                  >
                    {say("settings.telegram.enable")}
                  </Button>
                )
              ) : null}
              <Button
                type="button"
                ref={deleteTrigger}
                variant="destructive"
                size="sm"
                disabled={busy || credentialMutationBlocked || confirmRemove}
                onClick={() => {
                  setConfirmRemove(true);
                }}
              >
                {say("settings.telegram.delete.action")}
              </Button>
            </div>
          </div>
        ) : !credentialIdentityMissing ? null : firstTimeOpen ? (
          <div
            id="telegram-first-time-panel"
            className={`${ROW_CLASS} flex-col items-stretch gap-2`}
          >
            <div>
              <h3
                ref={firstTimeHeading}
                tabIndex={-1}
                className={`${ROW_TITLE_CLASS} m-0 focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ink`}
              >
                {say("settings.telegram.setup.title", { botFather: "BotFather" })}
              </h3>
              <div className={ROW_DETAIL_CLASS}>
                {say("settings.telegram.setup.ask")}{" "}
                <a
                  className="text-brand"
                  href="https://t.me/BotFather"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  @BotFather
                </a>{" "}
                {say("settings.telegram.setup.afterBotfather", { product: "Enduragent" })}
              </div>
            </div>
            <div className={INLINE_ACTIONS_CLASS}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                aria-label={say("settings.telegram.setup.cancelAria", { telegram: "Telegram" })}
                onClick={() => {
                  setFirstTimeOpen(false);
                  queueMicrotask(() => firstTimeTrigger.current?.focus());
                }}
              >
                {say("settings.telegram.setup.cancel")}
              </Button>
              {state.status === "error" && state.kind === "load" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    port?.retry();
                  }}
                >
                  {say("settings.telegram.retry")}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="default"
                size="sm"
                disabled={busy || credentialMutationBlocked}
                onClick={() => {
                  port?.pasteToken();
                }}
              >
                {say("settings.telegram.setup.paste")}
              </Button>
            </div>
          </div>
        ) : (
          <div className={ROW_CLASS}>
            <div className="min-w-0 flex-1">
              <div className={ROW_TITLE_CLASS}>
                {say("settings.telegram.setup.title", { botFather: "BotFather" })}
              </div>
              <div className={ROW_DETAIL_CLASS}>
                {say("settings.telegram.setup.detail", { telegram: "Telegram" })}
              </div>
            </div>
            <Button
              type="button"
              ref={firstTimeTrigger}
              variant="outline"
              size="sm"
              disabled={busy}
              aria-expanded={false}
              aria-controls="telegram-first-time-panel"
              onClick={() => {
                focusFirstTimeHeading.current = true;
                setFirstTimeOpen(true);
              }}
            >
              {say("settings.telegram.setup.connect")}
            </Button>
          </div>
        )}

        {telegram?.credentialConfigured === true && botUsername !== null && confirmRemove ? (
          <InlineConfirmation
            name="delete-telegram"
            title={say("settings.telegram.delete.title", {
              botUsername: botUsername,
              computer: PLATFORM_COPY.computer,
            })}
            copy={say("settings.telegram.delete.detail", {
              telegram: "Telegram",
              computer: PLATFORM_COPY.computer,
            })}
            confirmLabel={say("settings.telegram.delete.confirm")}
            focusTarget={null}
            cancelDisabled={busy}
            confirmDisabled={busy || credentialMutationBlocked}
            confirmBusy={removing}
            onCancel={() => {
              setConfirmRemove(false);
              queueMicrotask(() => deleteTrigger.current?.focus());
            }}
            onConfirm={() => {
              port?.remove();
            }}
          />
        ) : null}

        {telegram?.bot.state === "webhook-removal-required" ? (
          <div className={ATTENTION_CLASS} role="alert">
            <div>
              <p className={CONFIRMATION_TITLE_CLASS}>{say("settings.telegram.webhook.title")}</p>
              <p className={CONFIRMATION_COPY_CLASS}>
                {say("settings.telegram.webhook.detail", {
                  telegram: "Telegram",
                  computer: PLATFORM_COPY.computer,
                })}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                port?.removeWebhook();
              }}
            >
              {say("settings.telegram.webhook.remove")}
            </Button>
          </div>
        ) : null}

        {telegram !== null && hasActiveTelegramPairingCode(telegram) ? (
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center justify-between gap-[14px] border-b border-line bg-brand-soft px-4 py-[13px] max-[620px]:grid-cols-1">
            <p className={`${CONFIRMATION_TITLE_CLASS} col-start-1`}>
              {say("settings.telegram.pairing.title", { telegram: "Telegram" })}
            </p>
            <p className={`${CONFIRMATION_COPY_CLASS} col-start-1`}>
              {say("settings.telegram.pairing.instruction", { username: telegram.bot.username })}
            </p>
            <output
              className="col-start-2 row-start-1 row-span-2 min-w-[130px] self-center rounded-md border border-brand bg-surface px-[14px] py-[11px] text-center font-mono text-[22px] font-[650] tracking-[0.14em] text-ink max-[620px]:col-start-1 max-[620px]:row-auto max-[620px]:justify-self-stretch"
              aria-label={say("settings.telegram.pairing.code", { telegram: "Telegram" })}
            >
              {telegram.pairing.code}
            </output>
            <p className="col-start-1 m-0 text-[11.5px] text-ink-2">
              {say("settings.telegram.pairing.expires", {
                time: format.date(new Date(telegram.pairing.expiresAt), {
                  hour: "numeric",
                  minute: "2-digit",
                }),
              })}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="col-start-2 row-start-3 max-[620px]:col-start-1 max-[620px]:row-auto"
              disabled={busy}
              onClick={() => {
                port?.cancelPairing();
              }}
            >
              {say("settings.telegram.pairing.cancel")}
            </Button>
          </div>
        ) : null}

        {telegram?.bot.state === "ready" &&
        telegram.pairing.state !== "paired" &&
        telegram.pairing.state !== "awaiting-code" ? (
          <div className={ROW_CLASS}>
            <div className="min-w-0 flex-1">
              <div className={ROW_TITLE_CLASS}>{say("settings.telegram.pairing.primary")}</div>
              <div className={ROW_DETAIL_CLASS}>
                {pairingFailure ??
                  say("settings.telegram.pairing.detail", { computer: PLATFORM_COPY.computer })}
              </div>
            </div>
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={busy}
              onClick={() => {
                port?.beginPairing();
              }}
            >
              {telegram.pairing.state === "expired"
                ? say("settings.telegram.pairing.restart")
                : say("settings.telegram.pairing.start")}
            </Button>
          </div>
        ) : null}

        {paired ? (
          <details className="border-b border-line">
            <summary className="cursor-pointer px-4 py-[13px] text-[13px] text-ink-2 hover:text-ink">
              {say("settings.telegram.sender.advanced")}
            </summary>
            {current?.senderLoadFailed === true ? (
              <p className="mt-1 mb-0 px-4 pb-3 text-[12.5px] text-danger">
                {say("settings.telegram.sender.loadFailed", { product: "Enduragent" })}
              </p>
            ) : allowedSenders === null ? (
              <p className="mt-1 mb-0 px-4 pb-3 text-[12.5px] text-ink-2">
                {say("settings.telegram.sender.loading")}
              </p>
            ) : (
              <ul
                className="m-0 list-none p-0"
                aria-label={say("settings.telegram.sender.list", { telegram: "Telegram" })}
              >
                {allowedSenders.senders.map((sender) => (
                  <li
                    key={sender.senderId}
                    className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-[13px] last:border-b-0"
                  >
                    <div className="min-w-0 flex-1">
                      <div className={ROW_TITLE_CLASS}>{sender.senderId}</div>
                      <div className="text-[12.5px] text-ink-2">
                        {sender.role === "primary"
                          ? say("settings.telegram.sender.primary")
                          : say("settings.telegram.sender.additional")}
                      </div>
                    </div>
                    {sender.role === "additional" ? (
                      <>
                        <Button
                          type="button"
                          variant="destructive"
                          size="sm"
                          disabled={
                            busy || credentialMutationBlocked || confirmRemoveSenderId !== null
                          }
                          aria-label={say("settings.telegram.sender.removeAria", {
                            telegram: "Telegram",
                            senderId: String(sender.senderId),
                          })}
                          onClick={(event) => {
                            removeSenderTrigger.current = event.currentTarget;
                            setConfirmRemoveSenderId(sender.senderId);
                          }}
                        >
                          {say("settings.telegram.sender.remove")}
                        </Button>
                        {confirmRemoveSenderId === sender.senderId ? (
                          <InlineConfirmation
                            name="remove-telegram-user"
                            title={say("settings.telegram.sender.removeTitle", {
                              telegram: "Telegram",
                              senderId: String(sender.senderId),
                            })}
                            copy={say("settings.telegram.sender.removeDetail", {
                              senderId: String(sender.senderId),
                            })}
                            confirmLabel={say("settings.telegram.sender.removeConfirm")}
                            focusTarget={null}
                            cancelDisabled={busy}
                            confirmDisabled={busy || credentialMutationBlocked}
                            confirmBusy={removingSender}
                            onCancel={() => {
                              setConfirmRemoveSenderId(null);
                              queueMicrotask(() => removeSenderTrigger.current?.focus());
                            }}
                            onConfirm={() => {
                              if (credentialMutationBlocked) return;
                              port?.removeSender(sender.senderId);
                            }}
                          />
                        ) : null}
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            <form className="border-t border-line px-4 py-[13px]" onSubmit={submitSender}>
              <label className={ROW_TITLE_CLASS} htmlFor="telegram-sender-id">
                {say("settings.telegram.sender.addTitle", { telegram: "Telegram" })}
              </label>
              <div className="mt-[7px] flex gap-2">
                <input
                  id="telegram-sender-id"
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  spellCheck={false}
                  className={FIELD_CLASS}
                  value={senderDraft}
                  disabled={busy || credentialMutationBlocked}
                  aria-invalid={senderError === null ? undefined : "true"}
                  aria-describedby="telegram-sender-help telegram-sender-error"
                  onChange={(event) => {
                    setSenderDraft(event.target.value);
                    setSenderError(null);
                  }}
                />
                <Button
                  type="submit"
                  variant="outline"
                  size="sm"
                  disabled={busy || credentialMutationBlocked}
                >
                  {say("settings.telegram.sender.add")}
                </Button>
              </div>
              <p className="mt-1 mb-0 text-[12.5px] text-ink-2" id="telegram-sender-help">
                {say("settings.telegram.sender.help")}
              </p>
              <p
                className="mt-1 mb-0 text-[12.5px] text-danger"
                id="telegram-sender-error"
                aria-live="polite"
              >
                {senderError === null ? "" : say(senderError)}
              </p>
            </form>
          </details>
        ) : null}

        {feedback === null ? null : (
          <p
            className="m-0 border-t border-line px-4 py-[11px] text-[12.5px] text-ink-2"
            role={feedback.tone === "error" ? "alert" : "status"}
            aria-live={feedback.tone === "error" ? undefined : "polite"}
            aria-atomic="true"
          >
            {feedbackMessage === null ? feedback.message : say(feedbackMessage)}
          </p>
        )}
      </section>
    </>
  );
}
