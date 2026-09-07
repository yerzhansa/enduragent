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
import { PLATFORM_COPY } from "../../platform-copy";
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

function channelLabel(status: TelegramControlStatus): string {
  if (status.channel.state === "online") return "Online";
  if (status.channel.state === "starting") return "Connecting";
  if (status.channel.state === "suspended") return "Paused while asleep";
  if (status.channel.state === "offline-retrying") return "Reconnecting";
  if (status.channel.state === "conflict") return "Polling conflict";
  if (status.channel.state === "invalid-token") return "Token rejected";
  if (status.channel.state === "transfer-required") return "Transfer required";
  if (status.channel.state === "failed") return "Needs attention";
  if (status.channel.state === "waiting-for-credential") return "Needs bot token";
  return "Off";
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

function attentionCopy(status: TelegramControlStatus): string | null {
  if (status.channel.state === "conflict") {
    return "Another app or deployment is polling this bot. Stop it there, then choose Check again. Different bots can still run at the same time.";
  }
  if (status.channel.state === "transfer-required") {
    return "This bot belongs to another Enduragent installation or hosted deployment. Delete the connection there, then reconnect it here with a copied token.";
  }
  if (status.channel.state === "invalid-token") {
    return "Telegram rejected the saved token. Delete this connection, then connect a new bot with a copied token from BotFather.";
  }
  if (status.channel.state === "failed") {
    if (status.channel.errorCode === "telegram-credential-encryption-unavailable") {
      return `Secure token storage is unavailable. Quit and reopen Enduragent, ${PLATFORM_COPY.credentialRecoveryAction}, then choose Check again.`;
    }
    if (status.channel.errorCode === "telegram-credential-unsafe-backend") {
      return "No secure credential backend is available, so Enduragent refused to access the saved bot token without encryption. Quit and reopen Enduragent, then choose Check again.";
    }
    if (status.channel.errorCode === "telegram-credential-unavailable") {
      return "The saved bot token could not be read from secure storage. Quit and reopen Enduragent, then choose Check again. If it still cannot be read, delete this connection, then connect a new bot.";
    }
    if (status.channel.errorCode === "telegram-credential-storage-failed") {
      return "The encrypted bot credential could not be saved. Check local disk access and try again.";
    }
    if (status.channel.errorCode === "telegram-settings-storage-uncertain") {
      return "Telegram settings may not have been saved completely. Keep Telegram unchanged and choose Check again before trying another action.";
    }
    if (status.channel.errorCode === "telegram-daemon-unavailable") {
      return "The local coaching service is unavailable. Keep Enduragent open, then choose Check again.";
    }
    if (status.channel.errorCode === "telegram-drain-required") {
      return "A Telegram reply is still finishing. Wait a moment, then try again.";
    }
    if (status.channel.errorCode === "telegram-home-mismatch") {
      return "Desktop is connected to a different athlete home. Restart Enduragent, then check again.";
    }
    return "Telegram could not start. Keep Enduragent open, check the internet connection, then choose Check again.";
  }
  if (status.channel.state === "offline-retrying") {
    return `Telegram is temporarily offline. Enduragent will retry while ${PLATFORM_COPY.computer} is awake and online.`;
  }
  return null;
}

function pairingFailureCopy(status: TelegramControlStatus): string | null {
  if (status.pairing.state === "expired") {
    return "The pairing code expired before it was used. Create a new code when you are ready.";
  }
  if (status.pairing.state !== "failed") return null;
  if (status.pairing.errorCode === "telegram-pairing-storage-uncertain") {
    return "The primary Telegram user may have been saved, but Enduragent could not verify storage. Restart Enduragent and check Telegram before pairing again.";
  }
  if (status.pairing.errorCode === "telegram-pairing-storage-failed") {
    return "The primary Telegram user could not be saved. Check local disk access and try pairing again.";
  }
  if (status.pairing.errorCode === "telegram-pairing-refused") {
    return "Pairing was refused because this bot already has a primary user.";
  }
  return "Pairing is unavailable until the Telegram bot can connect.";
}

function parseSenderId(value: string): number | null {
  const trimmed = value.trim();
  if (!/^[1-9]\d*$/u.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= 10 ? parsed : null;
}

export function TelegramSection(): ReactElement {
  const state = useEnduragentStore((store) => store.settings.telegram);
  const credentialState = useEnduragentStore((store) => store.settings.credentials);
  const mutating = useEnduragentStore((store) => settingsMutationActive(store.settings));
  const port = useEnduragentStore((store) => store.settingsPorts?.telegram ?? null);
  const current = content(state);
  const telegram = current?.telegram ?? null;
  const [senderDraft, setSenderDraft] = useState("");
  const [senderError, setSenderError] = useState<string | null>(null);
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
  const healthAnnouncement = current?.healthAnnouncement ?? "";
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
      : (attentionCopy(telegram) ??
        (credentialIdentityUnknown
          ? "The saved Telegram connection could not be verified. Choose Check again before trying another action."
          : null));
  const pairingFailure = telegram === null ? null : pairingFailureCopy(telegram);
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
      setSenderError("Enter a numeric Telegram user ID with at least two digits.");
      return;
    }
    setSenderError(null);
    setSenderDraft("");
    port?.addSender(senderId);
  };

  return (
    <>
      <h2 className={HEADING_CLASS}>Channels</h2>
      <section className={GROUP_CLASS} aria-label="Telegram">
        <div className="flex items-start justify-between gap-4 border-b border-line px-4 py-[15px]">
          <div>
            <p className="mt-0 mb-[3px] text-[15px] font-[620]">Telegram</p>
            <p className={ROW_DETAIL_CLASS}>
              A dedicated bot is recommended. It creates a new @username and Telegram chat; visible
              history from a previous bot does not move. Athlete memory, training data and plans are
              shared.
            </p>
          </div>
          {telegram === null ? null : (
            <span
              className="inline-flex h-[18px] flex-none items-center justify-center gap-1 whitespace-nowrap rounded-[4px] border border-transparent bg-surface-2 px-[5px] text-xs leading-none font-medium text-ink-2 data-[state=active]:bg-[color-mix(in_srgb,var(--ok)_var(--tint),transparent)] data-[state=active]:text-ok data-[state=failed]:bg-[color-mix(in_srgb,var(--danger)_var(--tint),transparent)] data-[state=failed]:text-danger"
              data-state={channelTone(telegram)}
            >
              {channelLabel(telegram)}
            </span>
          )}
        </div>
        <p className="m-0 border-b border-line px-4 py-[13px] text-[13px] text-ink-2">
          Telegram works only while Enduragent and its local coaching service are running, and{" "}
          {PLATFORM_COPY.computer} is awake and online.
        </p>
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {healthAnnouncement}
        </span>
        {telegram?.channel.state === "suspended" ? (
          <p className="m-0 border-b border-line px-4 py-[13px] text-[13px] text-ink-2">
            Telegram polling resumes when {PLATFORM_COPY.computer} wakes.
          </p>
        ) : null}

        {telegram?.gapWarning.state === "possible-message-loss" ? (
          <div
            className="flex items-center justify-between gap-[14px] border-b border-line bg-sunk px-4 py-[13px] shadow-[inset_3px_0_0_var(--brand)] max-[620px]:flex-col max-[620px]:items-stretch [&_p]:m-0 [&_p]:text-[12.5px] [&_p]:text-ink-2"
            role="alert"
          >
            <div>
              <p className={CONFIRMATION_TITLE_CLASS}>Check Telegram for missed messages</p>
              <p className={CONFIRMATION_COPY_CLASS}>
                The bot resumed after a long gap, so messages sent during that time may not have
                reached Enduragent. Check the Telegram chat before clearing this warning.
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
              Acknowledge
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
                  Check again
                </Button>
              ) : null}
            </div>
          </div>
        )}

        {telegram === null && state.status === "error" && state.kind === "load" ? (
          <div className={ROW_CLASS}>
            <div className="min-w-0 flex-1">
              <div className={ROW_TITLE_CLASS}>Telegram status unavailable</div>
              <div className={ROW_DETAIL_CLASS}>
                Reload the saved connection status before trying another action.
              </div>
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
              Retry
            </Button>
          </div>
        ) : null}

        {telegram?.credentialConfigured === true && botUsername !== null ? (
          <div className={ROW_CLASS}>
            <div className="min-w-0 flex-1">
              <div className={ROW_TITLE_CLASS}>@{botUsername}</div>
              <div className={ROW_DETAIL_CLASS}>
                {paired
                  ? "Paired with a primary Telegram user"
                  : "Bot verified; starting pairing turns Telegram on"}
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
                    Turn off
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
                    Turn on
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
                Delete
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
                Create a bot with BotFather
              </h3>
              <div className={ROW_DETAIL_CLASS}>
                Ask{" "}
                <a
                  className="text-brand"
                  href="https://t.me/BotFather"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  @BotFather
                </a>{" "}
                for a bot, copy its token, then return here. Enduragent reads the token directly
                from the clipboard; there is no token field.
              </div>
            </div>
            <div className={INLINE_ACTIONS_CLASS}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                aria-label="Cancel Telegram bot setup"
                onClick={() => {
                  setFirstTimeOpen(false);
                  queueMicrotask(() => firstTimeTrigger.current?.focus());
                }}
              >
                Cancel
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
                  Retry
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
                Paste token from clipboard
              </Button>
            </div>
          </div>
        ) : (
          <div className={ROW_CLASS}>
            <div className="min-w-0 flex-1">
              <div className={ROW_TITLE_CLASS}>Create a bot with BotFather</div>
              <div className={ROW_DETAIL_CLASS}>Connect a Telegram bot with a copied token.</div>
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
              Connect
            </Button>
          </div>
        )}

        {telegram?.credentialConfigured === true && botUsername !== null && confirmRemove ? (
          <InlineConfirmation
            name="delete-telegram"
            title={`Delete @${botUsername} from ${PLATFORM_COPY.computer}?`}
            copy={`This turns the bot off, deletes its encrypted token and allowed-user access from ${PLATFORM_COPY.computer}. The Telegram bot and its chat remain in Telegram.`}
            confirmLabel="Delete connection"
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
              <p className={CONFIRMATION_TITLE_CLASS}>Remove the existing webhook</p>
              <p className={CONFIRMATION_COPY_CLASS}>
                Telegram cannot deliver to a webhook and {PLATFORM_COPY.computer} at the same time.
                This explicit action keeps pending updates and lets Desktop begin polling.
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
              Remove webhook
            </Button>
          </div>
        ) : null}

        {telegram !== null && hasActiveTelegramPairingCode(telegram) ? (
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center justify-between gap-[14px] border-b border-line bg-brand-soft px-4 py-[13px] max-[620px]:grid-cols-1">
            <p className={`${CONFIRMATION_TITLE_CLASS} col-start-1`}>Pair your Telegram account</p>
            <p className={`${CONFIRMATION_COPY_CLASS} col-start-1`}>
              Send this code as a private message to @{telegram.bot.username}. The first account to
              send it becomes the primary user, and the bot stays online.
            </p>
            <output
              className="col-start-2 row-start-1 row-span-2 min-w-[130px] self-center rounded-md border border-brand bg-surface px-[14px] py-[11px] text-center font-mono text-[22px] font-[650] tracking-[0.14em] text-ink max-[620px]:col-start-1 max-[620px]:row-auto max-[620px]:justify-self-stretch"
              aria-label="Telegram pairing code"
            >
              {telegram.pairing.code}
            </output>
            <p className="col-start-1 m-0 text-[11.5px] text-ink-2">
              Expires{" "}
              {new Date(telegram.pairing.expiresAt).toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
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
              Cancel pairing
            </Button>
          </div>
        ) : null}

        {telegram?.bot.state === "ready" &&
        telegram.pairing.state !== "paired" &&
        telegram.pairing.state !== "awaiting-code" ? (
          <div className={ROW_CLASS}>
            <div className="min-w-0 flex-1">
              <div className={ROW_TITLE_CLASS}>Pair the primary user</div>
              <div className={ROW_DETAIL_CLASS}>
                {pairingFailure ??
                  `A one-minute code ensures only the person with access to ${PLATFORM_COPY.computer} can claim the bot.`}
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
                ? "Create new code and turn on"
                : "Start pairing and turn on"}
            </Button>
          </div>
        ) : null}

        {paired ? (
          <details className="border-b border-line">
            <summary className="cursor-pointer px-4 py-[13px] text-[13px] text-ink-2 hover:text-ink">
              Advanced · allowed users
            </summary>
            {current?.senderLoadFailed === true ? (
              <p className="mt-1 mb-0 px-4 pb-3 text-[12.5px] text-danger">
                Allowed users could not be loaded. Enduragent will try again automatically.
              </p>
            ) : allowedSenders === null ? (
              <p className="mt-1 mb-0 px-4 pb-3 text-[12.5px] text-ink-2">Loading allowed users…</p>
            ) : (
              <ul className="m-0 list-none p-0" aria-label="Allowed Telegram users">
                {allowedSenders.senders.map((sender) => (
                  <li
                    key={sender.senderId}
                    className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-[13px] last:border-b-0"
                  >
                    <div className="min-w-0 flex-1">
                      <div className={ROW_TITLE_CLASS}>{sender.senderId}</div>
                      <div className="text-[12.5px] text-ink-2">
                        {sender.role === "primary"
                          ? "Primary user · required"
                          : "Additional allowed user"}
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
                          aria-label={"Remove Telegram user " + sender.senderId}
                          onClick={(event) => {
                            removeSenderTrigger.current = event.currentTarget;
                            setConfirmRemoveSenderId(sender.senderId);
                          }}
                        >
                          Remove
                        </Button>
                        {confirmRemoveSenderId === sender.senderId ? (
                          <InlineConfirmation
                            name="remove-telegram-user"
                            title={`Remove Telegram user ${sender.senderId}?`}
                            copy={`This user will lose access to your coach and shared athlete data until you re-add them by sender ID ${sender.senderId}.`}
                            confirmLabel="Remove user"
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
                Add a Telegram user ID
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
                  Add user
                </Button>
              </div>
              <p className="mt-1 mb-0 text-[12.5px] text-ink-2" id="telegram-sender-help">
                Add only people you trust to use your coach and shared athlete data.
              </p>
              <p
                className="mt-1 mb-0 text-[12.5px] text-danger"
                id="telegram-sender-error"
                aria-live="polite"
              >
                {senderError ?? ""}
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
            {feedback.message}
          </p>
        )}
      </section>
    </>
  );
}
