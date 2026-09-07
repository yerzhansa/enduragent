import { TriangleAlert } from "lucide-react";
import type { ReactElement, RefObject } from "react";
import { Button } from "@enduragent/ui";
import type {
  AthleteSettingsFormState,
  AthleteSettingsState,
} from "../../settings/athlete-controller";
import { settingsMutationActive } from "../../state/settings-slice";
import { useEnduragentStore } from "../../state/store";
import {
  sourceRestrictionSummary,
  STRAVA_RESTRICTION_DESKTOP_COPY,
} from "../../training-context/manual-sync";
import {
  ATHLETE_SAVE_ERROR_COPY,
  ATHLETE_VALIDATION_COPY,
  MANAGED_BY_ENVIRONMENT_COPY,
} from "./copy";
import { STRAVA_RESTRICTION_CARD_ID } from "./restriction-focus";
import { settingsStyles as styles } from "./styles";

function formState(state: AthleteSettingsState): AthleteSettingsFormState | null {
  if (
    state.status === "ready" ||
    state.status === "refreshing" ||
    state.status === "saving" ||
    state.status === "saved" ||
    (state.status === "error" && state.kind === "save")
  ) {
    return state;
  }
  return null;
}

function feedbackCopy(state: AthleteSettingsState): string | null {
  if (state.status === "closed" || state.status === "loading") {
    return "Loading training account settings…";
  }
  if (state.status === "refreshing") {
    return "Reconnecting and checking the current training account…";
  }
  if (state.status === "error" && state.kind === "load") {
    return "Training account settings aren’t available. Reconnect and reload.";
  }
  if (state.status === "saving") return "Saving athlete ID…";
  if (state.status === "saved") return "Athlete ID saved.";
  if (state.status === "error" && state.kind === "save") {
    return ATHLETE_SAVE_ERROR_COPY[state.reason];
  }
  return null;
}

export function TrainingAccountSection(props: {
  readonly restrictionCard: RefObject<HTMLDivElement | null>;
}): ReactElement {
  const state = useEnduragentStore((store) => store.settings.athlete);
  const sync = useEnduragentStore((store) => store.sync);
  const mutating = useEnduragentStore((store) => settingsMutationActive(store.settings));
  const port = useEnduragentStore((store) => store.settingsPorts?.athlete ?? null);

  const editable = formState(state);
  const busy =
    mutating ||
    state.status === "refreshing" ||
    state.status === "loading" ||
    state.status === "closed";
  const externallyManaged = editable?.effective.managedByEnvironment.athleteId === true;
  const credentialMissing = editable !== null && !editable.effective.credential_configured;
  const verificationPending =
    editable !== null &&
    editable.effective.credential_configured &&
    editable.effective.credential_verification_pending === true;
  const locked = editable === null || credentialMissing || externallyManaged;
  const saving = state.status === "saving";
  const retryVisible = state.status === "error" && (state.kind === "load" || state.kind === "save");
  const credentialRequired =
    credentialMissing ||
    (state.status === "error" && state.kind === "save" && state.reason === "credential-required");
  const validation =
    editable?.validationError == null ? "" : ATHLETE_VALIDATION_COPY[editable.validationError];
  const feedback = feedbackCopy(state);
  const restriction = sourceRestrictionSummary(sync.droppedActivities, "STRAVA");
  const describedBy = [
    "athlete-id-help",
    ...(externallyManaged ? ["athlete-id-managed"] : []),
    ...(credentialMissing ? ["athlete-id-credential"] : []),
    ...(verificationPending ? ["athlete-id-verifying"] : []),
    ...(validation.length > 0 ? ["athlete-id-validation"] : []),
  ].join(" ");

  return (
    <>
      <h2 className={styles.heading}>Training account</h2>
      <section className={styles.group} aria-label="Training account">
        <p className={styles.note}>
          This may only identify the currently connected training account. It cannot switch
          accounts.
        </p>
        {editable === null ? null : (
          <div className={`${styles.row} ${styles.rowStacked}`}>
            <label className={styles.rowTitle} htmlFor="athlete-id">
              Athlete ID
            </label>
            <input
              id="athlete-id"
              type="text"
              autoComplete="off"
              spellCheck={false}
              className={`${styles.control} ${styles.controlWide}`}
              value={editable.draft}
              disabled={busy || locked}
              aria-invalid={editable.validationError === null ? undefined : "true"}
              aria-describedby={describedBy}
              onChange={(event) => {
                port?.change(event.target.value);
              }}
            />
            <p className={styles.help} id="athlete-id-help">
              Use the exact identifier associated with the credential already connected in Setup.
            </p>
            {externallyManaged ? (
              <p className={styles.help} id="athlete-id-managed">
                {MANAGED_BY_ENVIRONMENT_COPY}
              </p>
            ) : null}
            {credentialMissing ? (
              <p className={styles.help} id="athlete-id-credential">
                No training account credential is connected. Use the setup area above to connect
                one.
              </p>
            ) : null}
            {verificationPending ? (
              <p className={styles.help} id="athlete-id-verifying">
                Verifying the connected training account… Training data stays paused until it
                completes.
              </p>
            ) : null}
            <p className={styles.error} id="athlete-id-validation" aria-live="polite">
              {validation}
            </p>
          </div>
        )}
        {feedback === null ? null : (
          <p className={styles.feedback} role="status" aria-live="polite" aria-atomic="true">
            {feedback}
          </p>
        )}
        <div className={styles.actions}>
          {retryVisible ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                port?.retry();
              }}
            >
              Reconnect &amp; reload
            </Button>
          ) : null}
          {credentialRequired ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                port?.openSetup();
              }}
            >
              Review setup
            </Button>
          ) : null}
          <Button
            type="button"
            variant="default"
            size="sm"
            disabled={
              busy ||
              editable === null ||
              !editable.dirty ||
              editable.validationError !== null ||
              locked
            }
            onClick={() => {
              port?.save();
            }}
          >
            {saving ? "Saving…" : "Save athlete ID"}
          </Button>
        </div>
      </section>
      {restriction === null ? null : (
        <div
          ref={props.restrictionCard}
          id={STRAVA_RESTRICTION_CARD_ID}
          tabIndex={-1}
          className="mt-4 rounded-xl border border-line bg-surface p-4 shadow-elev-1"
        >
          <div className="flex items-start gap-2.5">
            <TriangleAlert
              size={17}
              strokeWidth={1.8}
              className="mt-px flex-none text-warn"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <p className="m-0 text-sm font-semibold text-ink">
                {STRAVA_RESTRICTION_DESKTOP_COPY.cardTitle(restriction.count, restriction.total)}
              </p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
                {STRAVA_RESTRICTION_DESKTOP_COPY.cause}
              </p>
            </div>
          </div>
          <div className="mt-3 grid gap-2.5 border-t border-line pt-3">
            <div className="flex items-start gap-2.5">
              <span className="flex size-[18px] flex-none items-center justify-center rounded-full bg-brand/15 text-[10px] font-semibold text-brand">
                1
              </span>
              <p className="m-0 text-[12.5px] leading-relaxed text-ink-2">
                <strong className="font-semibold text-ink">For future rides — </strong>
                {STRAVA_RESTRICTION_DESKTOP_COPY.future}
              </p>
            </div>
            <div className="flex items-start gap-2.5">
              <span className="flex size-[18px] flex-none items-center justify-center rounded-full bg-brand/15 text-[10px] font-semibold text-brand">
                2
              </span>
              <p className="m-0 text-[12.5px] leading-relaxed text-ink-2">
                <strong className="font-semibold text-ink">For past rides — </strong>
                {STRAVA_RESTRICTION_DESKTOP_COPY.past}
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
