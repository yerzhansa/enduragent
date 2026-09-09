import type { Phrasebook } from "@enduragent/i18n/messages";
import { usePhrasebook } from "@enduragent/i18n/react";
import { TriangleAlert } from "lucide-react";
import type { ReactElement, RefObject } from "react";
import { Button } from "@enduragent/ui";
import type {
  AthleteSettingsFormState,
  AthleteSettingsState,
} from "../../settings/athlete-controller";
import { settingsMutationActive } from "../../state/settings-slice";
import { useEnduragentStore } from "../../state/store";
import { sourceRestrictionSummary } from "../../training-context/manual-sync";
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

function feedbackCopy(state: AthleteSettingsState, say: Phrasebook["say"]): string | null {
  if (state.status === "closed" || state.status === "loading") {
    return say("settings.athlete.loading");
  }
  if (state.status === "refreshing") {
    return say("settings.athlete.refreshing");
  }
  if (state.status === "error" && state.kind === "load") {
    return say("settings.athlete.unavailable");
  }
  if (state.status === "saving") return say("settings.athlete.saving");
  if (state.status === "saved") return say("settings.athlete.saved");
  if (state.status === "error" && state.kind === "save") {
    return say(ATHLETE_SAVE_ERROR_COPY[state.reason]);
  }
  return null;
}

export function TrainingAccountSection(props: {
  readonly restrictionCard: RefObject<HTMLDivElement | null>;
}): ReactElement {
  const { say, format } = usePhrasebook();
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
    editable?.validationError == null ? "" : say(ATHLETE_VALIDATION_COPY[editable.validationError]);
  const feedback = feedbackCopy(state, say);
  const restriction = sourceRestrictionSummary(sync.droppedActivities, "STRAVA");
  const restrictionVars =
    restriction === null
      ? undefined
      : {
          strava: "Strava",
          count: restriction.total,
          restricted: format.number(restriction.count, { useGrouping: false }),
          total: format.number(restriction.total, { useGrouping: false }),
        };
  const describedBy = [
    "athlete-id-help",
    ...(externallyManaged ? ["athlete-id-managed"] : []),
    ...(credentialMissing ? ["athlete-id-credential"] : []),
    ...(verificationPending ? ["athlete-id-verifying"] : []),
    ...(validation.length > 0 ? ["athlete-id-validation"] : []),
  ].join(" ");

  return (
    <>
      <h2 className={styles.heading}>{say("settings.athlete.title")}</h2>
      <section className={styles.group} aria-label={say("settings.athlete.title")}>
        <p className={styles.note}>{say("settings.athlete.detail")}</p>
        {editable === null ? null : (
          <div className={`${styles.row} ${styles.rowStacked}`}>
            <label className={styles.rowTitle} htmlFor="athlete-id">
              {say("settings.athlete.id")}
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
              {say("settings.athlete.help")}
            </p>
            {externallyManaged ? (
              <p className={styles.help} id="athlete-id-managed">
                {say(MANAGED_BY_ENVIRONMENT_COPY)}
              </p>
            ) : null}
            {credentialMissing ? (
              <p className={styles.help} id="athlete-id-credential">
                {say("settings.athlete.credentialMissing")}
              </p>
            ) : null}
            {verificationPending ? (
              <p className={styles.help} id="athlete-id-verifying">
                {say("settings.athlete.verificationPending")}
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
              {say("settings.athlete.reload")}
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
              {say("settings.athlete.reviewSetup")}
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
            {saving ? say("settings.saving") : say("settings.athlete.save")}
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
                {say("settings.athlete.restriction.title", {
                  ...restrictionVars,
                  count: restriction.count === 1 && restriction.total === 1 ? 1 : restriction.total,
                })}
              </p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
                {say("settings.athlete.restriction.cause", {
                  intervalsLower: "intervals.icu",
                  product: "Enduragent",
                  strava: "Strava",
                })}
              </p>
            </div>
          </div>
          <div className="mt-3 grid gap-2.5 border-t border-line pt-3">
            <div className="flex items-start gap-2.5">
              <span className="flex size-[18px] flex-none items-center justify-center rounded-full bg-brand/15 text-[10px] font-semibold text-brand">
                {format.number(1)}
              </span>
              <p className="m-0 text-[12.5px] leading-relaxed text-ink-2">
                <strong className="font-semibold text-ink">
                  {say("settings.athlete.futurePrefix")}
                </strong>
                {say("settings.athlete.restriction.future", {
                  intervalsLower: "intervals.icu",
                  strava: "Strava",
                })}
              </p>
            </div>
            <div className="flex items-start gap-2.5">
              <span className="flex size-[18px] flex-none items-center justify-center rounded-full bg-brand/15 text-[10px] font-semibold text-brand">
                {format.number(2)}
              </span>
              <p className="m-0 text-[12.5px] leading-relaxed text-ink-2">
                <strong className="font-semibold text-ink">
                  {say("settings.athlete.pastPrefix")}
                </strong>
                {say("settings.athlete.restriction.past", {
                  intervalsLower: "intervals.icu",
                  strava: "Strava",
                })}
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
