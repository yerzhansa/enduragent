import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from "react";
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
import {
  IMPORT_FILES_LABEL,
  INTERVALS_PANEL_HINT,
  RETRY_SAVED_KEYS_LABEL,
  SETUP_ROW_CHECKING_SUBTITLE,
  TRAINING_CANCEL_LABEL,
  TRAINING_CONNECT_TITLE,
  TRAINING_ROW_SUBTITLES,
  TRAINING_ROW_TITLE,
  TRAINING_ROW_TOOLTIP,
  TRAINING_TRIGGER_LABELS,
  TRAINING_USE_COPIED_KEY_LABEL,
} from "./copy";
import { InfoTip } from "./InfoTip";
import {
  CredentialDeleteButton,
  CredentialDeleteConfirmation,
} from "../settings/CredentialsSection";
import { SETUP_LINK_BUTTON } from "./SetupCard";
import { SetupError, SetupRow, SetupSubPanel } from "./SetupRow";
import type { SetupPlacement } from "./OnboardingWizard";

export function TrainingRow(props: {
  readonly surface: OnboardingSurfaceState;
  readonly actions: OnboardingActions | null;
  readonly placement: SetupPlacement;
}): ReactElement {
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
  const retryable = surface.statuses.some(
    (entry) => entry.slot === "intervals-icu" && credentialPresentation(entry).retryable,
  );
  const ownsError = errorSection(wizard.fixedError, surface.lastCommit) === "training";
  const [open, setOpen] = useState(false);
  const [connectPhase, setConnectPhase] = useState<"idle" | "connecting">("idle");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusHeadingAfterOpen = useRef<"delete" | "trigger" | null>(null);
  const panelId = "onboarding-training-panel";
  const credentialFocus = "focus" in credentialSettings ? credentialSettings.focus : null;

  useEffect(() => {
    if (connectPhase === "idle" || busy || surface.lastCommit !== "training") return;
    if (connected) {
      setOpen(false);
      deleteRef.current?.focus();
    }
    setConnectPhase("idle");
  }, [busy, connected, connectPhase, surface.lastCommit]);

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

  const statusKnown = setupStatusKnown(surface);
  const subtitle = !statusKnown
    ? SETUP_ROW_CHECKING_SUBTITLE
    : connected
      ? TRAINING_ROW_SUBTITLES.connected
      : TRAINING_ROW_SUBTITLES.missing;

  const connect = (): void => {
    if (actions === null || controlsDisabled || importing) return;
    setConnectPhase("connecting");
    actions.connectTrainingData();
  };

  return (
    <>
      <SetupRow
        id="training"
        status={!statusKnown ? "none" : connected ? "ready" : "pending"}
        title={TRAINING_ROW_TITLE}
        subtitle={subtitle}
        info={
          <InfoTip
            label={TRAINING_ROW_TOOLTIP.label}
            lead={TRAINING_ROW_TOOLTIP.lead}
            body={TRAINING_ROW_TOOLTIP.body}
          />
        }
        trailing={
          !statusKnown ? null : connected ? (
            <CredentialDeleteButton credential="intervals-icu" buttonRef={deleteRef} />
          ) : (
            <Button
              ref={triggerRef}
              type="button"
              data-setup-trigger="training"
              variant="outline"
              size="sm"
              disabled={controlsDisabled}
              aria-expanded={open}
              aria-label={TRAINING_TRIGGER_LABELS.disconnected}
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
              Connect
            </Button>
          )
        }
      />
      <CredentialDeleteConfirmation credential="intervals-icu" />
      {!connected && open && !repairRequired ? (
        <SetupSubPanel name="training" id={panelId}>
          <div className="flex min-w-0 flex-wrap items-center gap-x-7 gap-y-3">
            <div className="min-w-52 flex-1">
              <h3
                ref={headingRef}
                tabIndex={-1}
                className="m-0 text-sm font-medium text-ink focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-ink"
              >
                {TRAINING_CONNECT_TITLE}
              </h3>
              <p className="mt-1 mb-0 text-xs text-ink-2">{INTERVALS_PANEL_HINT}</p>
            </div>
            <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={controlsDisabled}
                aria-label={TRAINING_CANCEL_LABEL}
                onClick={() => {
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="default"
                size="sm"
                disabled={controlsDisabled || importing}
                onClick={connect}
              >
                {connectPhase === "idle" ? TRAINING_USE_COPIED_KEY_LABEL : "Connecting…"}
              </Button>
            </div>
          </div>
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
            {IMPORT_FILES_LABEL}
          </Button>
          <SetupError surface={surface} section="training" />
        </SetupSubPanel>
      ) : null}
      {connected && (retryable || ownsError) ? (
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
              {RETRY_SAVED_KEYS_LABEL}
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
