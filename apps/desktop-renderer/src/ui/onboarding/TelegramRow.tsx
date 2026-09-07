import { useEffect, useRef, useState, type ReactElement } from "react";
import { Button } from "@enduragent/ui";
import type {
  TelegramControlStatus,
  TelegramSettingsFeedback,
  TelegramSettingsState,
} from "../../settings/telegram-controller";
import { credentialChangesBlocked } from "../../settings/credential-controller";
import { PLATFORM_COPY } from "../../platform-copy";
import { settingsMutationActive, type TelegramSettingsPort } from "../../state/settings-slice";
import { useEnduragentStore } from "../../state/store";
import {
  TELEGRAM_AVAILABILITY_COPY,
  TELEGRAM_CREATE_COPY_AFTER_BOTFATHER,
  TELEGRAM_CREATE_TITLE,
  TELEGRAM_DELETE_COPY,
  TELEGRAM_DELETE_TITLE,
  TELEGRAM_OPTIONAL_LABEL,
  TELEGRAM_ROW_TITLE,
  TELEGRAM_VERIFIED_PREFIX,
} from "./copy";
import { InlineConfirmation, type InlineConfirmationFocus } from "@enduragent/ui";
import { SetupRow, SetupSubPanel } from "./SetupRow";

type TelegramPanel = "closed" | "token" | "delete";
type TelegramAction = "paste-token" | "remove";
type TelegramAttemptPhase = "requested" | "working" | "settled";

interface TelegramAttempt {
  readonly action: TelegramAction;
  readonly feedbackBefore: TelegramSettingsFeedback | null;
  readonly feedback: TelegramSettingsFeedback | null;
  readonly panelDismissed: boolean;
  readonly phase: TelegramAttemptPhase;
  readonly verifiedUsernameBefore: string | null;
}

type TelegramIdentity =
  | { readonly kind: "verified"; readonly username: string }
  | { readonly kind: "missing" };

const persistedTelegramAttempts = new WeakMap<TelegramSettingsPort, TelegramAttempt>();

function content(state: TelegramSettingsState) {
  if (state.status === "ready" || state.status === "working" || state.status === "error") {
    return state;
  }
  return null;
}

function identity(telegram: TelegramControlStatus | null): TelegramIdentity {
  if (telegram?.credentialConfigured === true && telegram.bot.state !== "unconfigured") {
    return { kind: "verified", username: telegram.bot.username };
  }
  return { kind: "missing" };
}

function sameFeedback(
  left: TelegramSettingsFeedback | null,
  right: TelegramSettingsFeedback | null,
): boolean {
  return left?.tone === right?.tone && left?.message === right?.message;
}

function fallbackFeedback(action: TelegramAction): TelegramSettingsFeedback {
  return {
    tone: "error",
    message:
      action === "paste-token"
        ? "The copied token was not applied. The current Telegram bot is unchanged."
        : `The Telegram connection was not deleted from ${PLATFORM_COPY.computer}.`,
  };
}

function applied(attempt: TelegramAttempt, state: TelegramSettingsState): boolean {
  const current = content(state);
  if (state.status !== "ready" || current?.feedback?.tone !== "success") return false;
  const currentIdentity = identity(current.telegram);
  return attempt.action === "paste-token"
    ? currentIdentity.kind === "verified"
    : currentIdentity.kind === "missing";
}

function persistAttempt(
  port: TelegramSettingsPort | null,
  attempt: TelegramAttempt | null,
): TelegramAttempt | null {
  if (port === null) return attempt;
  if (attempt === null) persistedTelegramAttempts.delete(port);
  else persistedTelegramAttempts.set(port, attempt);
  return attempt;
}

function restoreAttempt(
  port: TelegramSettingsPort | null,
  state: TelegramSettingsState,
): TelegramAttempt | null {
  if (port === null) return null;
  const current = content(state);
  const feedback = current?.feedback ?? null;
  let attempt = persistedTelegramAttempts.get(port) ?? null;
  if (
    attempt === null &&
    state.status === "working" &&
    (state.operation === "paste-token" || state.operation === "remove")
  ) {
    const currentIdentity = identity(current?.telegram ?? null);
    attempt = {
      action: state.operation,
      feedbackBefore: null,
      feedback: null,
      panelDismissed: false,
      phase: "working",
      verifiedUsernameBefore: currentIdentity.kind === "verified" ? currentIdentity.username : null,
    };
    return persistAttempt(port, attempt);
  }
  if (attempt === null) return null;
  if (state.status === "closed" || state.status === "loading") return attempt;
  if (state.status === "working") {
    if (state.operation !== attempt.action) return persistAttempt(port, null);
    attempt = { ...attempt, feedback: null, phase: "working" };
    return persistAttempt(port, attempt);
  }
  if (attempt.phase === "settled") {
    if (sameFeedback(feedback, attempt.feedback)) return attempt;
    const currentIdentity = identity(current?.telegram ?? null);
    if (attempt.action === "remove" && currentIdentity.kind === "missing") return attempt;
    return persistAttempt(port, null);
  }
  if (attempt.phase === "requested" && sameFeedback(feedback, attempt.feedbackBefore)) {
    return persistAttempt(port, null);
  }
  if (applied(attempt, state)) {
    return attempt.action === "remove" ? attempt : persistAttempt(port, null);
  }
  attempt = {
    ...attempt,
    feedback: feedback ?? fallbackFeedback(attempt.action),
    phase: "settled",
  };
  return persistAttempt(port, attempt);
}

export function TelegramRow(): ReactElement {
  const state = useEnduragentStore((store) => store.settings.telegram);
  const settings = useEnduragentStore((store) => store.settings);
  const setupReadyForFocus = useEnduragentStore(
    (store) => store.onboarding.open && !store.onboarding.loading,
  );
  const port = useEnduragentStore((store) => store.settingsPorts?.telegram ?? null);
  const [restoredAttempt] = useState(() => restoreAttempt(port, state));
  const [panel, setPanel] = useState<TelegramPanel>(() => {
    if (restoredAttempt?.panelDismissed === true) return "closed";
    if (restoredAttempt?.action === "remove") return "delete";
    return restoredAttempt === null ? "closed" : "token";
  });
  const [attempt, setAttempt] = useState<TelegramAttempt | null>(restoredAttempt);
  const [panelFeedback, setPanelFeedback] = useState<TelegramSettingsFeedback | null>(
    restoredAttempt?.phase === "settled" ? restoredAttempt.feedback : null,
  );
  const [confirmationFocus, setConfirmationFocus] = useState<InlineConfirmationFocus>(() =>
    restoredAttempt?.action === "remove" && restoredAttempt.phase === "working" ? "confirm" : null,
  );
  const [confirmationVersion, setConfirmationVersion] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const tokenAction = useRef<HTMLButtonElement>(null);
  const retryAction = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusHeadingAfterOpen = useRef(false);
  const focusRestoredConfirmationAfterOpen = useRef(
    restoredAttempt?.action === "remove" && restoredAttempt.phase === "working",
  );
  const current = content(state);
  const telegram = current?.telegram ?? null;
  const feedback = current?.feedback ?? null;
  const currentIdentity = identity(telegram);
  const authoritativeIdentity = useRef<"verified" | "missing">(currentIdentity.kind);
  const verifiedUsername = currentIdentity.kind === "verified" ? currentIdentity.username : null;
  const username = verifiedUsername ?? attempt?.verifiedUsernameBefore ?? null;
  const configured = username !== null;
  const loading = state.status === "closed" || state.status === "loading";
  const busy = loading || settingsMutationActive(settings) || state.status === "working";
  const credentialMutationBlocked = credentialChangesBlocked(settings.credentials, false);
  const activeAttempt = attempt !== null && attempt.phase !== "settled";
  const connecting = activeAttempt && attempt.action === "paste-token";
  const removing = activeAttempt && attempt.action === "remove";
  const authoritativeCheckRequired =
    attempt?.phase === "settled" &&
    attempt.feedback?.tone === "warning" &&
    sameFeedback(feedback, attempt.feedback);
  const mutationUnsafe = authoritativeCheckRequired;
  const panelId = "onboarding-telegram-panel";

  useEffect(() => {
    if (!setupReadyForFocus || panel !== "token" || !focusHeadingAfterOpen.current) return;
    queueMicrotask(() => {
      if (!focusHeadingAfterOpen.current) return;
      heading.current?.focus();
      focusHeadingAfterOpen.current = false;
    });
  }, [panel, setupReadyForFocus]);

  useEffect(() => {
    const previous = authoritativeIdentity.current;
    authoritativeIdentity.current = currentIdentity.kind;
    if (previous === currentIdentity.kind) return;
    if (attempt !== null) return;
    if (currentIdentity.kind === "verified" && panel === "token") {
      persistAttempt(port, null);
      setAttempt(null);
      setPanelFeedback(null);
      setPanel("closed");
      queueMicrotask(() => trigger.current?.focus());
      return;
    }
    if (previous !== "verified" || currentIdentity.kind !== "missing") return;
    persistAttempt(port, null);
    setAttempt(null);
    setPanelFeedback(null);
    focusHeadingAfterOpen.current = true;
    setPanel("token");
  }, [attempt, currentIdentity.kind, panel, port]);

  useEffect(() => {
    if (!setupReadyForFocus || panel !== "delete" || !focusRestoredConfirmationAfterOpen.current) {
      return;
    }
    focusRestoredConfirmationAfterOpen.current = false;
    setConfirmationFocus("confirm");
    setConfirmationVersion((version) => version + 1);
  }, [panel, setupReadyForFocus]);

  useEffect(() => {
    if (attempt === null) return;
    if (state.status === "closed" || state.status === "loading") return;
    if (state.status === "working") {
      if (state.operation === attempt.action && attempt.phase !== "working") {
        const workingAttempt = persistAttempt(port, {
          ...attempt,
          feedback: null,
          phase: "working",
        });
        setAttempt(workingAttempt);
      }
      return;
    }
    if (attempt.phase === "settled") {
      const feedbackChanged = !sameFeedback(feedback, attempt.feedback);
      const recoveredFromUncertain =
        attempt.feedback?.tone === "warning" &&
        feedbackChanged &&
        ((attempt.action === "remove" && currentIdentity.kind === "missing") ||
          attempt.action === "paste-token");
      if (recoveredFromUncertain) {
        persistAttempt(port, null);
        setAttempt(null);
        setPanelFeedback(null);
        if (attempt.action === "remove") {
          focusHeadingAfterOpen.current = true;
          setPanel("token");
        } else {
          setPanel("closed");
          queueMicrotask(() => trigger.current?.focus());
        }
        return;
      }
      if (feedbackChanged) {
        persistAttempt(port, null);
        setAttempt(null);
        setPanelFeedback(null);
        if (attempt.action === "remove" && currentIdentity.kind === "missing") {
          focusHeadingAfterOpen.current = true;
          setPanel("token");
        } else if (attempt.action === "remove" && panel === "delete") {
          setConfirmationFocus("confirm");
          setConfirmationVersion((version) => version + 1);
        } else {
          queueMicrotask(() => {
            if (attempt.action === "remove") trigger.current?.focus();
            else tokenAction.current?.focus();
          });
        }
      }
      return;
    }
    if (
      attempt.phase === "requested" &&
      sameFeedback(feedback, attempt.feedbackBefore) &&
      state.status !== "error"
    ) {
      return;
    }

    if (applied(attempt, state)) {
      persistAttempt(port, null);
      setAttempt(null);
      setPanelFeedback(null);
      if (attempt.action === "remove") {
        focusHeadingAfterOpen.current = true;
        setPanel("token");
      } else {
        setPanel("closed");
        queueMicrotask(() => trigger.current?.focus());
      }
    } else {
      const settledFeedback = feedback ?? fallbackFeedback(attempt.action);
      const settledAttempt = persistAttempt(port, {
        ...attempt,
        feedback: settledFeedback,
        phase: "settled",
      });
      setAttempt(settledAttempt);
      setPanelFeedback(settledFeedback);
    }
  }, [attempt, currentIdentity.kind, feedback, panel, port, state]);

  const begin = (action: TelegramAction): void => {
    if (port === null || busy || credentialMutationBlocked || activeAttempt || mutationUnsafe) {
      return;
    }
    setPanelFeedback(null);
    const nextAttempt = persistAttempt(port, {
      action,
      feedbackBefore: feedback,
      feedback: null,
      panelDismissed: false,
      phase: "requested",
      verifiedUsernameBefore: configured ? username : null,
    });
    setAttempt(nextAttempt);
    if (action === "paste-token") port.pasteToken();
    else port.remove();
  };

  const clearAttempt = (): void => {
    persistAttempt(port, null);
    setAttempt(null);
  };

  const dismissTokenPanel = (): void => {
    if (attempt?.phase === "settled" && attempt.feedback?.tone === "warning") {
      const dismissedAttempt = persistAttempt(port, { ...attempt, panelDismissed: true });
      setAttempt(dismissedAttempt);
    } else {
      clearAttempt();
    }
  };

  const checkAgain = (): void => {
    if (port === null || busy) return;
    port.retry();
  };

  const openTokenPanel = (): void => {
    setPanelFeedback(null);
    if (panel === "token") {
      dismissTokenPanel();
      setPanel("closed");
      return;
    }
    if (attempt?.phase === "settled") {
      const reopenedAttempt = persistAttempt(port, { ...attempt, panelDismissed: false });
      setAttempt(reopenedAttempt);
      setPanelFeedback(reopenedAttempt?.feedback ?? null);
    }
    focusHeadingAfterOpen.current = true;
    setPanel("token");
  };

  const closeTokenPanel = (): void => {
    dismissTokenPanel();
    setPanel("closed");
    setPanelFeedback(null);
    queueMicrotask(() => trigger.current?.focus());
  };

  const openDeletePanel = (): void => {
    if (attempt?.action === "remove" && attempt.phase === "settled") {
      const reopenedAttempt = persistAttempt(port, { ...attempt, panelDismissed: false });
      setAttempt(reopenedAttempt);
      setPanelFeedback(reopenedAttempt?.feedback ?? null);
    } else {
      clearAttempt();
      setPanelFeedback(null);
    }
    setConfirmationFocus("cancel");
    setConfirmationVersion((version) => version + 1);
    setPanel("delete");
  };

  const cancelDeletePanel = (): void => {
    if (
      attempt?.action === "remove" &&
      attempt.phase === "settled" &&
      attempt.feedback?.tone === "warning"
    ) {
      setAttempt(persistAttempt(port, { ...attempt, panelDismissed: true }));
    } else {
      clearAttempt();
    }
    setPanel("closed");
    setPanelFeedback(null);
    setConfirmationFocus(null);
    queueMicrotask(() => trigger.current?.focus());
  };

  const feedbackNode =
    panelFeedback === null ? null : (
      <p
        className={`mt-2 mb-0 text-xs ${panelFeedback.tone === "error" || panelFeedback.tone === "warning" ? "text-danger" : "text-ink-2"}`}
        role={panelFeedback.tone === "error" ? "alert" : "status"}
        aria-live={panelFeedback.tone === "error" ? undefined : "polite"}
        data-telegram-feedback={panelFeedback.tone}
      >
        {panelFeedback.message}
      </p>
    );

  return (
    <>
      <SetupRow
        id="telegram"
        status={configured ? "ready" : "pending"}
        title={TELEGRAM_ROW_TITLE}
        subtitle={
          <>
            {TELEGRAM_AVAILABILITY_COPY}
            {configured ? (
              <span className="mt-1 block text-ok" data-telegram-identity="">
                {TELEGRAM_VERIFIED_PREFIX} · @{username}
              </span>
            ) : null}
          </>
        }
        info={
          <span
            className="rounded-full bg-[color-mix(in_srgb,var(--brand)_10%,transparent)] px-[7px] py-0.5 text-xs font-semibold text-brand"
            data-telegram-optional=""
          >
            {TELEGRAM_OPTIONAL_LABEL}
          </span>
        }
        announce={panel === "token" ? "Telegram bot setup opened below this row." : ""}
        trailing={
          configured ? (
            <Button
              ref={trigger}
              type="button"
              variant="destructive"
              size="sm"
              data-setup-delete="telegram"
              disabled={
                busy ||
                credentialMutationBlocked ||
                (authoritativeCheckRequired && attempt?.action === "paste-token")
              }
              aria-expanded={panel === "delete"}
              aria-label="Delete the Telegram connection"
              onClick={openDeletePanel}
            >
              Delete
            </Button>
          ) : (
            <Button
              ref={trigger}
              type="button"
              variant="outline"
              size="sm"
              data-setup-trigger="telegram"
              disabled={busy || credentialMutationBlocked}
              aria-expanded={panel === "token"}
              aria-label="Create Telegram bot"
              {...(panel === "closed" ? {} : { "aria-controls": panelId })}
              onClick={openTokenPanel}
            >
              Create
            </Button>
          )
        }
      />
      {panel === "token" && currentIdentity.kind !== "verified" ? (
        <SetupSubPanel name="telegram" id={panelId}>
          <div
            className="flex flex-wrap items-center gap-4 sm:flex-nowrap sm:gap-6"
            role="group"
            aria-labelledby="onboarding-telegram-create-title"
          >
            <div className="min-w-0 flex-1">
              <h3
                ref={heading}
                id="onboarding-telegram-create-title"
                tabIndex={-1}
                className="m-0 text-sm font-medium text-ink focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ink"
              >
                {TELEGRAM_CREATE_TITLE}
              </h3>
              <p className="mt-1 mb-0 max-w-[525px] text-xs text-ink-2">
                Ask{" "}
                <a
                  className="font-medium underline underline-offset-[3px] hover:text-ink"
                  href="https://t.me/BotFather"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  @BotFather
                </a>{" "}
                {TELEGRAM_CREATE_COPY_AFTER_BOTFATHER}
              </p>
              {feedbackNode}
            </div>
            <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                aria-label="Cancel Telegram bot setup"
                onClick={closeTokenPanel}
              >
                Cancel
              </Button>
              {mutationUnsafe ? (
                <Button
                  ref={retryAction}
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={checkAgain}
                >
                  Check again
                </Button>
              ) : null}
              <Button
                ref={tokenAction}
                type="button"
                variant="default"
                size="sm"
                data-telegram-action="use-token"
                disabled={busy || credentialMutationBlocked || mutationUnsafe}
                onClick={() => begin("paste-token")}
              >
                {connecting ? "Connecting…" : "Use copied token"}
              </Button>
            </div>
          </div>
          <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {connecting ? "Connecting…" : ""}
          </span>
        </SetupSubPanel>
      ) : null}
      {panel === "token" &&
      currentIdentity.kind === "verified" &&
      attempt?.action === "paste-token" &&
      attempt.phase === "settled" ? (
        <SetupSubPanel name="telegram-connect-recovery">
          {feedbackNode}
          {mutationUnsafe ? (
            <Button
              ref={retryAction}
              type="button"
              variant="ghost"
              size="sm"
              className="mt-2"
              disabled={busy}
              onClick={checkAgain}
            >
              Check again
            </Button>
          ) : null}
        </SetupSubPanel>
      ) : null}
      {panel === "delete" && configured ? (
        <>
          <InlineConfirmation
            key={confirmationVersion}
            name="delete-telegram"
            title={TELEGRAM_DELETE_TITLE}
            copy={TELEGRAM_DELETE_COPY}
            confirmLabel="Delete connection"
            focusTarget={confirmationFocus}
            cancelDisabled={busy}
            confirmDisabled={busy || credentialMutationBlocked || mutationUnsafe}
            confirmBusy={removing}
            onCancel={cancelDeletePanel}
            onConfirm={() => begin("remove")}
          />
          {panelFeedback === null ? null : (
            <SetupSubPanel name="telegram-delete-recovery">
              {feedbackNode}
              {mutationUnsafe ? (
                <Button
                  ref={retryAction}
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="mt-2"
                  disabled={busy}
                  onClick={checkAgain}
                >
                  Check again
                </Button>
              ) : null}
            </SetupSubPanel>
          )}
          <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {removing ? "Deleting…" : ""}
          </span>
        </>
      ) : null}
    </>
  );
}
