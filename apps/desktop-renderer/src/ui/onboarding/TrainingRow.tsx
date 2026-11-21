import type { Message } from "@enduragent/i18n";
import { usePhrasebook } from "@enduragent/i18n/react";
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { Button } from "@enduragent/ui";
import {
  setupStatusKnown,
  type OnboardingActions,
  type OnboardingSurfaceState,
} from "../../onboarding/controller";
import { credentialPresentation } from "../../onboarding/credential-presentation";
import { errorSection } from "../../onboarding/lanes";
import {
  credentialChangesBlocked,
  repairRequiredCredential,
} from "../../settings/credential-controller";
import {
  nonTelegramSettingsMutationActive,
  settingsMutationActive,
} from "../../state/settings-slice";
import { useEnduragentStore } from "../../state/store";
import { intervalsSignInNeedsRenewal } from "../../state/sync-slice";
import {
  IMPORT_FILES_LABEL,
  INTERVALS_PANEL_HINT,
  RETRY_SAVED_KEYS_LABEL,
  SETUP_ROW_CHECKING_SUBTITLE,
  TRAINING_CANCEL_LABEL,
  TRAINING_CANCEL_SIGN_IN_LABEL,
  TRAINING_CONNECT_TITLE,
  TRAINING_REOPEN_SIGN_IN_LABEL,
  TRAINING_ROW_SUBTITLES,
  TRAINING_ROW_TITLE,
  TRAINING_ROW_TOOLTIP,
  TRAINING_SIGN_IN_AGAIN_LABEL,
  TRAINING_SIGN_IN_LABEL,
  TRAINING_SIGN_IN_PHASE_COPY,
  TRAINING_TRIGGER_LABELS,
  trainingConnectedAsSubtitle,
} from "./copy";
import { InfoTip } from "./InfoTip";
import {
  CredentialDeleteButton,
  CredentialDeleteConfirmation,
} from "../settings/CredentialsSection";
import { SETUP_LINK_BUTTON } from "./SetupCard";
import { SetupError, SetupRow, SetupSubPanel, type SetupRowStatus } from "./SetupRow";
import type { SetupPlacement } from "./OnboardingWizard";

type TrainingRowState = "checking" | "missing" | "connected" | "rejected";

type TrainingRowAction = "connect" | "disconnect" | "sign-in-again";

const TRAINING_ROW_STATES: Readonly<
  Record<
    TrainingRowState,
    {
      readonly disc: SetupRowStatus;
      readonly subtitle: Message;
      readonly actions: readonly TrainingRowAction[];
    }
  >
> = {
  checking: { disc: "none", subtitle: SETUP_ROW_CHECKING_SUBTITLE, actions: [] },
  missing: { disc: "pending", subtitle: TRAINING_ROW_SUBTITLES.missing, actions: ["connect"] },
  connected: {
    disc: "ready",
    subtitle: TRAINING_ROW_SUBTITLES.connected,
    actions: ["disconnect"],
  },
  rejected: {
    disc: "attention",
    subtitle: TRAINING_ROW_SUBTITLES.rejected,
    actions: ["disconnect", "sign-in-again"],
  },
};

function trainingRowState(
  statusKnown: boolean,
  connected: boolean,
  rejected: boolean,
): TrainingRowState {
  if (!statusKnown) return "checking";
  if (rejected) return "rejected";
  return connected ? "connected" : "missing";
}

function useHeldWhile<T>(value: T, holding: boolean): T {
  const [held, setHeld] = useState<{ readonly value: T } | null>(null);
  if (holding && held === null) setHeld({ value });
  if (!holding && held !== null) setHeld(null);
  return holding && held !== null ? held.value : value;
}

export function TrainingRow(props: {
  readonly surface: OnboardingSurfaceState;
  readonly actions: OnboardingActions | null;
  readonly placement: SetupPlacement;
}): ReactElement {
  const { say } = usePhrasebook();
  const { surface, actions } = props;
  const wizard = surface.wizard;
  const busy = wizard.busy;
  const credentialSettings = useEnduragentStore((state) => state.settings.credentials);
  const credentialPort = useEnduragentStore((state) => state.settingsPorts?.credentials ?? null);
  const settingsMutating = useEnduragentStore((state) =>
    props.placement === "settings"
      ? settingsMutationActive(state.settings)
      : nonTelegramSettingsMutationActive(state.settings),
  );
  const repairRequired = repairRequiredCredential(credentialSettings) !== null;
  const controlsDisabled =
    busy ||
    surface.loading ||
    surface.loadUnavailable ||
    credentialChangesBlocked(credentialSettings, settingsMutating);
  const importing = surface.rideImport.status === "running";
  const connected = wizard.credentialStatus["intervals-icu"] === "configured";
  const signInRejected = useHeldWhile(
    useEnduragentStore(intervalsSignInNeedsRenewal),
    credentialSettings.status === "deleting",
  );
  const rejected = connected && signInRejected;
  const signInPhase = surface.intervalsSignIn.phase;
  const phaseCopy = signInPhase === "idle" ? null : TRAINING_SIGN_IN_PHASE_COPY[signInPhase];
  const athleteName = surface.intervalsSignIn.athleteName;
  const retryableStatus = surface.statuses.some(
    (entry) => entry.slot === "intervals-icu" && credentialPresentation(entry).retryable,
  );
  const retryable = retryableStatus && !rejected;
  const ownsError = errorSection(wizard.fixedError, surface.lastCommit) === "training";
  const [openRequested, setOpen] = useState(false);
  const open = openRequested || signInPhase !== "idle";
  const [connectPhase, setConnectPhase] = useState<"idle" | "connecting">("idle");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusHeadingAfterOpen = useRef<"delete" | "trigger" | null>(null);
  const panelId = "onboarding-training-panel";
  const signInPanelOpen = (!connected || rejected) && open && !repairRequired;
  const credentialFocus = "focus" in credentialSettings ? credentialSettings.focus : null;

  useEffect(() => {
    if (connectPhase === "idle" || busy || surface.lastCommit !== "training") return;
    if (connected) {
      setOpen(false);
      (rejected ? triggerRef : deleteRef).current?.focus();
    }
    setConnectPhase("idle");
  }, [busy, connected, connectPhase, rejected, surface.lastCommit]);

  useEffect(() => {
    if (!repairRequired) return;
    setOpen(false);
    setConnectPhase("idle");
  }, [repairRequired]);

  useLayoutEffect(() => {
    if (connected || credentialFocus?.target !== "setup-open") return;
    focusHeadingAfterOpen.current = "delete";
    setOpen(true);
  }, [connected, credentialFocus]);

  useLayoutEffect(() => {
    const reason = focusHeadingAfterOpen.current;
    if (!open || reason === null) return;
    headingRef.current?.focus();
    if (reason === "delete") {
      if (credentialPort === null) return;
      credentialPort.setupOpened();
    }
    focusHeadingAfterOpen.current = null;
  }, [credentialPort, open]);

  const rowState = trainingRowState(setupStatusKnown(surface), connected, rejected);
  const row = TRAINING_ROW_STATES[rowState];
  const subtitle = say(
    rowState === "connected" && athleteName !== null
      ? trainingConnectedAsSubtitle(athleteName)
      : row.subtitle,
  );

  const connect = (): void => {
    if (actions === null || controlsDisabled || importing) return;
    setConnectPhase("connecting");
    actions.connectTrainingData();
  };

  const actionButton = (action: TrainingRowAction): ReactElement => {
    switch (action) {
      case "disconnect":
        return <CredentialDeleteButton credential="intervals-icu" buttonRef={deleteRef} />;
      case "sign-in-again":
        return (
          <Button
            ref={triggerRef}
            type="button"
            data-setup-trigger="training"
            variant="default"
            size="sm"
            disabled={controlsDisabled || importing}
            {...(open ? { "aria-controls": panelId } : {})}
            onClick={connect}
          >
            {say(TRAINING_SIGN_IN_AGAIN_LABEL)}
          </Button>
        );
      case "connect":
        return (
          <Button
            ref={triggerRef}
            type="button"
            data-setup-trigger="training"
            variant="outline"
            size="sm"
            disabled={controlsDisabled}
            aria-expanded={open}
            aria-label={say(TRAINING_TRIGGER_LABELS.disconnected)}
            {...(open ? { "aria-controls": panelId } : {})}
            onClick={() => {
              if (open) {
                setOpen(false);
                return;
              }
              focusHeadingAfterOpen.current = "trigger";
              setOpen(true);
            }}
          >
            {say("setup.training.connect")}
          </Button>
        );
    }
  };
  const rowActions = row.actions.map((action) => (
    <Fragment key={action}>{actionButton(action)}</Fragment>
  ));

  return (
    <>
      <SetupRow
        id="training"
        status={row.disc}
        title={TRAINING_ROW_TITLE}
        subtitle={subtitle}
        info={
          <InfoTip
            label={say(TRAINING_ROW_TOOLTIP.label)}
            lead={TRAINING_ROW_TOOLTIP.lead}
            body={say(TRAINING_ROW_TOOLTIP.body)}
          />
        }
        trailing={
          rowActions.length > 1 ? (
            <div className="flex flex-wrap items-center justify-end gap-2">{rowActions}</div>
          ) : (
            rowActions
          )
        }
      />
      <CredentialDeleteConfirmation credential="intervals-icu" />
      {signInPanelOpen ? (
        <SetupSubPanel name="training" id={panelId}>
          <div className="flex min-w-0 flex-wrap items-center gap-x-7 gap-y-3">
            <div className="min-w-52 flex-1">
              <h3
                ref={headingRef}
                tabIndex={-1}
                className="m-0 text-sm font-medium text-ink focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ink"
              >
                {say(TRAINING_CONNECT_TITLE)}
              </h3>
              <p className="mt-1 mb-0 text-xs text-ink-2">
                {say(phaseCopy === null ? INTERVALS_PANEL_HINT : phaseCopy.hint)}
              </p>
            </div>
            <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
              {signInPhase === "idle" ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={controlsDisabled}
                  aria-label={say(TRAINING_CANCEL_LABEL)}
                  onClick={() => {
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                >
                  {say("common.cancel")}
                </Button>
              ) : null}
              {signInPhase === "waiting-for-browser" ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={actions === null}
                  onClick={() => actions?.cancelIntervalsSignIn()}
                >
                  {say(TRAINING_CANCEL_SIGN_IN_LABEL)}
                </Button>
              ) : null}
              <Button
                type="button"
                variant="default"
                size="sm"
                disabled={controlsDisabled || importing}
                onClick={connect}
              >
                {say(phaseCopy === null ? TRAINING_SIGN_IN_LABEL : phaseCopy.status)}
              </Button>
            </div>
          </div>
          {signInPhase === "idle" ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              className={SETUP_LINK_BUTTON}
              disabled={controlsDisabled || importing}
              onClick={() => {
                actions?.chooseImportFiles();
              }}
            >
              {say(IMPORT_FILES_LABEL)}
            </Button>
          ) : null}
          {signInPhase === "waiting-for-browser" ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              className={SETUP_LINK_BUTTON}
              disabled={actions === null}
              onClick={() => actions?.reopenIntervalsSignIn()}
            >
              {say(TRAINING_REOPEN_SIGN_IN_LABEL)}
            </Button>
          ) : null}
          <SetupError surface={surface} section="training" />
        </SetupSubPanel>
      ) : null}
      {connected && !signInPanelOpen && (retryable || ownsError) ? (
        <SetupSubPanel name="training-recovery">
          {retryable ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              className={SETUP_LINK_BUTTON}
              disabled={controlsDisabled || importing}
              onClick={() => {
                if (actions === null) return;
                setConnectPhase("connecting");
                actions.retrySavedKeys();
              }}
            >
              {say(RETRY_SAVED_KEYS_LABEL)}
            </Button>
          ) : null}
          <SetupError surface={surface} section="training" />
        </SetupSubPanel>
      ) : null}
      {!connected && !open && ownsError ? (
        <SetupSubPanel name="training-error">
          <SetupError surface={surface} section="training" />
        </SetupSubPanel>
      ) : null}
    </>
  );
}
